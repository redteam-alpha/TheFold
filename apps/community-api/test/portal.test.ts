// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertPersonRead, type PersonReadInput } from '../src/db/readModels.js';
import { withTenant } from '../src/db/tenant.js';
import { buildApi } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { pruneSignIns } from '../src/portal/signIn.js';
import type { MailMessage } from '../src/mail/mailer.js';
import { processOutbox } from '../src/workers/outbox.js';
import { createTestDatabase, dbAvailable, seedTenant, type TestDb } from './helpers/db.js';
import { MemoryGateway } from './helpers/memoryGateway.js';

const KEK = Buffer.alloc(32, 9);
const BASE = 'thefold.test';
const ADA = '00000000-0000-4000-8000-00000000a001';
const KID = '00000000-0000-4000-8000-00000000a002';
const MOM = '00000000-0000-4000-8000-00000000a003';
const DAD = '00000000-0000-4000-8000-00000000a004';

describe.skipIf(!dbAvailable)('member sign-in (ADR 0007)', () => {
  let db: TestDb;
  let n = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A fresh church with its own API, clock, outbox and inbox of sent mail. */
  async function church(opts: { signIn?: boolean } = {}) {
    const slug = `signin-${++n}`;
    const t = await seedTenant(db, slug);
    const clock = { now: new Date('2026-10-02T12:00:00Z') };
    const sent: MailMessage[] = [];
    const lines: string[] = [];
    const app = buildApi({
      pool: db.appPool,
      kek: KEK,
      log: createLogger('debug', (l) => lines.push(l)),
      tenancy: { baseDomain: BASE, defaultSubdomain: null },
      trustProxy: false,
      turnstileSecret: null,
      cardRateLimit: 5,
      now: () => clock.now,
      remoteAddress: () => '203.0.113.9',
      portal: opts.signIn === false ? null : { secureCookies: false, signInRateLimit: 5 },
    });
    const host = `${slug}.${BASE}`;
    const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      app.request(path, { ...init, headers: { host, ...init.headers } });

    const person = (id: string, over: Partial<PersonReadInput> = {}) =>
      withTenant(db.appPool, t.id, (c) =>
        upsertPersonRead(c, {
          twentyPersonId: id,
          twentyUpdatedAt: new Date('2026-10-01T00:00:00Z'),
          firstName: 'Ada',
          lastName: 'Test',
          emails: [],
          phones: [],
          isMinor: false,
          sharedEmail: false,
          householdId: null,
          lifecycleStage: 'CONNECTED',
          doNotContact: false,
          awayUntil: null,
          deletedAt: null,
          ...over,
        }),
      );

    const ask = (email: unknown, headers: Record<string, string> = {}) =>
      req('/v1/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email }),
      });
    /** The worker's part: what was queued gets sent (or quietly not). */
    const deliver = () =>
      processOutbox(db.appPool, t.id, new MemoryGateway(), {
        now: clock.now,
        mail: {
          mailer: { send: (m) => (sent.push(m), Promise.resolve()) },
          publicUrl: (sub) => `http://${sub}.${BASE}`,
        },
      });
    const tokenIn = (m: MailMessage | undefined) =>
      /[?&]token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
    const confirm = (token: string, headers: Record<string, string> = {}) =>
      req('/sign-in/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ token }).toString(),
      });
    const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';
    const me = (cookie: string) => req('/v1/me', { headers: { cookie } });
    /** Ask, deliver, confirm: the whole flow for one address. Returns the session cookie. */
    const signIn = async (email: string) => {
      expect((await ask(email)).status).toBe(202);
      await deliver();
      const token = tokenIn(sent.at(-1));
      expect(token, 'a link was emailed').toBeTruthy();
      const res = await confirm(token as string);
      expect(res.status).toBe(303);
      return cookieOf(res);
    };
    return {
      t,
      slug,
      host,
      clock,
      sent,
      lines,
      req,
      person,
      ask,
      deliver,
      tokenIn,
      confirm,
      cookieOf,
      me,
      signIn,
    };
  }

  it('signs in an adult whose address is on file, and links the account to them', async () => {
    const c = await church();
    await c.person(ADA, { emails: ['Ada@Example.com'] });
    const cookie = await c.signIn('ada@example.com');

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]?.to).toBe('ada@example.com');
    expect(c.sent[0]?.subject).toBe(`Your sign-in link for Church ${c.slug}`);
    expect(c.sent[0]?.text).toContain(`http://${c.slug}.${BASE}/sign-in/confirm?token=`);
    expect(cookie).toMatch(/^fold_session=/);

    const res = await c.me(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'ada@example.com',
      link: 'VERIFIED',
      person: { firstName: 'Ada', lastName: 'Test' },
    });
    const home = await c.req('/', { headers: { cookie } });
    expect(await home.text()).toContain('Welcome, Ada');
  });

  it('answers the same for an unknown address, and sends it nothing', async () => {
    const c = await church();
    await c.person(ADA, { emails: ['ada@example.com'] });
    const known = await c.ask('ada@example.com');
    const unknown = await c.ask('stranger@example.com');
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    await c.deliver();
    expect(c.sent.map((m) => m.to)).toEqual(['ada@example.com']);
  });

  it('never emails a child’s own address, a deleted person, or a deceased person', async () => {
    const c = await church();
    await c.person(KID, { emails: ['kid@example.com'], isMinor: true });
    await c.person(ADA, {
      emails: ['gone@example.com'],
      deletedAt: new Date('2026-10-01T00:00:00Z'),
    });
    await c.person(MOM, { emails: ['late@example.com'], lifecycleStage: 'DECEASED' });
    for (const e of ['kid@example.com', 'gone@example.com', 'late@example.com'])
      expect((await c.ask(e)).status).toBe(202);
    await c.deliver();
    expect(c.sent).toEqual([]);
  });

  it('signs in on a shared family address but links no one until the church confirms', async () => {
    const c = await church();
    await c.person(MOM, { firstName: 'Mo', emails: ['family@example.com'], sharedEmail: true });
    await c.person(DAD, { firstName: 'Da', emails: ['family@example.com'], sharedEmail: true });
    const cookie = await c.signIn('family@example.com');
    expect(await (await c.me(cookie)).json()).toEqual({
      email: 'family@example.com',
      link: 'UNCONFIRMED',
      person: null,
    });
    expect(await (await c.req('/', { headers: { cookie } })).text()).toContain('needs to confirm');
  });

  it('links the parent, never the child, when both records carry the address', async () => {
    const c = await church();
    await c.person(MOM, { firstName: 'Mo', emails: ['mo@example.com'] });
    await c.person(KID, { firstName: 'Kiddo', emails: ['mo@example.com'], isMinor: true });
    const cookie = await c.signIn('mo@example.com');
    expect(
      ((await (await c.me(cookie)).json()) as { person: { firstName: string } }).person.firstName,
    ).toBe('Mo');
  });

  it('uses a link once, within 15 minutes, and only in its own church', async () => {
    const a = await church();
    const b = await church();
    await a.person(ADA, { emails: ['ada@example.com'] });
    await a.ask('ada@example.com');
    await a.deliver();
    const token = a.tokenIn(a.sent[0]) as string;

    // Opening the link only shows a button: a mail scanner that fetches it does not use it up.
    const opened = await a.req(`/sign-in/confirm?token=${token}`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('Continue');

    expect((await b.confirm(token)).status).toBe(400); // another church's host
    expect((await a.confirm(token)).status).toBe(303);
    expect((await a.confirm(token)).status).toBe(400); // used

    await a.ask('ada@example.com');
    a.clock.now = new Date(a.clock.now.getTime() + 60_000);
    await a.deliver();
    const late = a.tokenIn(a.sent.at(-1)) as string;
    a.clock.now = new Date(a.clock.now.getTime() + 16 * 60_000);
    expect((await a.confirm(late)).status).toBe(400); // expired
  });

  it('keeps a session inside its church, and ends it on sign-out', async () => {
    const a = await church();
    const b = await church();
    await a.person(ADA, { emails: ['ada@example.com'] });
    const cookie = await a.signIn('ada@example.com');
    expect((await b.me(cookie)).status).toBe(401);

    const out = await a.req('/v1/auth/sign-out', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/fold_session=;/);
    expect((await a.me(cookie)).status).toBe(401); // revoked, not just forgotten by the browser
  });

  it('sends at most three links per address per 15 minutes, whoever asks', async () => {
    const c = await church();
    await c.person(ADA, { emails: ['ada@example.com'] });
    for (let i = 0; i < 5; i++) {
      await c.ask('ada@example.com');
      await c.deliver();
      c.clock.now = new Date(c.clock.now.getTime() + 61_000); // a new minute: a new job each time
    }
    expect(c.sent).toHaveLength(3);
    c.clock.now = new Date(c.clock.now.getTime() + 15 * 60_000);
    await c.ask('ada@example.com');
    await c.deliver();
    expect(c.sent).toHaveLength(4);
  });

  it('limits requests per device, refuses cross-site posts, and checks the address', async () => {
    const c = await church();
    expect((await c.ask('not an email')).status).toBe(400);
    expect((await c.ask('a@example.com', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.confirm('x'.repeat(43), { origin: 'https://evil.example' })).status).toBe(403);
    for (let i = 0; i < 4; i++) expect((await c.ask(`p${i}@example.com`)).status).toBe(202);
    const limited = await c.ask('p9@example.com');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await c.ask('p0@example.com', { origin: `http://${c.host}` })).status).toBe(429);
  });

  it('says sign-in is off when email is not configured', async () => {
    const c = await church({ signIn: false });
    expect((await c.ask('ada@example.com')).status).toBe(503);
    expect((await c.req('/sign-in')).status).toBe(503);
  });

  it('refuses a disabled account, and never logs an address or a token', async () => {
    const c = await church();
    await c.person(ADA, { emails: ['ada@example.com'] });
    await c.signIn('ada@example.com');
    await withTenant(db.appPool, c.t.id, (x) =>
      x.query(`UPDATE portal_account SET status = 'DISABLED' WHERE email = 'ada@example.com'`),
    );
    c.clock.now = new Date(c.clock.now.getTime() + 60_000);
    await c.ask('ada@example.com');
    await c.deliver();
    expect(c.sent).toHaveLength(1); // nothing more for a disabled account

    const token = c.tokenIn(c.sent[0]) as string;
    const all = c.lines.join('\n');
    expect(all).not.toContain('ada@example.com');
    expect(all).not.toContain(token);
  });

  it('forgets a typed address a day after its request is done', async () => {
    const c = await church();
    await c.ask('stranger@example.com');
    await c.deliver();
    const jobs = () =>
      withTenant(db.appPool, c.t.id, (x) =>
        x.query(`SELECT 1 FROM outbox WHERE kind = 'mail.signInLink'`),
      ).then((r) => r.rowCount);
    expect(await jobs()).toBe(1);
    await withTenant(db.appPool, c.t.id, (x) =>
      pruneSignIns(x, new Date(Date.now() + 2 * 86_400_000)),
    );
    expect(await jobs()).toBe(0);
  });

  it('serves the sign-in form and a "check your email" page that says the same for everyone', async () => {
    const c = await church();
    const form = await c.req('/sign-in');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('Email me a sign-in link');
    const posted = await c.req('/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=stranger%40example.com',
    });
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain('If this church has that address on file');
  });
});
