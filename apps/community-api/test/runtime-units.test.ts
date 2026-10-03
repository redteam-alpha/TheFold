// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TwentyRecord } from '@thefold/twenty-client';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadServiceConfig, loadSetupConfig, publicUrlFor } from '../src/config.js';
import { WindowLimiter } from '../src/http/rateLimit.js';
import { subdomainFromHost } from '../src/http/tenantResolution.js';
import { verifyTurnstile } from '../src/http/turnstile.js';
import { hintFromTwentyWebhook } from '../src/http/webhookPayload.js';
import { createLogger } from '../src/log.js';
import {
  groupReadFromTwenty,
  membershipReadFromTwenty,
  personReadFromTwenty,
} from '../src/sync/fromTwenty.js';

const KEK = Buffer.alloc(32, 7).toString('base64');
const TENANT = '00000000-0000-4000-8000-000000000001';
const PERSON = '00000000-0000-4000-8000-0000000000a1';

describe('configuration', () => {
  const base = { FOLD_DATABASE_URL: 'postgres://fold_app:pw@db:5432/community', FOLD_KEK: KEK };

  it('applies defaults', () => {
    const c = loadServiceConfig(base);
    expect(c.http).toEqual({ host: '0.0.0.0', port: 4000 });
    expect(c.tenancy).toEqual({ baseDomain: null, defaultSubdomain: null });
    expect(c.trustProxy).toBe(false);
    expect(c.turnstileSecret).toBeNull();
    expect(c.worker).toEqual({ pollMs: 5000, reconcileEveryMs: 3_600_000 });
    expect(c.kek).toHaveLength(32);
  });

  it('switches sign-in off without SMTP, and needs a From address and a public address with it', () => {
    expect(loadServiceConfig(base).mail).toBeNull();
    const mail = { FOLD_SMTP_HOST: 'mailpit', FOLD_SMTP_PORT: '1025' };
    expect(() => loadServiceConfig({ ...base, ...mail })).toThrow(
      /FOLD_MAIL_FROM[\s\S]*FOLD_PUBLIC_URL/,
    );
    const c = loadServiceConfig({
      ...base,
      ...mail,
      FOLD_MAIL_FROM: 'The Fold <no-reply@thefold.test>',
      FOLD_PUBLIC_URL: 'http://192.168.51.10:4000/',
      FOLD_SMTP_PASSWORD: '',
    });
    expect(c.mail).toEqual({
      smtp: {
        host: 'mailpit',
        port: 1025,
        secure: false,
        user: null,
        password: null,
        from: 'The Fold <no-reply@thefold.test>',
      },
      publicUrl: 'http://192.168.51.10:4000',
      signInRateLimit: 10,
    });
    const multi = loadServiceConfig({
      ...base,
      ...mail,
      FOLD_MAIL_FROM: 'x <no-reply@thefold.test>',
      FOLD_BASE_DOMAIN: 'thefold.app',
    });
    expect(publicUrlFor(multi.mail?.publicUrl ?? '', 'grace')).toBe('https://grace.thefold.app');
  });

  it('treats an empty variable as unset (compose passes `X=` through)', () => {
    const c = loadServiceConfig({ ...base, FOLD_TURNSTILE_SECRET: '', FOLD_DEFAULT_SUBDOMAIN: '' });
    expect(c.turnstileSecret).toBeNull();
    expect(c.tenancy.defaultSubdomain).toBeNull();
  });

  it('lists every problem and never echoes a value, which may be a secret', () => {
    const secretish = 'not-a-url-zzzzzzzzzzzzzz';
    const error = (() => {
      try {
        loadServiceConfig({ FOLD_DATABASE_URL: secretish, FOLD_KEK: 'short', FOLD_HTTP_PORT: 'x' });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('FOLD_DATABASE_URL');
    expect(message).toContain('FOLD_HTTP_PORT');
    expect(message).toContain('FOLD_KEK');
    expect(message).not.toContain(secretish);
    expect(message).not.toContain('short');
  });

  it('setup: provisions a church only when all of its settings are present', () => {
    const migrator = { FOLD_MIGRATOR_DATABASE_URL: 'postgres://fold_migrator@db/community' };
    expect(loadSetupConfig(migrator).tenant).toBeNull();
    // compose always passes a default base URL: that alone provisions nothing
    expect(
      loadSetupConfig({ ...migrator, FOLD_TWENTY_BASE_URL: 'http://twenty-server:3000' }).tenant,
    ).toBeNull();
    expect(() => loadSetupConfig({ ...migrator, FOLD_TWENTY_API_KEY: 'k'.repeat(40) })).toThrow(
      /FOLD_TENANT_SLUG/,
    );
    expect(() => loadSetupConfig({ ...migrator, FOLD_TENANT_SLUG: 'grace' })).toThrow(
      /FOLD_TWENTY_BASE_URL and FOLD_TWENTY_API_KEY/,
    );
    const full = loadSetupConfig({
      ...migrator,
      FOLD_KEK: KEK,
      FOLD_TENANT_SLUG: 'grace',
      FOLD_TWENTY_BASE_URL: 'http://twenty-server:3000/',
      FOLD_TWENTY_API_KEY: 'k'.repeat(40),
      FOLD_TENANT_TIMEZONE: 'America/Chicago',
    });
    expect(full.tenant).toMatchObject({
      slug: 'grace',
      subdomain: 'grace',
      name: 'grace',
      timezone: 'America/Chicago',
      twentyBaseUrl: 'http://twenty-server:3000',
      twentyWebhookSecret: null,
    });
    expect(() => loadSetupConfig({ ...migrator, FOLD_TENANT_TIMEZONE: 'Mars/Olympus' })).toThrow(
      /IANA/,
    );
  });

  it('builds the database URL from parts, so a generated password cannot break it', () => {
    const awkward = 'a/b+c=d%e@f:g#h?i';
    const c = loadServiceConfig({
      FOLD_KEK: KEK,
      FOLD_DB_HOST: 'community-db',
      FOLD_APP_DB_PASSWORD: awkward,
    });
    const u = new URL(c.databaseUrl);
    expect([u.hostname, u.port, u.pathname, decodeURIComponent(u.username)]).toEqual([
      'community-db',
      '5432',
      '/community',
      'fold_app',
    ]);
    expect(decodeURIComponent(u.password)).toBe(awkward);

    const s = loadSetupConfig({
      FOLD_DB_HOST: 'community-db',
      FOLD_DB_SUPERUSER_PASSWORD: awkward,
      FOLD_APP_DB_PASSWORD: 'app-aaaaaaaaaaaa',
      FOLD_MIGRATOR_DB_PASSWORD: 'migrator-aaaaaaaaaaaa',
    });
    expect(decodeURIComponent(new URL(s.superuserUrl as string).password)).toBe(awkward);
    expect(decodeURIComponent(new URL(s.migratorUrl).username)).toBe('fold_migrator');
    expect(s.rolePasswords).toEqual({
      app: 'app-aaaaaaaaaaaa',
      migrator: 'migrator-aaaaaaaaaaaa',
    });

    expect(() => loadServiceConfig({ FOLD_KEK: KEK, FOLD_DB_HOST: 'db' })).toThrow(
      /FOLD_APP_DB_PASSWORD/,
    );
    expect(() => loadSetupConfig({ FOLD_DB_HOST: 'db' })).toThrow(/FOLD_MIGRATOR_DB_PASSWORD/);
  });

  it('setup: bootstrapping as a superuser requires both role passwords', () => {
    expect(() =>
      loadSetupConfig({
        FOLD_MIGRATOR_DATABASE_URL: 'postgres://fold_migrator@db/community',
        FOLD_DB_SUPERUSER_URL: 'postgres://postgres:pw@db/community',
      }),
    ).toThrow(/FOLD_APP_DB_PASSWORD/);
  });
});

describe('which church a request is for', () => {
  const cases: [string | undefined, string | null, string | null, string | null][] = [
    ['grace.thefold.app', 'thefold.app', null, 'grace'],
    ['Grace.TheFold.App:443', 'thefold.app', null, 'grace'],
    ['grace.thefold.app.', 'thefold.app', null, 'grace'],
    ['thefold.app', 'thefold.app', 'dev', null],
    ['a.b.thefold.app', 'thefold.app', 'dev', null],
    ['-bad.thefold.app', 'thefold.app', 'dev', null],
    ['localhost:4000', 'thefold.app', 'dev', 'dev'],
    ['192.168.51.10:4000', null, 'grace', 'grace'],
    [undefined, null, 'grace', 'grace'],
    ['evilthefold.app', 'thefold.app', null, null],
  ];
  it.each(cases)('%s (base %s, fallback %s) → %s', (host, base, fallback, expected) => {
    expect(subdomainFromHost(host, base, fallback)).toBe(expected);
  });
});

describe('rate limit', () => {
  it('allows `limit` per window per key, then reports when to retry', () => {
    let t = 0;
    const l = new WindowLimiter(3, 60_000, () => t);
    expect([1, 2, 3].map(() => l.take('a').ok)).toEqual([true, true, true]);
    expect(l.take('a')).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(l.take('b').ok).toBe(true);
    t = 59_500;
    expect(l.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    t = 60_000;
    expect(l.take('a').ok).toBe(true);
  });

  it('never holds more than maxKeys windows', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 4 }), { maxLength: 200 }), (keys) => {
        const l = new WindowLimiter(1, 1000, () => 0, 16);
        for (const k of keys) l.take(k);
        return (l as unknown as { windows: Map<string, unknown> }).windows.size <= 16;
      }),
    );
  });
});

describe('Twenty webhook payload → hint (shape UNVERIFIED; tolerant)', () => {
  const at = 1_790_000_000_000;
  const hint = (body: unknown, rawBody = JSON.stringify(body)) =>
    hintFromTwentyWebhook({ body, rawBody, tenantId: TENANT, receivedAt: at });

  it('reads the documented shape', () => {
    expect(
      hint({ eventName: 'person.updated', record: { id: PERSON, name: 'x' }, eventId: 'evt-1' }),
    ).toEqual({
      tenantId: TENANT,
      objectType: 'person',
      recordId: PERSON,
      action: 'updated',
      deliveryId: 'evt-1',
      receivedAt: at,
    });
  });

  it('accepts the obvious variants', () => {
    expect(
      hint({
        type: 'groupMembership.destroyed',
        recordId: PERSON,
        objectMetadata: { nameSingular: 'groupMembership' },
      }),
    ).toMatchObject({ objectType: 'groupMembership', action: 'deleted' });
    expect(hint({ event: 'person.upserted', data: { id: PERSON } })).toMatchObject({
      action: 'updated',
    });
  });

  it('uses a hash of the raw body when there is no delivery id, so a redelivery is still recognised', () => {
    const body = { eventName: 'person.created', record: { id: PERSON } };
    const a = hint(body);
    const b = hint(body);
    expect(a?.deliveryId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a?.deliveryId).toBe(b?.deliveryId);
  });

  it('ignores what it cannot read, rather than guessing', () => {
    for (const body of [
      null,
      [],
      'person.updated',
      { eventName: 'person.updated' },
      { eventName: 'person.exploded', record: { id: PERSON } },
      { eventName: 'person.updated', record: { id: 'not-a-uuid' } },
      { record: { id: PERSON } },
    ])
      expect(hint(body), JSON.stringify(body)).toBeNull();
  });
});

describe('Turnstile', () => {
  const respond =
    (status: number, body: unknown): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
  const networkDown: typeof fetch = () => Promise.reject(new Error('network down'));

  it('PASSED / FAILED / UNAVAILABLE', async () => {
    const v = (f: typeof fetch) =>
      verifyTurnstile({ secret: 's', token: 't', remoteIp: '1.2.3.4', fetch: f });
    expect(await v(respond(200, { success: true }))).toBe('PASSED');
    expect(await v(respond(200, { success: false }))).toBe('FAILED');
    expect(await v(respond(503, {}))).toBe('UNAVAILABLE');
    expect(await v(networkDown)).toBe('UNAVAILABLE');
  });

  it('sends the secret, the token and the client IP as a form', async () => {
    let sent: URLSearchParams | null = null;
    await verifyTurnstile({
      secret: 'sec',
      token: 'tok',
      remoteIp: '10.0.0.9',
      fetch: ((_url: string, init: RequestInit) => {
        sent = init.body as URLSearchParams;
        return Promise.resolve(new Response('{"success":true}'));
      }) as typeof fetch,
    });
    expect(Object.fromEntries((sent as unknown as URLSearchParams).entries())).toEqual({
      secret: 'sec',
      response: 'tok',
      remoteip: '10.0.0.9',
    });
  });
});

describe('Twenty records → read models', () => {
  const person = (over: Record<string, unknown> = {}): TwentyRecord => ({
    id: PERSON,
    updatedAt: '2026-10-01T12:00:00.000Z',
    name: { firstName: 'Sam', lastName: 'Rivera' },
    emails: { primaryEmail: 'sam@example.com', additionalEmails: ['s.rivera@example.org'] },
    phones: {
      primaryPhoneNumber: '5551234567',
      primaryPhoneCallingCode: '+1',
      additionalPhones: [{ number: '7700900123', callingCode: '+44' }],
    },
    lifecycleStage: 'GETTING_CONNECTED',
    householdId: null,
    deletedAt: null,
    ...over,
  });

  it('maps the composite fields and relations', () => {
    expect(personReadFromTwenty(person())).toEqual({
      twentyPersonId: PERSON,
      twentyUpdatedAt: new Date('2026-10-01T12:00:00.000Z'),
      firstName: 'Sam',
      lastName: 'Rivera',
      emails: ['sam@example.com', 's.rivera@example.org'],
      phones: ['+15551234567', '+447700900123'],
      isMinor: false,
      sharedEmail: false,
      householdId: null,
      lifecycleStage: 'GETTING_CONNECTED',
      doNotContact: false,
      awayUntil: null,
      deletedAt: null,
    });
  });

  it('never marks a minor contactable, whatever the record says', () => {
    expect(personReadFromTwenty(person({ isMinor: true, doNotContact: false }))?.doNotContact).toBe(
      true,
    );
  });

  it('defaults a missing stage, but refuses an unknown one and a missing updatedAt', () => {
    expect(personReadFromTwenty(person({ lifecycleStage: null }))?.lifecycleStage).toBe(
      'NEW_GUEST',
    );
    expect(personReadFromTwenty(person({ lifecycleStage: 'VIP' }))).toBeNull();
    expect(personReadFromTwenty(person({ updatedAt: undefined }))).toBeNull();
    expect(personReadFromTwenty(person({ updatedAt: 'yesterday' }))).toBeNull();
  });

  it('keeps only the date of awayUntil, and a deletion time', () => {
    const p = personReadFromTwenty(
      person({ awayUntil: '2026-12-01T00:00:00.000Z', deletedAt: '2026-10-02T08:00:00.000Z' }),
    );
    expect(p?.awayUntil).toBe('2026-12-01');
    expect(p?.deletedAt).toEqual(new Date('2026-10-02T08:00:00.000Z'));
  });

  it('memberships need both sides and known values', () => {
    const m = {
      id: PERSON,
      updatedAt: '2026-10-01T12:00:00.000Z',
      groupId: TENANT,
      personId: PERSON,
      groupRole: 'LEADER',
      status: 'ACTIVE',
    };
    expect(membershipReadFromTwenty(m)).toMatchObject({ role: 'LEADER', status: 'ACTIVE' });
    expect(membershipReadFromTwenty({ ...m, groupRole: undefined })?.role).toBe('MEMBER');
    expect(membershipReadFromTwenty({ ...m, personId: null })).toBeNull();
    expect(membershipReadFromTwenty({ ...m, status: 'BANNED' })).toBeNull();
  });

  it('maps a group, and skips one whose openness it does not know rather than showing it to everyone', () => {
    const g = {
      id: PERSON,
      updatedAt: '2026-10-02T09:00:00.000Z',
      name: 'Tuesday Supper',
      groupType: 'SMALL_GROUP',
      openness: 'SECRET',
      schedule: 'Tuesdays 7pm',
      capacity: 12,
      childFriendly: true,
      pausedUntil: '2026-12-01T00:00:00.000Z',
      description: 'Food and conversation',
    };
    expect(groupReadFromTwenty(g)).toMatchObject({
      name: 'Tuesday Supper',
      openness: 'SECRET',
      schedule: 'Tuesdays 7pm',
      capacity: 12,
      childFriendly: true,
      pausedUntil: '2026-12-01',
      description: 'Food and conversation',
    });
    expect(groupReadFromTwenty({ ...g, openness: undefined })?.openness).toBe('CLOSED');
    expect(groupReadFromTwenty({ ...g, openness: 'INVITE_ONLY' })).toBeNull();
    expect(groupReadFromTwenty({ ...g, capacity: -1 })?.capacity).toBeNull();
    expect(groupReadFromTwenty({ ...g, groupType: 'NEW_KIND' })?.groupType).toBeNull();
  });
});

describe('logger', () => {
  it('writes one JSON object per line and respects the level', () => {
    const lines: string[] = [];
    const log = createLogger(
      'info',
      (l) => lines.push(l),
      () => new Date(0),
    );
    log.debug('hidden');
    log.info('card.received', { tenantId: TENANT, status: 'QUEUED' });
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        t: '1970-01-01T00:00:00.000Z',
        level: 'info',
        event: 'card.received',
        tenantId: TENANT,
        status: 'QUEUED',
      },
    ]);
  });
});
