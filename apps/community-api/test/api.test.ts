// SPDX-License-Identifier: AGPL-3.0-or-later
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '@thefold/twenty-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertPersonRead } from '../src/db/readModels.js';
import { withTenant } from '../src/db/tenant.js';
import { buildApi, type ApiDeps } from '../src/http/app.js';
import { silentLogger } from '../src/log.js';
import { storeTenantSecret } from '../src/tenants/secrets.js';
import { createTestDatabase, dbAvailable, seedTenant, type TestDb } from './helpers/db.js';

const NOW = new Date('2026-09-27T15:00:00Z');
const KEK = Buffer.alloc(32, 9);
const BASE = 'thefold.test';
const WEBHOOK_SECRET = 'webhook-aaaaaaaaaaaaaaaa';
const RECORD = '00000000-0000-4000-8000-0000000000b1';

const card = (over: Record<string, unknown> = {}) => ({
  firstName: 'Sam',
  lastName: 'Rivera',
  email: 'sam@example.com',
  contactConsent: { byEmail: true, byPhone: false, byText: false },
  ...over,
});

describe.skipIf(!dbAvailable)('community API over HTTP', () => {
  let db: TestDb;
  let n = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A fresh church (and API, so rate limits never leak between tests). */
  async function church(over: Partial<ApiDeps> = {}, status = 'ACTIVE') {
    const slug = `church-${++n}`;
    const t = await seedTenant(db, slug, { status });
    let ip = '203.0.113.7';
    const app = buildApi({
      pool: db.appPool,
      kek: KEK,
      log: silentLogger,
      tenancy: { baseDomain: BASE, defaultSubdomain: null },
      trustProxy: false,
      turnstileSecret: null,
      cardRateLimit: 5,
      now: () => NOW,
      remoteAddress: () => ip,
      ...over,
    });
    const post = (body: unknown, host = `${slug}.${BASE}`) =>
      app.request('/v1/connection-card', {
        method: 'POST',
        headers: { host, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const outbox = () =>
      withTenant(db.appPool, t.id, (c) =>
        c.query<{ kind: string; payload: { existingPersonId: string | null } }>(
          `SELECT kind, payload FROM outbox ORDER BY created_at`,
        ),
      ).then((r) => r.rows);
    return { t, slug, app, post, outbox, setIp: (v: string) => (ip = v) };
  }

  describe('health', () => {
    it('/healthz and /readyz', async () => {
      const { app } = await church();
      expect((await app.request('/healthz')).status).toBe(200);
      expect(await (await app.request('/readyz')).json()).toEqual({ ok: true });
    });
  });

  describe('POST /v1/connection-card', () => {
    it('queues one job and answers 202; the same card twice is still one job', async () => {
      const c = await church();
      const first = await c.post(card());
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ received: true });
      expect((await c.post(card())).status).toBe(202);
      expect((await c.outbox()).map((r) => r.kind)).toEqual(['twenty.upsertGuest']);
    });

    it('answers a known person exactly as a stranger: no way to check who belongs to a church', async () => {
      const c = await church();
      await withTenant(db.appPool, c.t.id, (client) =>
        upsertPersonRead(client, {
          twentyPersonId: RECORD,
          twentyUpdatedAt: new Date('2026-09-01T00:00:00Z'),
          firstName: 'Sam',
          lastName: 'Rivera',
          emails: ['sam@example.com'],
          phones: [],
          isMinor: false,
          sharedEmail: false,
          householdId: null,
          lifecycleStage: 'CONNECTED',
          doNotContact: false,
          awayUntil: null,
          deletedAt: null,
        }),
      );
      const known = await c.post(card());
      const stranger = await c.post(card({ firstName: 'Ana', email: 'ana@example.com' }));
      expect(known.status).toBe(stranger.status);
      expect(await known.json()).toEqual(await stranger.json());
      // Internally the match was made: the worker will attach, not create.
      expect((await c.outbox())[0]?.payload.existingPersonId).toBe(RECORD);
    });

    it('rejects an invalid card with the fields to fix, and never echoes what was typed', async () => {
      const c = await church();
      const res = await c.post({ firstName: 'Zelda-Unique', contactConsent: {} });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { fields: { path: string }[] };
      expect(body.fields.map((f) => f.path)).toEqual(expect.arrayContaining(['lastName']));
      expect(JSON.stringify(body)).not.toContain('Zelda-Unique');
      expect((await c.post('{not json')).status).toBe(400);
      expect(await c.outbox()).toEqual([]);
    });

    it('treats a filled honeypot like a real card, and stores nothing', async () => {
      const c = await church();
      const res = await c.post(card({ website: 'https://spam.example' }));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ received: true });
      expect(await c.outbox()).toEqual([]);
    });

    it('404s for a church that does not exist or is not active', async () => {
      const c = await church();
      expect((await c.post(card(), `nobody.${BASE}`)).status).toBe(404);
      expect((await c.post(card(), BASE)).status).toBe(404);
      const suspended = await church({}, 'SUSPENDED');
      expect((await suspended.post(card())).status).toBe(404);
    });

    it('limits cards per device, per church', async () => {
      const c = await church({ cardRateLimit: 2 });
      expect((await c.post(card())).status).toBe(202);
      expect((await c.post(card({ firstName: 'B' }))).status).toBe(202);
      const limited = await c.post(card({ firstName: 'C' }));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      c.setIp('198.51.100.4');
      expect((await c.post(card({ firstName: 'D' }))).status).toBe(202);
    });

    it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
      const c = await church({ cardRateLimit: 1 });
      const viaHeader = (ip: string) =>
        c.app.request('/v1/connection-card', {
          method: 'POST',
          headers: {
            host: `${c.slug}.${BASE}`,
            'content-type': 'application/json',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify(card({ firstName: ip })),
        });
      expect((await viaHeader('1.1.1.1')).status).toBe(202);
      // Same socket address: a spoofed header does not buy a fresh window.
      expect((await viaHeader('2.2.2.2')).status).toBe(429);
    });

    describe('captcha (Turnstile)', () => {
      const fetchSaying =
        (success: boolean | 'down'): typeof fetch =>
        () =>
          success === 'down'
            ? Promise.reject(new Error('network down'))
            : Promise.resolve(new Response(JSON.stringify({ success })));

      it('requires a token, refuses a failed one, and lets guests through when Cloudflare is down', async () => {
        const passing = await church({ turnstileSecret: 'ts', fetch: fetchSaying(true) });
        expect((await passing.post(card())).status).toBe(400);
        expect((await passing.post(card({ captchaToken: 'ok' }))).status).toBe(202);

        const failing = await church({ turnstileSecret: 'ts', fetch: fetchSaying(false) });
        expect((await failing.post(card({ captchaToken: 'bad' }))).status).toBe(400);
        expect(await failing.outbox()).toEqual([]);

        const down = await church({ turnstileSecret: 'ts', fetch: fetchSaying('down') });
        expect((await down.post(card({ captchaToken: 'x' }))).status).toBe(202);
      });
    });
  });

  describe('POST /v1/webhooks/twenty/:subdomain', () => {
    async function withSecret() {
      const c = await church();
      await withTenant(db.appPool, c.t.id, (client) =>
        storeTenantSecret(client, KEK, 'twenty_webhook_secret', WEBHOOK_SECRET),
      );
      const deliver = (body: unknown, opts: { secret?: string; ts?: number } = {}) => {
        const raw = JSON.stringify(body);
        const ts = String(Math.floor((opts.ts ?? NOW.getTime()) / 1000));
        return c.app.request(`/v1/webhooks/twenty/${c.slug}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TIMESTAMP_HEADER]: ts,
            [SIGNATURE_HEADER]: signWebhook(opts.secret ?? WEBHOOK_SECRET, ts, raw),
          },
          body: raw,
        });
      };
      const inbox = () =>
        withTenant(db.appPool, c.t.id, (client) =>
          client.query<{ object_type: string; record_id: string; hits: number }>(
            `SELECT object_type, record_id, hits FROM webhook_inbox`,
          ),
        ).then((r) => r.rows);
      return { ...c, deliver, inbox };
    }
    const event = { eventName: 'person.updated', record: { id: RECORD }, eventId: 'evt-1' };

    it('queues a refetch for a correctly signed delivery, and drops an exact redelivery', async () => {
      const c = await withSecret();
      const first = await c.deliver(event);
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ outcome: 'QUEUED' });
      expect(await (await c.deliver(event)).json()).toEqual({ outcome: 'DUPLICATE' });
      expect(await (await c.deliver({ ...event, eventId: 'evt-2' })).json()).toEqual({
        outcome: 'COALESCED',
      });
      expect(await c.inbox()).toEqual([{ object_type: 'person', record_id: RECORD, hits: 2 }]);
    });

    it('401s a wrong signature or a stale timestamp, and stores nothing', async () => {
      const c = await withSecret();
      expect((await c.deliver(event, { secret: 'someone-else-zzzzzzzzzz' })).status).toBe(401);
      expect((await c.deliver(event, { ts: NOW.getTime() - 3_600_000 })).status).toBe(401);
      const unsigned = await c.app.request(`/v1/webhooks/twenty/${c.slug}`, {
        method: 'POST',
        body: JSON.stringify(event),
      });
      expect(unsigned.status).toBe(401);
      expect(await c.inbox()).toEqual([]);
    });

    it('acknowledges a delivery it cannot read, without queueing anything', async () => {
      const c = await withSecret();
      const res = await c.deliver({ something: 'else' });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ outcome: 'IGNORED' });
      expect(await c.inbox()).toEqual([]);
    });

    it('404s a church without a webhook secret, or an unknown church', async () => {
      const c = await church();
      const res = await c.app.request(`/v1/webhooks/twenty/${c.slug}`, {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(404);
      expect(
        (await c.app.request('/v1/webhooks/twenty/no-such-church', { method: 'POST', body: '{}' }))
          .status,
      ).toBe(404);
    });
  });

  it('unknown routes are a JSON 404', async () => {
    const { app } = await church();
    const res = await app.request('/v1/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
