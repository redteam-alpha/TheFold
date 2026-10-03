// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { grantStaffRole, revokeStaffRole } from '../src/portal/confirm.js';
import { createTestDatabase, dbAvailable, type TestDb } from './helpers/db.js';
import { portalChurch } from './helpers/portal.js';

const LEA = '00000000-0000-4000-8000-0000000d0001'; // welcome lead
const BEA = '00000000-0000-4000-8000-0000000d0002'; // an ordinary member
const MO = '00000000-0000-4000-8000-0000000d0003'; // shares family@ with Da and Kit
const DA = '00000000-0000-4000-8000-0000000d0004';
const KIT = '00000000-0000-4000-8000-0000000d0005'; // a child on the same address
const STRANGER = '00000000-0000-4000-8000-0000000d0006';

type Waiting = {
  accountId: string;
  email: string;
  candidates: { personId: string; firstName: string }[];
};

describe.skipIf(!dbAvailable)('staff confirming sign-ins (ADR 0007)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function setUp() {
    const c = await portalChurch(db);
    await c.person(LEA, { firstName: 'Lea', lastName: 'Lambert', emails: ['lea@example.com'] });
    await c.person(BEA, { firstName: 'Bea', emails: ['bea@example.com'] });
    for (const [id, first] of [
      [MO, 'Mo'],
      [DA, 'Da'],
    ] as const)
      await c.person(id, {
        firstName: first,
        lastName: 'Family',
        emails: ['family@example.com'],
        sharedEmail: true,
      });
    await c.person(KIT, {
      firstName: 'Kit',
      lastName: 'Family',
      emails: ['family@example.com'],
      isMinor: true,
    });
    await c.person(STRANGER, { firstName: 'Sol', emails: ['sol@example.com'] });
    expect(await c.inT((x) => grantStaffRole(x, LEA, 'welcome_lead'))).toBe('GRANTED');
    return c;
  }

  it('shows a welcome lead who is waiting, offers only the adults on that address, and links the one chosen', async () => {
    const c = await setUp();
    const family = await c.signIn('family@example.com');
    expect((await c.getJson(family, '/v1/me')).body['link']).toBe('UNCONFIRMED');
    const lea = await c.signIn('lea@example.com');

    expect(await (await c.req('/', { headers: { cookie: lea } })).text()).toContain(
      'Confirm sign-ins',
    );
    const waiting = (await c.getJson(lea, '/v1/staff/sign-ins')).body['waiting'] as Waiting[];
    expect(waiting.map((w) => w.email)).toEqual(['family@example.com']);
    const entry = waiting[0] as Waiting;
    expect(entry.candidates.map((p) => p.firstName)).toEqual(['Da', 'Mo']); // never Kit

    // Not a child, not someone whose record does not carry the address.
    expect(
      (await c.postJson(lea, `/v1/staff/sign-ins/${entry.accountId}`, { personId: KIT })).status,
    ).toBe(404);
    expect(
      (await c.postJson(lea, `/v1/staff/sign-ins/${entry.accountId}`, { personId: STRANGER }))
        .status,
    ).toBe(404);

    const ok = await c.postForm(lea, `/staff/sign-ins/${entry.accountId}`, { personId: MO });
    expect(ok.status).toBe(303);
    expect((await c.getJson(family, '/v1/me')).body).toMatchObject({
      link: 'VERIFIED',
      person: { firstName: 'Mo', lastName: 'Family' },
    });
    expect(((await c.getJson(lea, '/v1/staff/sign-ins')).body['waiting'] as Waiting[]).length).toBe(
      0,
    );
    expect(
      (await c.postJson(lea, `/v1/staff/sign-ins/${entry.accountId}`, { personId: DA })).status,
    ).toBe(409);

    const audit = await c.inT((x) =>
      x.query<{ action: string; actor_person_id: string; actor_roles: string[] }>(
        `SELECT action, actor_person_id, actor_roles FROM audit_log WHERE action = 'portal.link_confirmed'`,
      ),
    );
    expect(audit.rows).toEqual([
      { action: 'portal.link_confirmed', actor_person_id: LEA, actor_roles: ['welcome_lead'] },
    ]);
    // Now Mo is a confirmed member and can see groups.
    expect((await c.getJson(family, '/v1/groups')).status).toBe(200);
  });

  it('keeps the queue to staff who hold the role, from this site', async () => {
    const c = await setUp();
    await c.signIn('family@example.com');
    const bea = await c.signIn('bea@example.com');
    const lea = await c.signIn('lea@example.com');

    expect((await c.req('/v1/staff/sign-ins')).status).toBe(401);
    expect((await c.getJson(bea, '/v1/staff/sign-ins')).status).toBe(403);
    expect(await (await c.req('/', { headers: { cookie: bea } })).text()).not.toContain(
      'Confirm sign-ins',
    );
    const waiting = (await c.getJson(lea, '/v1/staff/sign-ins')).body['waiting'] as Waiting[];
    const forged = await c.req(`/v1/staff/sign-ins/${waiting[0]?.accountId}`, {
      method: 'POST',
      headers: { cookie: lea, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ personId: MO }),
    });
    expect(forged.status).toBe(403);

    expect(await c.inT((x) => revokeStaffRole(x, LEA, 'welcome_lead', new Date()))).toBe('REVOKED');
    expect((await c.getJson(lea, '/v1/staff/sign-ins')).status).toBe(403);
  });

  it('grants a role only to an adult in the records, once', async () => {
    const c = await setUp();
    expect(await c.inT((x) => grantStaffRole(x, LEA, 'welcome_lead'))).toBe('ALREADY');
    expect(await c.inT((x) => grantStaffRole(x, KIT, 'admin'))).toBe('NO_SUCH_PERSON');
    expect(
      await c.inT((x) => grantStaffRole(x, '00000000-0000-4000-8000-0000000d0099', 'admin')),
    ).toBe('NO_SUCH_PERSON');
    expect(await c.inT((x) => revokeStaffRole(x, BEA, 'admin', new Date()))).toBe('NOT_HELD');
  });

  it('checks the role command’s arguments before touching anything', async () => {
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(await runCli(['grant-role'])).toBe(64);
      expect(await runCli(['grant-role', 'grace', 'not-an-id', 'admin'])).toBe(64);
      expect(await runCli(['grant-role', 'grace', LEA, 'overlord'])).toBe(64);
    } finally {
      process.stderr.write = write;
    }
  });
});
