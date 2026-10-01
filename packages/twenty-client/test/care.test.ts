// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  loginWithPassword,
  runM0,
  TokenBucket,
  TwentyClient,
  TwentyLoginError,
  type CheckResult,
} from '../src/index.js';
import { FAKE_MODEL, FakeTwenty, type FakeQuirks } from '../src/testing/fakeTwenty.js';

const BASE = 'https://twenty.test';
const STAFF = { email: 'staff@fold-test.example', password: 'staff-secret-pw-1' };
const CARE = { email: 'care@fold-test.example', password: 'care-secret-pw-2' };
const USERS: FakeQuirks['users'] = [
  { ...STAFF, role: 'staff' },
  { ...CARE, role: 'care' },
];
const ENV = {
  FOLD_M0_STAFF_EMAIL: STAFF.email,
  FOLD_M0_STAFF_PASSWORD: STAFF.password,
  FOLD_M0_CARE_EMAIL: CARE.email,
  FOLD_M0_CARE_PASSWORD: CARE.password,
  FOLD_M0_TIMELINE_WAIT_MS: '0',
};

async function run(quirks: FakeQuirks = {}, env: Record<string, string | undefined> = ENV) {
  const server = new FakeTwenty({ users: USERS, ...quirks });
  const bucket = new TokenBucket({
    capacity: 10_000,
    refillPerSecond: 10_000,
    backgroundReserve: 0,
    now: Date.now,
  });
  const clientFor = (apiKey: string) =>
    new TwentyClient({
      baseUrl: BASE,
      apiKey,
      fetch: server.fetch,
      bucket,
      retry: { sleep: () => Promise.resolve(), random: () => 0 },
    });
  const results = await runM0({
    client: clientFor('service-key'),
    adminClient: clientFor('admin-key'),
    baseUrl: BASE,
    apiKey: 'service-key',
    fetch: server.fetch,
    model: FAKE_MODEL,
    env,
    runId: 'care1234',
  });
  const care = results.find((r) => r.id === 'care-permissions-api') as CheckResult;
  return { server, results, care };
}

/** The labels the check reports a surface under; one leak must name exactly its own. */
const SURFACES: Record<string, string> = {
  restList: 'REST list',
  restById: 'REST by id',
  restCreate: 'REST create',
  personRelation: 'REST person with relations',
  graphql: 'GraphQL careRequests',
  search: 'global search',
  timeline: 'timeline of the care request',
};

describe('care-permissions-api: can a user without the care role see a care request?', () => {
  it('is skipped without the test users, and the detail says how to create them', async () => {
    const { care } = await run({}, {});
    expect(care.status).toBe('SKIP');
    expect(care.detail).toContain('FOLD_M0_STAFF_EMAIL');
    expect(care.detail).toContain('Church staff');
    expect(care.detail).toContain('Care team');
  });

  it('passes on a server that hides care requests from staff, naming every surface it tested', async () => {
    const { care, server } = await run();
    expect(care.status).toBe('PASS');
    for (const label of [...Object.values(SURFACES), 'timeline of the person'])
      expect(care.detail, label).toContain(label);
    expect(care.detail).toContain('Care team user could read it (control)');
    // The seeded person and care request are gone afterwards.
    expect(server.rows('careRequests')).toEqual([]);
    expect(server.rows('people')).toEqual([]);
  });

  describe('every surface can fail, and a leak names only its own surface', () => {
    for (const [leakKey, label] of Object.entries(SURFACES)) {
      it(`${label}`, async () => {
        const { care, server } = await run({ leaks: { [leakKey]: true } });
        expect(care.status).toBe('FAIL');
        expect(care.detail).toContain('LEAK as the Church staff user');
        const leakPart = care.detail.split('Held:')[0] ?? '';
        expect(leakPart, `leak part: ${leakPart}`).toContain(label);
        for (const other of Object.values(SURFACES).filter((l) => l !== label))
          expect(leakPart, `${other} must not be reported as leaking`).not.toContain(other);
        // Even a successful write by staff is cleaned up, so the check never leaves a care request behind.
        expect(server.rows('careRequests')).toEqual([]);
      });
    }
  });

  it('refuses to pass when the Care team cannot read the record: a denial would mean nothing', async () => {
    const { care } = await run({ careCannotRead: true });
    expect(care.status).toBe('FAIL');
    expect(care.detail).toContain('Care team user could not read');
    expect(care.detail).not.toContain('LEAK');
  });

  it('is INFO, never PASS, when a surface could not be tested', async () => {
    const noSearch = (await run({ noSearch: true })).care;
    expect(noSearch.status).toBe('INFO');
    expect(noSearch.detail).toContain('NOT tested');
    expect(noSearch.detail).toContain('global search');

    const noTimeline = (await run({ noTimeline: true })).care;
    expect(noTimeline.status).toBe('INFO');
    expect(noTimeline.detail).toContain('timeline: no entry was created');
    expect(noTimeline.detail).toContain('NOT tested');
  });

  describe('credentials', () => {
    it('fails clearly on a wrong password and never echoes it, even if the server does', async () => {
      const env = { ...ENV, FOLD_M0_STAFF_PASSWORD: 'definitely-wrong-pw' };
      for (const echo of [false, true]) {
        const { care } = await run({ echoPasswordInLoginErrors: echo }, env);
        expect(care.status).toBe('FAIL');
        expect(care.detail).toContain('could not sign in as the Church staff test user');
        expect(care.detail).not.toContain('definitely-wrong-pw');
        if (echo) expect(care.detail).toContain('***');
      }
    });

    it('never puts a password or a token in any result', async () => {
      const secrets = [STAFF.password, CARE.password, 'user:staff:', 'user:care:', 'login:'];
      for (const quirks of [
        {},
        { leaks: { restList: true } },
        { noSearch: true },
      ] as FakeQuirks[]) {
        const { results } = await run(quirks);
        const text = JSON.stringify(results);
        for (const s of secrets) expect(text, s).not.toContain(s);
      }
    });
  });

  it('uses the signed-in users only for reads and the one create it expects to be refused', async () => {
    const { server } = await run();
    const asUser = server.calls.filter((c) => c.authorization?.startsWith('Bearer user:'));
    expect(asUser.length).toBeGreaterThan(5);
    expect(asUser.filter((c) => c.method !== 'GET' && c.method !== 'POST')).toEqual([]);
    const posts = asUser.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(new Set(posts)).toEqual(new Set(['/rest/careRequests', '/graphql']));
  });
});

describe('loginWithPassword', () => {
  const server = () => new FakeTwenty({ users: USERS });

  it('signs in with the two documented mutations, sending the server origin', async () => {
    const s = server();
    const token = await loginWithPassword({ baseUrl: BASE, ...STAFF, fetch: s.fetch });
    expect(token.startsWith('user:staff:')).toBe(true);
    const sent = s.calls.filter((c) => c.path === '/metadata');
    expect(sent.map((c) => c.method)).toEqual(['POST', 'POST']);
    const queries = sent.map((c) => (c.body as { query: string }).query);
    expect(queries[0]).toContain('getLoginTokenFromCredentials');
    expect(queries[1]).toContain('getAuthTokensFromLoginToken');
    for (const c of sent)
      expect((c.body as { variables: { origin: string } }).variables.origin).toBe(BASE);
  });

  it('throws a TwentyLoginError that does not contain the password', async () => {
    const s = new FakeTwenty({ users: USERS, echoPasswordInLoginErrors: true });
    const error = await loginWithPassword({
      baseUrl: BASE,
      email: STAFF.email,
      password: 'wrong-pw-xyz',
      fetch: s.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwentyLoginError);
    expect((error as Error).message).not.toContain('wrong-pw-xyz');
    expect((error as Error).message).toContain('failed');
  });
});
