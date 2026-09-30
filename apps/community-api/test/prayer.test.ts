// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { StaffRole } from '@thefold/core';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countCareViews,
  createPrayerRequest,
  expirePrayerRequests,
  loadViewer,
  PRAYER_LIFETIME_DAYS,
  readPrayerRequest,
  type CreatePrayerInput,
} from '../src/care/prayer.js';
import { getCurrentDataKey } from '../src/crypto/tenantKeys.js';
import { withTenant } from '../src/db/tenant.js';
import {
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHOR = pid(1);
const NURSE = pid(2); // care_team, assigned
const OTHER_NURSE = pid(3); // care_team, not assigned
const PASTOR = pid(4);
const MEMBER = pid(5); // verified adult, no groups
const GROUP_MEMBER = pid(6); // verified adult in GROUP
const OUTSIDER = pid(7); // not verified
const MINOR = pid(8);
const GROUP = pid(100);

const SECRET = 'My marriage is in trouble and I am afraid.';

describe.skipIf(!dbAvailable)('prayer requests (ADR 0004)', () => {
  let db: TestDb;
  let a: SeededTenant;
  let b: SeededTenant;
  const kek = randomBytes(32);
  const inA = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(db.appPool, a.id, fn);

  async function seedPerson(
    c: PoolClient,
    id: string,
    opts: { minor?: boolean; verified?: boolean; roles?: StaffRole[]; group?: string } = {},
  ) {
    await c.query(
      `INSERT INTO person_read (tenant_id, twenty_person_id, twenty_updated_at, first_name, is_minor) VALUES (fold_current_tenant(), $1, now(), 'P', $2)`,
      [id, opts.minor ?? false],
    );
    if (opts.verified) {
      const acct = await c.query<{ id: string }>(
        `INSERT INTO portal_account (tenant_id, email) VALUES (fold_current_tenant(), $1) RETURNING id`,
        [`p${id.slice(-3)}@example.com`],
      );
      await c.query(
        `INSERT INTO person_link (tenant_id, account_id, twenty_person_id, status, method, confirmed_at)
         VALUES (fold_current_tenant(), $1, $2, 'VERIFIED', 'magic_link', now())`,
        [acct.rows[0]?.id, id],
      );
    }
    for (const role of opts.roles ?? []) {
      await c.query(
        `INSERT INTO staff_role_assignment (tenant_id, twenty_person_id, role) VALUES (fold_current_tenant(), $1, $2)`,
        [id, role],
      );
    }
    if (opts.group) {
      await c.query(
        `INSERT INTO membership_read (tenant_id, twenty_membership_id, twenty_updated_at, group_id, person_id) VALUES (fold_current_tenant(), gen_random_uuid(), now(), $1, $2)`,
        [opts.group, id],
      );
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    a = await seedTenant(db, 'prayer-a');
    b = await seedTenant(db, 'prayer-b');
    await inA(async (c) => {
      await seedPerson(c, AUTHOR, { verified: true });
      await seedPerson(c, NURSE, { verified: true, roles: ['care_team'] });
      await seedPerson(c, OTHER_NURSE, { verified: true, roles: ['care_team'] });
      await seedPerson(c, PASTOR, { verified: true, roles: ['pastor'] });
      await seedPerson(c, MEMBER, { verified: true });
      await seedPerson(c, GROUP_MEMBER, { verified: true, group: GROUP });
      await seedPerson(c, OUTSIDER);
      await seedPerson(c, MINOR, { minor: true, verified: true }); // even "verified", a minor is never a member
    });
  });
  afterAll(async () => {
    await db.drop();
  });

  const create = (over: Partial<CreatePrayerInput> = {}) =>
    inA((c) =>
      createPrayerRequest(c, kek, {
        body: SECRET,
        tier: 'CHURCH',
        anonymousToCommunity: false,
        aboutSomeoneElse: false,
        followUpWanted: false,
        consentVersion: '2026-09',
        authorPersonId: AUTHOR,
        now: new Date(),
        ...over,
      }),
    );
  const read = (viewerId: string, requestId: string, ctx: { breakGlassReason?: string } = {}) =>
    inA(async (c) => readPrayerRequest(c, kek, await loadViewer(c, viewerId), requestId, ctx));
  const auditRows = () =>
    inA((c) =>
      c.query<{
        action: string;
        actor_person_id: string;
        via: string | null;
        reason: string | null;
      }>(`SELECT action, actor_person_id, via, reason FROM audit_log ORDER BY at, id`),
    );

  it('stores only ciphertext: the text is not in the row, and the row is bound to its own id', async () => {
    const { id } = await create();
    const raw = await inA((c) =>
      c.query<{ body_ciphertext: Buffer }>(
        `SELECT body_ciphertext FROM prayer_request WHERE id = $1`,
        [id],
      ),
    );
    const blob = raw.rows[0]?.body_ciphertext as Buffer;
    expect(blob.includes(Buffer.from(SECRET))).toBe(false);

    // Moving a ciphertext onto a different row makes it unreadable (AAD binds it to its record id).
    const other = await create({ body: 'a different request' });
    await inA((c) =>
      c.query(`UPDATE prayer_request SET body_ciphertext = $1 WHERE id = $2`, [blob, other.id]),
    );
    await expect(read(MEMBER, other.id)).rejects.toThrow('Decryption failed');
    expect((await read(MEMBER, id)) as { body: string }).toMatchObject({
      allowed: true,
      body: SECRET,
    });
  });

  it('the connection between a request and Twenty carries no text: only an opaque reference', async () => {
    const { id, careRequestQueued } = await create({ tier: 'CARE_ONLY', followUpWanted: true });
    expect(careRequestQueued).toBe(true);
    const jobs = await inA((c) =>
      c.query<{ payload: unknown }>(`SELECT payload FROM outbox WHERE idempotency_key = $1`, [
        `care:prayer:${id}`,
      ]),
    );
    expect(jobs.rowCount).toBe(1);
    const text = JSON.stringify(jobs.rows[0]?.payload);
    expect(text).not.toContain('marriage');
    expect(text).toContain(id); // communityRef
    expect(JSON.parse(text)).toMatchObject({
      kind: 'twenty.createCareRequest',
      careRequest: { category: 'PRAYER', communityRef: id },
    });
  });

  it('records consent, and no care follow-up is queued for an ordinary church-wide request', async () => {
    const { id, careRequestQueued } = await create();
    expect(careRequestQueued).toBe(false);
    const queued = await inA((c) =>
      c.query(`SELECT 1 FROM outbox WHERE idempotency_key = $1`, [`care:prayer:${id}`]),
    );
    expect(queued.rowCount).toBe(0);
    const consent = await inA((c) =>
      c.query(`SELECT version FROM consent_log WHERE person_id = $1 AND kind = 'prayer_request'`, [
        AUTHOR,
      ]),
    );
    expect(consent.rowCount).toBeGreaterThan(0);
    expect(consent.rows[0]).toEqual({ version: '2026-09' });
  });

  describe('CHURCH tier', () => {
    it('verified adult members can read it; everyone else cannot', async () => {
      const { id } = await create();
      expect(await read(MEMBER, id)).toMatchObject({
        allowed: true,
        body: SECRET,
        authorPersonId: AUTHOR,
      });
      expect(await read(GROUP_MEMBER, id)).toMatchObject({ allowed: true });
      expect(await read(OUTSIDER, id)).toEqual({ allowed: false, reason: 'NOT_A_MEMBER' });
      expect(await read(MINOR, id)).toEqual({ allowed: false, reason: 'NOT_A_MEMBER' });
    });

    it('hides an anonymous author from members but not from the author', async () => {
      const { id } = await create({ anonymousToCommunity: true });
      expect(await read(MEMBER, id)).toMatchObject({ allowed: true, authorPersonId: null });
      expect(await read(AUTHOR, id)).toMatchObject({ allowed: true, authorPersonId: AUTHOR });
    });

    it('no audit rows are written for ordinary community reads', async () => {
      const before = (await auditRows()).rows.length;
      const { id } = await create();
      await read(MEMBER, id);
      await read(OUTSIDER, id);
      expect((await auditRows()).rows.length).toBe(before);
    });
  });

  describe('GROUP tier', () => {
    it('is visible only to active members of that group', async () => {
      const { id } = await create({ tier: 'GROUP', groupId: GROUP });
      expect(await read(GROUP_MEMBER, id)).toMatchObject({ allowed: true, body: SECRET });
      expect(await read(MEMBER, id)).toEqual({ allowed: false, reason: 'NOT_IN_GROUP' });
      expect(await read(OUTSIDER, id)).toEqual({ allowed: false, reason: 'NOT_A_MEMBER' });
    });

    it('stops being visible when a member leaves the group', async () => {
      const { id } = await create({ tier: 'GROUP', groupId: GROUP });
      await inA((c) =>
        c.query(`UPDATE membership_read SET status = 'LEFT' WHERE person_id = $1`, [GROUP_MEMBER]),
      );
      expect(await read(GROUP_MEMBER, id)).toEqual({ allowed: false, reason: 'NOT_IN_GROUP' });
      await inA((c) =>
        c.query(`UPDATE membership_read SET status = 'ACTIVE' WHERE person_id = $1`, [
          GROUP_MEMBER,
        ]),
      );
    });
  });

  describe('CARE_ONLY tier', () => {
    let id: string;
    beforeAll(async () => {
      id = (await create({ tier: 'CARE_ONLY', followUpWanted: true })).id;
      await inA((c) =>
        c.query(`UPDATE prayer_request SET assigned_care_owner_id = $1 WHERE id = $2`, [NURSE, id]),
      );
    });

    it('is invisible to the congregation, and their attempts leave no trace (nothing to leak)', async () => {
      const before = (await auditRows()).rows.length;
      expect(await read(MEMBER, id)).toEqual({ allowed: false, reason: 'NOT_AUTHORIZED' });
      expect(await read(GROUP_MEMBER, id)).toEqual({ allowed: false, reason: 'NOT_AUTHORIZED' });
      expect((await auditRows()).rows.length).toBe(before);
    });

    it('the assigned care-team member can read it, and the read is audited', async () => {
      expect(await read(NURSE, id)).toMatchObject({
        allowed: true,
        body: SECRET,
        authorPersonId: AUTHOR,
      });
      const last = (await auditRows()).rows.at(-1);
      expect(last).toMatchObject({
        action: 'PRAYER_READ',
        actor_person_id: NURSE,
        via: 'ASSIGNED_CARE',
      });
    });

    it('an unassigned care-team member is refused, and the attempt is audited', async () => {
      expect(await read(OTHER_NURSE, id)).toEqual({ allowed: false, reason: 'NOT_AUTHORIZED' });
      expect((await auditRows()).rows.at(-1)).toMatchObject({
        action: 'PRAYER_READ_DENIED',
        actor_person_id: OTHER_NURSE,
      });
    });

    it('a pastor needs a written reason (break-glass), which is recorded', async () => {
      expect(await read(PASTOR, id)).toEqual({ allowed: false, reason: 'NOT_AUTHORIZED' });
      expect((await auditRows()).rows.at(-1)).toMatchObject({
        action: 'PRAYER_READ_DENIED',
        actor_person_id: PASTOR,
      });
      const reason = 'Family emergency; contacting spouse';
      expect(await read(PASTOR, id, { breakGlassReason: reason })).toMatchObject({
        allowed: true,
        body: SECRET,
      });
      expect((await auditRows()).rows.at(-1)).toMatchObject({
        action: 'PRAYER_READ',
        via: 'PASTOR_BREAK_GLASS',
        reason,
      });
    });

    it('the author sees only a count of how many different care-team members opened it', async () => {
      await read(NURSE, id); // second read by the same person
      expect(await inA((c) => countCareViews(c, id))).toBe(2); // NURSE and PASTOR, not 3 reads
    });
  });

  describe('lifecycle', () => {
    it('requests expire after 90 days and leave the congregation’s view but not the author’s', async () => {
      const longAgo = new Date(Date.now() - (PRAYER_LIFETIME_DAYS + 1) * 86_400_000);
      const { id } = await create({ now: longAgo });
      expect(await read(MEMBER, id)).toMatchObject({ allowed: true }); // not yet swept
      const expired = await inA((c) => expirePrayerRequests(c, new Date()));
      expect(expired).toContain(id);
      expect(await read(MEMBER, id)).toEqual({ allowed: false, reason: 'NOT_ACTIVE' });
      expect(await read(AUTHOR, id)).toMatchObject({ allowed: true, status: 'EXPIRED' });
    });

    it('does not expire recent requests', async () => {
      const { id } = await create();
      expect(await inA((c) => expirePrayerRequests(c, new Date()))).not.toContain(id);
    });

    it('reports an unknown id exactly like any other refusal, never as an error', async () => {
      expect(await read(MEMBER, pid(9999))).toEqual({ allowed: false, reason: 'NOT_FOUND' });
    });
  });

  it('another church can never read this church’s requests, whatever role its people hold', async () => {
    const { id } = await create();
    const other = await withTenant(db.appPool, b.id, async (c) => {
      await c.query(
        `INSERT INTO staff_role_assignment (tenant_id, twenty_person_id, role) VALUES (fold_current_tenant(), $1, 'pastor')`,
        [PASTOR],
      );
      return readPrayerRequest(c, kek, await loadViewer(c, PASTOR), id, {
        breakGlassReason: 'I am a pastor at another church',
      });
    });
    expect(other).toEqual({ allowed: false, reason: 'NOT_FOUND' });
  });

  it('a tenant’s data key is created once, wrapped, and never stored in the clear', async () => {
    const key = await inA((c) => getCurrentDataKey(c, kek));
    expect(key).toMatchObject({ version: 1 });
    const stored = await inA((c) =>
      c.query<{ wrapped: Buffer }>(`SELECT wrapped FROM tenant_secret WHERE name = 'data_key'`),
    );
    expect(stored.rowCount).toBe(1);
    expect((stored.rows[0]?.wrapped as Buffer).includes(key.dek)).toBe(false);
    const again = await inA((c) => getCurrentDataKey(c, kek));
    expect(again.dek.equals(key.dek)).toBe(true);
    await expect(inA((c) => getCurrentDataKey(c, randomBytes(32)))).rejects.toThrow(); // wrong KEK cannot unwrap
  });
});
