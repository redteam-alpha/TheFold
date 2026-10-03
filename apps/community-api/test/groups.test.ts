// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dbAvailable, type TestDb } from './helpers/db.js';
import { portalChurch } from './helpers/portal.js';

const LEA = '00000000-0000-4000-8000-0000000b0001'; // leads Supper
const BEA = '00000000-0000-4000-8000-0000000b0002'; // wants to join
const CY = '00000000-0000-4000-8000-0000000b0003'; // a member of Supper
const KID = '00000000-0000-4000-8000-0000000b0004'; // a child in Supper
const SUPPER = '00000000-0000-4000-8000-0000000c0001'; // CLOSED
const OPEN = '00000000-0000-4000-8000-0000000c0002'; // PUBLIC
const RECOVERY = '00000000-0000-4000-8000-0000000c0003'; // SECRET
const GONE = '00000000-0000-4000-8000-0000000c0004'; // deleted in Twenty

type Group = { id: string; name: string; myStatus: string | null };

describe.skipIf(!dbAvailable)('groups in the portal (ADR 0008)', () => {
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
    await c.person(BEA, { firstName: 'Bea', lastName: 'Bower', emails: ['bea@example.com'] });
    await c.person(CY, { firstName: 'Cy', lastName: 'Carter', emails: ['cy@example.com'] });
    await c.person(KID, { firstName: 'Kit', lastName: 'Carter', isMinor: true });
    await c.group(SUPPER, { name: 'Tuesday Supper', openness: 'CLOSED', schedule: 'Tuesdays 7pm' });
    await c.group(OPEN, { name: 'Prayer walk', openness: 'PUBLIC' });
    await c.group(RECOVERY, { name: 'Recovery circle', openness: 'SECRET' });
    await c.group(GONE, { name: 'Old group', deletedAt: new Date('2026-09-01T00:00:00Z') });
    await c.membership(SUPPER, LEA, 'ACTIVE', 'LEADER');
    await c.membership(SUPPER, CY, 'ACTIVE');
    await c.membership(SUPPER, KID, 'ACTIVE');
    await c.membership(RECOVERY, CY, 'ACTIVE');
    return c;
  }

  const names = (body: Record<string, unknown>) => (body['groups'] as Group[]).map((g) => g.name);

  it('lists open and closed groups for everyone, a secret group only for its people, and never a deleted one', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const cy = await c.signIn('cy@example.com');

    expect(names((await c.getJson(bea, '/v1/groups')).body)).toEqual([
      'Prayer walk',
      'Tuesday Supper',
    ]);
    expect((await c.getJson(bea, `/v1/groups/${RECOVERY}`)).status).toBe(404);
    expect((await c.getJson(bea, `/v1/groups/${GONE}`)).status).toBe(404);
    // Cy's own groups come first.
    expect(names((await c.getJson(cy, '/v1/groups')).body)).toEqual([
      'Recovery circle',
      'Tuesday Supper',
      'Prayer walk',
    ]);
    const page = await (await c.req('/groups', { headers: { cookie: bea } })).text();
    expect(page).toContain('Tuesday Supper');
    expect(page).not.toContain('Recovery circle');
  });

  it('shows leaders by first name to everyone, members only to members, and never a child', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const cy = await c.signIn('cy@example.com');

    const outside = (await c.getJson(bea, `/v1/groups/${SUPPER}`)).body;
    expect(outside['leaders']).toEqual(['Lea']);
    expect(outside['members']).toBeNull();
    expect(outside['requests']).toBeNull();

    const inside = (await c.getJson(cy, `/v1/groups/${SUPPER}`)).body;
    expect(inside['members']).toEqual([
      { name: 'Lea L.', leads: true },
      { name: 'Cy C.', leads: false },
    ]);
    expect(JSON.stringify(inside)).not.toContain('Kit');
    expect(JSON.stringify(inside)).not.toContain('Carter'); // last names never leave the server
  });

  it('runs a request through a leader to Twenty and back', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const lea = await c.signIn('lea@example.com');

    const join = await c.postForm(bea, `/groups/${SUPPER}/join`);
    expect(join.status).toBe(303);
    // Shown at once, before Twenty has it.
    expect((await c.getJson(bea, `/v1/groups/${SUPPER}`)).body['myStatus']).toBe('REQUESTED');
    expect((await c.postJson(bea, `/v1/groups/${SUPPER}/join`)).status).toBe(409); // already asked

    await c.work();
    expect(c.gateway.memberships.get(`${SUPPER}:${BEA}`)?.membership).toEqual({
      groupId: SUPPER,
      personId: BEA,
      status: 'REQUESTED',
      role: 'MEMBER',
    });
    const leader = (await c.getJson(lea, `/v1/groups/${SUPPER}`)).body;
    expect(leader['requests']).toEqual([{ personId: BEA, name: 'Bea B.' }]);
    const leaderPage = await (
      await c.req(`/groups/${SUPPER}`, { headers: { cookie: lea } })
    ).text();
    expect(leaderPage).toContain('Asking to join');

    expect(
      (await c.postForm(lea, `/groups/${SUPPER}/requests/${BEA}`, { decision: 'approve' })).status,
    ).toBe(303);
    await c.work();
    const inTwenty = c.gateway.memberships.get(`${SUPPER}:${BEA}`);
    expect(inTwenty?.membership.status).toBe('ACTIVE');
    expect(inTwenty?.joinedAt).toBe('2026-10-02');

    const now = (await c.getJson(bea, `/v1/groups/${SUPPER}`)).body;
    expect(now['myStatus']).toBe('ACTIVE');
    expect((now['members'] as { name: string }[]).map((m) => m.name)).toContain('Bea B.');
    const audit = await c.inT((x) =>
      x.query<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'group.%'`),
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['group.request_approved']);
  });

  it('lets a leader decline, and lets a member withdraw or leave', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const lea = await c.signIn('lea@example.com');
    const cy = await c.signIn('cy@example.com');

    await c.postJson(bea, `/v1/groups/${SUPPER}/join`);
    await c.work();
    expect(
      (await c.postJson(lea, `/v1/groups/${SUPPER}/requests/${BEA}`, { approve: false })).status,
    ).toBe(202);
    await c.work();
    expect(c.gateway.memberships.get(`${SUPPER}:${BEA}`)?.membership.status).toBe('LEFT');
    // After a "not now" they may ask again later.
    expect((await c.getJson(bea, `/v1/groups/${SUPPER}`)).body['canRequestToJoin']).toBe(true);

    expect((await c.postJson(cy, `/v1/groups/${SUPPER}/leave`)).status).toBe(202);
    await c.work();
    const after = (await c.getJson(cy, `/v1/groups/${SUPPER}`)).body;
    expect(after['myStatus']).toBe('LEFT');
    expect(after['members']).toBeNull();
    expect((await c.postJson(cy, `/v1/groups/${SUPPER}/leave`)).status).toBe(409);
  });

  it('lets only an active leader of that group decide, and only on real requests', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const cy = await c.signIn('cy@example.com');
    const lea = await c.signIn('lea@example.com');
    await c.postJson(bea, `/v1/groups/${SUPPER}/join`);
    await c.work();

    expect(
      (await c.postJson(cy, `/v1/groups/${SUPPER}/requests/${BEA}`, { approve: true })).status,
    ).toBe(403);
    expect(
      (await c.postJson(lea, `/v1/groups/${SUPPER}/requests/${CY}`, { approve: true })).status,
    ).toBe(404);
    expect(
      (await c.postJson(lea, `/v1/groups/${OPEN}/requests/${BEA}`, { approve: true })).status,
    ).toBe(403);
    expect(
      (await c.postJson(lea, `/v1/groups/${SUPPER}/requests/${BEA}`, { approve: 'yes' })).status,
    ).toBe(400);
  });

  it('never lets anyone ask to join a secret group from the portal', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const cy = await c.signIn('cy@example.com');
    expect((await c.postJson(bea, `/v1/groups/${RECOVERY}/join`)).status).toBe(404);
    expect((await c.getJson(cy, `/v1/groups/${RECOVERY}`)).body['canRequestToJoin']).toBe(false);
  });

  it('keeps groups to signed-in, confirmed members of the same church', async () => {
    const c = await setUp();
    const other = await portalChurch(db);
    await other.person(BEA, { firstName: 'Bea', emails: ['bea@example.com'] });
    await c.person('00000000-0000-4000-8000-0000000b0009', {
      emails: ['fam@example.com'],
      sharedEmail: true,
    });

    expect((await c.req('/v1/groups')).status).toBe(401);
    expect((await c.req('/groups')).status).toBe(303);
    const unconfirmed = await c.signIn('fam@example.com');
    expect((await c.getJson(unconfirmed, '/v1/groups')).status).toBe(403);
    expect((await c.req('/groups', { headers: { cookie: unconfirmed } })).status).toBe(403);

    const elsewhere = await other.signIn('bea@example.com');
    expect((await other.getJson(elsewhere, '/v1/groups')).body['groups']).toEqual([]);
    expect((await other.getJson(elsewhere, `/v1/groups/${SUPPER}`)).status).toBe(404);
  });

  it('refuses a join posted from another site', async () => {
    const c = await setUp();
    const bea = await c.signIn('bea@example.com');
    const res = await c.req(`/v1/groups/${SUPPER}/join`, {
      method: 'POST',
      headers: { cookie: bea, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    await c.work();
    expect(c.gateway.memberships.has(`${SUPPER}:${BEA}`)).toBe(false);
  });
});
