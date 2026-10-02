// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { Logger } from '../log.js';
import {
  SESSION_TTL_MS,
  memberForSession,
  redeemSignInLink,
  requestSignIn,
  revokeSession,
  type Member,
} from '../portal/signIn.js';
import { WindowLimiter } from './rateLimit.js';

export interface PortalOptions {
  /** HTTPS in front of the service: cookies get `Secure` and the `__Host-` prefix. Off only for plain-http development. */
  secureCookies: boolean;
  /** Sign-in requests accepted per client IP per 10 minutes. */
  signInRateLimit: number;
}

interface PortalDeps {
  pool: Pool;
  log: Logger;
  now: () => Date;
  /** Null: email is not configured, so sign-in is switched off (the pages say so). */
  options: PortalOptions | null;
  hostOf: (c: Context) => string | undefined;
  tenantOf: (c: Context) => Promise<string | null>;
  clientIp: (c: Context) => string | null;
}

const TEN_MINUTES = 10 * 60_000;
const SMALL_BODY = bodyLimit({ maxSize: 8 * 1024 });

/**
 * Member sign-in over HTTP (ADR 0007): JSON endpoints for the portal app, and a few plain server-rendered
 * pages so the flow works in a browser before the portal exists.
 *
 * Cookie-authenticated requests are protected twice against other sites: the session cookie is SameSite=Lax
 * (a cross-site form post does not carry it), and every state-changing request with an `Origin` header must
 * come from this host. The emailed link only shows a button: email scanners that open links do not use them up.
 */
export function mountPortal(app: Hono, d: PortalDeps): void {
  const limiter = new WindowLimiter(d.options?.signInRateLimit ?? 1, TEN_MINUTES, () =>
    d.now().getTime(),
  );
  const cookieName = d.options?.secureCookies ? '__Host-fold_session' : 'fold_session';

  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin');
    if (!origin) return true; // not a browser form or fetch (curl, the tests): nothing to forge
    try {
      return new URL(origin).host === d.hostOf(c);
    } catch {
      return false;
    }
  };

  const churchName = (tenantId: string) =>
    withTenant(d.pool, tenantId, async (c) => {
      const r = await c.query<{ name: string }>(
        `SELECT name FROM tenant WHERE id = fold_current_tenant()`,
      );
      return r.rows[0]?.name ?? 'Your church';
    });

  const member = async (c: Context, tenantId: string): Promise<Member | null> => {
    const token = getCookie(c, cookieName);
    return token
      ? withTenant(d.pool, tenantId, (client) => memberForSession(client, token, d.now()))
      : null;
  };

  const startSession = (c: Context, token: string) =>
    setCookie(c, cookieName, token, {
      httpOnly: true,
      secure: d.options?.secureCookies ?? true,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  const endSession = async (c: Context, tenantId: string) => {
    const token = getCookie(c, cookieName);
    if (token)
      await withTenant(d.pool, tenantId, (client) => revokeSession(client, token, d.now()));
    deleteCookie(c, cookieName, { path: '/', secure: d.options?.secureCookies ?? true });
  };

  type Ask = { ok: true } | { ok: false; status: 400 | 429; message: string; retryAfter?: number };
  const ask = async (c: Context, tenantId: string, email: unknown): Promise<Ask> => {
    const ip = d.clientIp(c);
    const limit = limiter.take(`${tenantId}|${ip ?? 'unknown'}`);
    if (!limit.ok)
      return {
        ok: false,
        status: 429,
        message: 'Too many sign-in requests from this device. Please wait a few minutes.',
        retryAfter: limit.retryAfterSeconds,
      };
    const r = await withTenant(d.pool, tenantId, (client) =>
      requestSignIn(client, { email: typeof email === 'string' ? email : '', ip, now: d.now() }),
    );
    if (!r.ok) return { ok: false, status: 400, message: 'Please enter a valid email address.' };
    d.log.info('signin.requested', { tenantId });
    return { ok: true };
  };

  const redeem = async (tenantId: string, token: unknown) => {
    const r = await withTenant(d.pool, tenantId, (client) =>
      redeemSignInLink(client, { token: typeof token === 'string' ? token : '', now: d.now() }),
    );
    d.log.info(r.ok ? 'signin.redeemed' : 'signin.refused', {
      tenantId,
      ...(r.ok ? {} : { reason: r.reason }),
    });
    return r;
  };

  const SENT =
    'If this church has that address on file, a sign-in link is on its way. It works once, within 15 minutes.';
  const BAD_LINK = 'This link has expired or has already been used. Please ask for a new one.';
  const DISABLED = 'This account cannot sign in. Please ask someone at your church.';
  const OFF = 'Sign-in is not set up for this church yet.';

  // ---- JSON, for the portal app ------------------------------------------------------------------------

  app.post('/v1/auth/sign-in', SMALL_BODY, async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    if (!d.options) return c.json({ error: OFF }, 503);
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    const r = await ask(c, tenantId, body?.email);
    if (!r.ok) {
      if (r.retryAfter) c.header('Retry-After', String(r.retryAfter));
      return c.json({ error: r.message }, r.status);
    }
    return c.json({ sent: true, message: SENT }, 202);
  });

  app.post('/v1/auth/verify', SMALL_BODY, async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const r = await redeem(tenantId, body?.token);
    if (!r.ok)
      return c.json(
        { error: r.reason === 'DISABLED' ? DISABLED : BAD_LINK },
        r.reason === 'DISABLED' ? 403 : 400,
      );
    startSession(c, r.sessionToken);
    return c.json({ signedIn: true });
  });

  app.get('/v1/me', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    c.header('Cache-Control', 'no-store');
    const m = await member(c, tenantId);
    if (!m) return c.json({ error: 'not signed in' }, 401);
    return c.json({
      email: m.email,
      link: m.link,
      person: m.person ? { firstName: m.person.firstName, lastName: m.person.lastName } : null,
    });
  });

  app.post('/v1/auth/sign-out', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    if (!sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    await endSession(c, tenantId);
    return c.body(null, 204);
  });

  // ---- Plain pages, until the portal app exists ---------------------------------------------------------

  const page = (
    c: Context,
    church: string,
    title: string,
    body: Body,
    status: 200 | 400 | 403 | 429 | 503 = 200,
  ) => {
    c.header('Cache-Control', 'no-store');
    return c.html(layout(church, title, body), status);
  };

  const signInForm = (message: string | null) =>
    html` <h1>Sign in</h1>
      ${message ? html`<p role="alert" class="note">${message}</p>` : ''}
      <form method="post" action="/sign-in">
        <label for="email">Your email address</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <button type="submit">Email me a sign-in link</button>
      </form>
      <p class="small">No password: we email you a link that signs you in.</p>`;

  app.get('/sign-in', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    const church = await churchName(tenantId);
    if (!d.options)
      return page(
        c,
        church,
        'Sign in',
        html`<h1>Sign in</h1>
          <p>${OFF}</p>`,
        503,
      );
    return page(c, church, 'Sign in', signInForm(null));
  });

  app.post('/sign-in', SMALL_BODY, async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    const church = await churchName(tenantId);
    if (!d.options)
      return page(
        c,
        church,
        'Sign in',
        html`<h1>Sign in</h1>
          <p>${OFF}</p>`,
        503,
      );
    if (!sameOrigin(c))
      return page(
        c,
        church,
        'Sign in',
        html`<h1>Sign in</h1>
          <p>Please try again from this page.</p>`,
        403,
      );
    const form = await c.req.parseBody();
    const r = await ask(c, tenantId, form['email']);
    if (!r.ok) {
      if (r.retryAfter) c.header('Retry-After', String(r.retryAfter));
      return page(c, church, 'Sign in', signInForm(r.message), r.status);
    }
    return page(
      c,
      church,
      'Check your email',
      html`<h1>Check your email</h1>
        <p>${SENT}</p>`,
    );
  });

  // Opening the emailed link only shows a button; the link is used when the person presses it.
  app.get('/sign-in/confirm', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    const church = await churchName(tenantId);
    const token = c.req.query('token') ?? '';
    return page(
      c,
      church,
      'Sign in',
      html`<h1>Sign in to ${church}</h1>
        <form method="post" action="/sign-in/confirm">
          <input type="hidden" name="token" value="${token}" />
          <button type="submit">Continue</button>
        </form>`,
    );
  });

  app.post('/sign-in/confirm', SMALL_BODY, async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    const church = await churchName(tenantId);
    if (!sameOrigin(c))
      return page(
        c,
        church,
        'Sign in',
        html`<h1>Sign in</h1>
          <p>Please use the link from your email again.</p>`,
        403,
      );
    const form = await c.req.parseBody();
    const r = await redeem(tenantId, form['token']);
    if (!r.ok) {
      const message = r.reason === 'DISABLED' ? DISABLED : BAD_LINK;
      return page(
        c,
        church,
        'Sign in',
        html`<h1>Sign in</h1>
          <p role="alert" class="note">${message}</p>
          <p><a href="/sign-in">Get a new link</a></p>`,
        r.reason === 'DISABLED' ? 403 : 400,
      );
    }
    startSession(c, r.sessionToken);
    return c.redirect('/', 303);
  });

  app.get('/', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    const church = await churchName(tenantId);
    const m = await member(c, tenantId);
    if (!m)
      return page(
        c,
        church,
        'Welcome',
        html`<h1>${church}</h1>
          <p><a href="/sign-in">Sign in</a></p>`,
      );
    const who = m.person
      ? html`<h1>Welcome, ${m.person.firstName || m.email}</h1>
          <p>You're signed in. Groups and the community page are on their way.</p>`
      : html`<h1>You're signed in</h1>
          <p>You're signed in as ${m.email}.</p>
          <p>
            Before you can see groups, someone at ${church} needs to confirm which person in the
            church's records you are. Please ask at the welcome desk.
          </p>`;
    return page(
      c,
      church,
      'Welcome',
      html`${who}
        <form method="post" action="/sign-out">
          <button type="submit" class="secondary">Sign out</button>
        </form>`,
    );
  });

  app.post('/sign-out', async (c) => {
    const tenantId = await d.tenantOf(c);
    if (!tenantId) return c.json({ error: 'unknown church' }, 404);
    if (sameOrigin(c)) await endSession(c, tenantId);
    return c.redirect('/sign-in', 303);
  });
}

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

const layout = (church: string, title: string, body: Body) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>${title} · ${church}</title>
        <style>
          :root {
            color-scheme: light dark;
            --fg: #1d1d1f;
            --bg: #fbfaf8;
            --muted: #5f5f66;
            --accent: #2f5d50;
            --line: #d9d6d0;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --fg: #ecebe8;
              --bg: #161616;
              --muted: #a5a5ab;
              --accent: #8fc5b4;
              --line: #3a3a3a;
            }
          }
          body {
            margin: 0;
            background: var(--bg);
            color: var(--fg);
            font:
              17px/1.5 system-ui,
              sans-serif;
          }
          main {
            max-width: 30rem;
            margin: 0 auto;
            padding: 2.5rem 1rem;
          }
          .church {
            color: var(--muted);
            margin: 0 0 1.5rem;
          }
          h1 {
            font-size: 1.6rem;
            line-height: 1.2;
            margin: 0 0 1rem;
          }
          label {
            display: block;
            font-weight: 600;
            margin-bottom: 0.35rem;
          }
          input[type='email'] {
            box-sizing: border-box;
            width: 100%;
            padding: 0.7rem;
            font: inherit;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: transparent;
            color: inherit;
          }
          button {
            margin-top: 1rem;
            padding: 0.7rem 1.1rem;
            font: inherit;
            font-weight: 600;
            border: 0;
            border-radius: 8px;
            background: var(--accent);
            color: var(--bg);
            cursor: pointer;
          }
          button.secondary {
            background: transparent;
            color: var(--accent);
            border: 1px solid var(--line);
          }
          a {
            color: var(--accent);
          }
          .note {
            padding: 0.7rem;
            border-left: 3px solid var(--accent);
            background: color-mix(in srgb, var(--accent) 10%, transparent);
          }
          .small {
            color: var(--muted);
            font-size: 0.9rem;
          }
        </style>
      </head>
      <body>
        <main>
          <p class="church">${church}</p>
          ${body}
        </main>
      </body>
    </html>`;
