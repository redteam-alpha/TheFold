// SPDX-License-Identifier: AGPL-3.0-or-later
import { TIMESTAMP_HEADER, SIGNATURE_HEADER, verifyWebhook } from '@thefold/twenty-client';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { tenantIdForSubdomain, withTenant } from '../db/tenant.js';
import { recordWebhookHint } from '../db/webhookInbox.js';
import { submitConnectionCard } from '../intake/connectionCard.js';
import { errorFields, type Logger } from '../log.js';
import { readTenantSecret } from '../tenants/secrets.js';
import { mountPortal, type PortalOptions } from './portal.js';
import { WindowLimiter } from './rateLimit.js';
import { subdomainFromHost } from './tenantResolution.js';
import { verifyTurnstile } from './turnstile.js';
import { hintFromTwentyWebhook } from './webhookPayload.js';

export interface ApiDeps {
  pool: Pool;
  kek: Buffer;
  log: Logger;
  tenancy: { baseDomain: string | null; defaultSubdomain: string | null };
  trustProxy: boolean;
  turnstileSecret: string | null;
  cardRateLimit: number;
  now?: () => Date;
  /** Used only for the Turnstile check. */
  fetch?: typeof fetch;
  /** The peer address. Defaults to the Node socket's; tests pass their own. */
  remoteAddress?: (c: Context) => string | null;
  /** Member sign-in (ADR 0007). Null or absent: email is not configured, and sign-in says so. */
  portal?: PortalOptions | null;
}

const TEN_MINUTES = 10 * 60_000;

const nodeRemoteAddress = (c: Context): string | null =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
    ?.remoteAddress ?? null;

/**
 * The community service's HTTP surface. Small on purpose: public endpoints take a request, check it, and
 * queue work; everything slow or failure-prone happens in the worker (src/workers), so a guest is never
 * told "something went wrong" because Twenty was slow.
 */
export function buildApi(deps: ApiDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const cardLimiter = new WindowLimiter(deps.cardRateLimit, TEN_MINUTES, () => now().getTime());
  const app = new Hono();

  app.use('*', secureHeaders());

  app.onError((error, c) => {
    deps.log.error('http.unhandled', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  const clientIp = (c: Context): string | null => {
    if (deps.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    return (deps.remoteAddress ?? nodeRemoteAddress)(c);
  };

  const tenantOf = async (subdomain: string | null): Promise<string | null> =>
    subdomain ? tenantIdForSubdomain(deps.pool, subdomain) : null;
  const hostOf = (c: Context): string | undefined =>
    (deps.trustProxy && c.req.header('x-forwarded-host')) || c.req.header('host');
  /** The church a request is for, from its Host (`grace.thefold.app`), or the single-church default. */
  const tenantOfRequest = (c: Context) =>
    tenantOf(subdomainFromHost(hostOf(c), deps.tenancy.baseDomain, deps.tenancy.defaultSubdomain));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await deps.pool.query('SELECT 1');
      return c.json({ ok: true });
    } catch (error) {
      deps.log.warn('http.not_ready', errorFields(error));
      return c.json({ ok: false }, 503);
    }
  });

  /**
   * The public "I'm new here" card. The answer is the same whether the person was new, already known, or a
   * repeat of today's card: telling a stranger "we already know this email" would let anyone check who
   * belongs to a church.
   */
  app.post('/v1/connection-card', bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    const tenantId = await tenantOfRequest(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);

    const ip = clientIp(c);
    const limit = cardLimiter.take(`${tenantId}|${ip ?? 'unknown'}`);
    if (!limit.ok) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      return c.json({ error: 'too many cards from this device; please try again shortly' }, 429);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'expected a JSON body' }, 400);
    }
    const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

    // Honeypot: a person never fills the hidden field. Answer exactly as for a real card, store nothing.
    if (typeof fields['website'] === 'string' && fields['website'] !== '') {
      deps.log.info('card.honeypot', { tenantId });
      return c.json({ received: true }, 202);
    }

    if (deps.turnstileSecret) {
      const token = fields['captchaToken'];
      if (typeof token !== 'string' || token === '')
        return c.json({ error: 'please complete the check that you are not a robot' }, 400);
      const verdict = await verifyTurnstile({
        secret: deps.turnstileSecret,
        token,
        remoteIp: ip,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      if (verdict === 'FAILED')
        return c.json({ error: 'please complete the check that you are not a robot' }, 400);
      if (verdict === 'UNAVAILABLE') deps.log.warn('card.captcha_unavailable', { tenantId });
    }

    try {
      const outcome = await withTenant(deps.pool, tenantId, (client) =>
        submitConnectionCard(client, fields as Parameters<typeof submitConnectionCard>[1], now()),
      );
      deps.log.info('card.received', { tenantId, status: outcome.status, match: outcome.match });
      return c.json({ received: true }, 202);
    } catch (error) {
      if (error instanceof ZodError)
        return c.json(
          {
            error: 'please check the form',
            fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          400,
        );
      throw error;
    }
  });

  /**
   * Twenty's webhooks, one URL per church. The signature is checked against the RAW body before anything is
   * parsed; the payload is only a hint, the worker refetches the record.
   */
  app.post('/v1/webhooks/twenty/:subdomain', bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const tenantId = await tenantOf(c.req.param('subdomain').toLowerCase());
    if (!tenantId) return c.json({ error: 'not found' }, 404);
    const secret = await withTenant(deps.pool, tenantId, (client) =>
      readTenantSecret(client, deps.kek, 'twenty_webhook_secret'),
    );
    if (!secret) return c.json({ error: 'not found' }, 404);

    const rawBody = await c.req.text();
    const verdict = verifyWebhook({
      secret,
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
      rawBody,
      now: now().getTime(),
    });
    if (!verdict.ok) {
      deps.log.warn('webhook.rejected', { tenantId, reason: verdict.reason });
      return c.json({ error: 'invalid signature' }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'expected a JSON body' }, 400);
    }
    const hint = hintFromTwentyWebhook({ body, rawBody, tenantId, receivedAt: now().getTime() });
    if (!hint) {
      deps.log.info('webhook.ignored', { tenantId });
      return c.json({ outcome: 'IGNORED' }, 202);
    }
    const outcome = await withTenant(deps.pool, tenantId, (client) =>
      recordWebhookHint(client, hint),
    );
    deps.log.debug('webhook.hint', { tenantId, objectType: hint.objectType, outcome });
    return c.json({ outcome }, 202);
  });

  mountPortal(app, {
    pool: deps.pool,
    log: deps.log,
    now,
    options: deps.portal ?? null,
    hostOf,
    tenantOf: tenantOfRequest,
    clientIp,
  });

  return app;
}
