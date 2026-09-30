// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionCardInput } from '@thefold/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { submitConnectionCard } from '../src/intake/connectionCard.js';
import { withTenant } from '../src/db/tenant.js';
import { processOutbox } from '../src/workers/outbox.js';
import {
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';
import { MemoryGateway } from './helpers/memoryGateway.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-27T15:00:00Z'); // a Sunday
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const W3 = '00000000-0000-4000-8000-0000000000a3';

const card = (over: Partial<ConnectionCardInput> = {}): ConnectionCardInput => ({
  firstName: 'Sam',
  lastName: 'Rivera',
  email: 'sam@example.com',
  contactConsent: { byEmail: true, byPhone: false, byText: false },
  ...over,
});

describe.skipIf(!dbAvailable)(
  'vertical slice: connection card → guest → welcomer → follow-ups',
  () => {
    let db: TestDb;
    let n = 0;
    let t: SeededTenant;
    let gw: MemoryGateway;

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db.drop();
    });
    // A fresh church per test keeps every scenario independent.
    beforeEach(async () => {
      t = await seedTenant(db, `slice-${++n}`);
      gw = new MemoryGateway();
    });

    const inT = <R>(fn: Parameters<typeof withTenant<R>>[2]) => withTenant(db.appPool, t.id, fn);
    const addWelcomers = (...ids: string[]) =>
      inT(async (c) => {
        for (const id of ids)
          await c.query(
            `INSERT INTO welcomer_load (tenant_id, twenty_person_id) VALUES (fold_current_tenant(), $1)`,
            [id],
          );
      });
    const submit = (c: ConnectionCardInput, at = NOW) =>
      inT((client) => submitConnectionCard(client, c, at));
    /** Runs the worker until nothing is due (jobs enqueue follow-on jobs). */
    async function drain(gateway = gw, now = NOW) {
      const total = { done: 0, retried: 0, dead: 0 };
      for (let i = 0; i < 8; i++) {
        const r = await processOutbox(db.appPool, t.id, gateway, { now });
        total.done += r.done;
        total.retried += r.retried;
        total.dead += r.dead;
        if (r.done + r.retried + r.dead === 0) break;
      }
      return total;
    }
    const load = (id: string) =>
      inT((c) =>
        c.query<{ open_count: number; assigned_last_30d: number }>(
          `SELECT open_count, assigned_last_30d FROM welcomer_load WHERE twenty_person_id = $1`,
          [id],
        ),
      ).then((r) => r.rows[0]);
    const outboxStatuses = () =>
      inT((c) => c.query<{ status: string }>(`SELECT DISTINCT status FROM outbox`)).then((r) =>
        r.rows.map((x) => x.status),
      );
    const auditActions = () =>
      inT((c) => c.query<{ action: string }>(`SELECT action FROM audit_log ORDER BY at, id`)).then(
        (r) => r.rows.map((x) => x.action),
      );

    it('turns a card into a guest, an attendance and three follow-ups with ONE owner, due 48h / 7d / 21d after the visit', async () => {
      await addWelcomers(W1, W2, W3);
      expect(await submit(card())).toMatchObject({ status: 'QUEUED', match: 'NEW' });
      const report = await drain();
      expect(report).toMatchObject({ dead: 0, retried: 0 });

      expect(gw.guests.size).toBe(1);
      const followUps = [...gw.followUps.values()].map((f) => f.followUp);
      expect(followUps.map((f) => f.kind).sort()).toEqual(['FOLLOW_UP', 'GROUP_INTRO', 'WELCOME']);
      const owners = new Set(followUps.map((f) => f.ownerPersonId));
      expect(owners.size).toBe(1);
      const owner = [...owners][0] as string;
      expect([W1, W2, W3]).toContain(owner);
      const due = Object.fromEntries(
        followUps.map((f) => [f.kind, (f.dueAt - NOW.getTime()) / HOUR]),
      );
      expect(due).toEqual({ WELCOME: 48, GROUP_INTRO: 168, FOLLOW_UP: 504 });
      expect(gw.attendances.size).toBe(1);
      expect([...gw.attendances.values()][0]).toMatchObject({
        kind: 'SERVICE',
        source: 'CHECKIN',
        date: '2026-09-27',
      });

      expect(await load(owner)).toEqual({ open_count: 1, assigned_last_30d: 1 });
      const notified = await inT((c) =>
        c.query(
          `SELECT 1 FROM notification WHERE recipient_person_id = $1 AND type = 'welcome_assigned'`,
          [owner],
        ),
      );
      expect(notified.rowCount).toBe(1);
      expect(await outboxStatuses()).toEqual(['DONE']);
    });

    it('a double-tapped Submit or a refresh creates one guest, not two', async () => {
      await addWelcomers(W1);
      expect((await submit(card())).status).toBe('QUEUED');
      expect((await submit(card())).status).toBe('DUPLICATE');
      expect((await submit(card({ email: ' SAM@Example.com ', firstName: 'sam' }))).status).toBe(
        'DUPLICATE',
      ); // same person, formatted differently
      await drain();
      expect(gw.guests.size).toBe(1);
      expect(gw.followUps.size).toBe(3);
      expect((await load(W1))?.open_count).toBe(1);
    });

    it('spreads six guests evenly over three welcomers', async () => {
      await addWelcomers(W1, W2, W3);
      for (let i = 0; i < 6; i++)
        await submit(card({ firstName: `Guest${i}`, email: `g${i}@example.com` }));
      await drain();
      expect(gw.followUpsOfKind('WELCOME')).toHaveLength(6);
      const counts = await Promise.all([W1, W2, W3].map(async (w) => (await load(w))?.open_count));
      expect(counts).toEqual([2, 2, 2]);
    });

    it('never gives a welcomer more than their limit, skips those who are away, and sends the rest to the pool', async () => {
      await addWelcomers(W1, W2, W3);
      await inT(async (c) => {
        await c.query(`UPDATE welcomer_load SET max_open = 1 WHERE twenty_person_id = $1`, [W1]);
        await c.query(
          `UPDATE welcomer_load SET away_until = '2026-10-04' WHERE twenty_person_id = $1`,
          [W2],
        );
        await c.query(`UPDATE welcomer_load SET max_open = 1 WHERE twenty_person_id = $1`, [W3]);
      });
      for (let i = 0; i < 4; i++)
        await submit(card({ firstName: `G${i}`, email: `g${i}@example.com` }));
      await drain();
      const welcomes = gw.followUpsOfKind('WELCOME');
      expect(
        welcomes
          .map((f) => f.ownerPersonId)
          .filter(Boolean)
          .sort(),
      ).toEqual([W1, W3]); // W2 away; W1 and W3 take one each
      expect(welcomes.filter((f) => f.ownerPersonId === null)).toHaveLength(2); // the rest wait for a person
      expect((await auditActions()).filter((a) => a === 'WELCOMER_POOL_FALLBACK')).toHaveLength(2);
    });

    it('with no welcomers at all, the guest still gets follow-ups, unassigned, and the reason is on record', async () => {
      await submit(card());
      await drain();
      expect(gw.followUps.size).toBe(3);
      expect([...gw.followUps.values()].every((f) => f.followUp.ownerPersonId === null)).toBe(true);
      expect(await auditActions()).toContain('WELCOMER_POOL_FALLBACK');
    });

    it('welcomes a family once, through one person; the children are not the subject of any follow-up', async () => {
      await addWelcomers(W1, W2);
      await submit(
        card({
          firstName: 'Ana',
          lastName: 'Lopez',
          email: 'ana@example.com',
          householdMembers: [
            { firstName: 'Diego', isChild: false },
            { firstName: 'Lucia', isChild: true },
          ],
        }),
      );
      await drain();
      const g = [...gw.guests.values()][0];
      expect(g?.result.personIds).toHaveLength(3);
      expect(gw.followUpsOfKind('WELCOME')).toHaveLength(1);
      const subjects = new Set([...gw.followUps.values()].map((f) => f.followUp.subjectPersonId));
      expect([...subjects]).toEqual([g?.result.primaryPersonId]);
      expect([...gw.followUps.values()][0]?.followUp.contextSummary).toBe(
        'First-time guest, came with family',
      );
      // The household is now known locally, children marked as minors, so they are never matched or contacted.
      const kids = await inT((c) =>
        c.query<{ first_name: string; is_minor: boolean; do_not_contact: boolean }>(
          `SELECT first_name, is_minor, do_not_contact FROM person_read WHERE first_name IN ('Diego','Lucia') ORDER BY first_name`,
        ),
      );
      expect(kids.rows).toEqual([
        { first_name: 'Diego', is_minor: false, do_not_contact: false },
        { first_name: 'Lucia', is_minor: true, do_not_contact: true },
      ]);
    });

    it('respects a guest who did not agree to be contacted: they are recorded, nobody is asked to call', async () => {
      await addWelcomers(W1);
      await submit(card({ contactConsent: { byEmail: false, byPhone: false, byText: false } }));
      await drain();
      expect(gw.guests.size).toBe(1);
      expect(gw.attendances.size).toBe(1);
      expect(gw.followUps.size).toBe(0);
      expect(await load(W1)).toEqual({ open_count: 0, assigned_last_30d: 0 });
      expect(await auditActions()).toContain('WELCOME_SKIPPED_NO_CONSENT');
    });

    it('recognises someone already in the church and does not treat them as a new guest', async () => {
      await addWelcomers(W1);
      const known = '00000000-0000-4000-8000-0000000000c1';
      await inT((c) =>
        c.query(
          `INSERT INTO person_read (tenant_id, twenty_person_id, twenty_updated_at, first_name, last_name, emails, lifecycle_stage)
         VALUES (fold_current_tenant(), $1, now(), 'Sam', 'Rivera', ARRAY['sam@example.com'], 'CONNECTED')`,
          [known],
        ),
      );
      expect(await submit(card())).toMatchObject({ status: 'QUEUED', match: 'EXISTING' });
      await drain();
      expect([...gw.guests.values()][0]?.result.primaryPersonId).toBe(known); // attached, not duplicated
      expect(gw.followUps.size).toBe(0); // no welcome sequence for a member
      expect([...gw.attendances.values()]).toHaveLength(1);
    });

    it('a guest who comes back two days later is matched, not duplicated, and not welcomed twice', async () => {
      await addWelcomers(W1, W2);
      await submit(card());
      await drain();
      const first = [...gw.guests.values()][0]?.result.primaryPersonId;

      const later = new Date(NOW.getTime() + 2 * 24 * HOUR); // the webhook that would sync them has NOT arrived
      expect(await submit(card(), later)).toMatchObject({ status: 'QUEUED', match: 'EXISTING' });
      await drain(gw, later);

      expect(gw.guests.size).toBe(2); // two card submissions...
      const primaries = new Set([...gw.guests.values()].map((g) => g.result.primaryPersonId));
      expect(primaries).toEqual(new Set([first])); // ...one person
      expect(gw.followUpsOfKind('WELCOME')).toHaveLength(1);
      expect(gw.attendances.size).toBe(2); // but both visits are attendance
    });

    it('an ambiguous match still creates the guest (so the follow-up is never lost) and flags it for staff to merge', async () => {
      await addWelcomers(W1);
      await inT((c) =>
        c.query(
          `INSERT INTO person_read (tenant_id, twenty_person_id, twenty_updated_at, first_name, last_name, emails, shared_email, lifecycle_stage)
         VALUES (fold_current_tenant(), gen_random_uuid(), now(), 'Sam', 'Rivera', ARRAY['family@example.com'], true, 'CONNECTED')`,
        ),
      );
      expect(await submit(card({ email: 'family@example.com' }))).toMatchObject({
        match: 'NEEDS_REVIEW',
      });
      await drain();
      const g = [...gw.guests.values()][0];
      expect(g?.input.dedupeStatus).toBe('NEEDS_REVIEW');
      expect(g?.input.existingPersonId).toBeNull();
      expect(gw.followUpsOfKind('WELCOME')).toHaveLength(1);
    });

    describe('when Twenty misbehaves', () => {
      it('retries a transient outage with backoff and still ends with exactly one of everything', async () => {
        await addWelcomers(W1);
        gw.failing('createFollowUp', 2);
        await submit(card());
        const first = await drain();
        expect(first.retried).toBeGreaterThan(0);
        expect(gw.followUps.size).toBeLessThan(3);

        // Time passes: make the backed-off jobs due again.
        for (let i = 0; i < 4; i++) {
          await inT((c) =>
            c.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`),
          );
          await drain();
        }
        expect(gw.followUps.size).toBe(3);
        expect(gw.attendances.size).toBe(1);
        expect(await outboxStatuses()).toEqual(['DONE']);
        expect((await load(W1))?.open_count).toBe(1); // assigned once, however many retries
      });

      it('a lost response after Twenty applied the guest does not create a second guest or assign a second welcomer', async () => {
        await addWelcomers(W1, W2);
        gw.failing('upsertGuest', 1, 'after');
        await submit(card());
        const first = await drain();
        expect(first.retried).toBe(1);
        expect(gw.guests.size).toBe(1); // applied...
        expect(gw.followUps.size).toBe(0); // ...but nothing downstream happened yet (same transaction as "done")
        expect((await load(W1))?.open_count).toBe(0);

        await inT((c) =>
          c.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`),
        );
        await drain();
        expect(gw.guests.size).toBe(1);
        expect(gw.followUpsOfKind('WELCOME')).toHaveLength(1);
        const loads = (await load(W1))!.open_count + (await load(W2))!.open_count;
        expect(loads).toBe(1);
      });

      it('gives up after the last attempt and parks the job as dead for a human to look at', async () => {
        await submit(card());
        gw.failing('upsertGuest', 99);
        for (let i = 0; i < 10; i++) {
          await inT((c) =>
            c.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'PENDING'`),
          );
          await drain();
        }
        const dead = await inT((c) =>
          c.query<{ last_error: string }>(`SELECT last_error FROM outbox WHERE status = 'DEAD'`),
        );
        expect(dead.rowCount).toBe(1);
        expect(dead.rows[0]?.last_error).toMatch(/simulated Twenty outage/);
      });
    });

    it('one church’s worker never touches another church’s jobs or welcomers', async () => {
      const other = await seedTenant(db, `slice-other-${n}`);
      await addWelcomers(W1);
      await withTenant(db.appPool, other.id, (c) =>
        c.query(
          `INSERT INTO welcomer_load (tenant_id, twenty_person_id) VALUES (fold_current_tenant(), $1)`,
          [W2],
        ),
      );
      await submit(card());
      const otherGw = new MemoryGateway();
      await processOutbox(db.appPool, other.id, otherGw, { now: NOW });
      expect(otherGw.calls).toEqual([]);
      await drain();
      expect([...gw.followUps.values()].every((f) => f.followUp.ownerPersonId === W1)).toBe(true);
    });

    it('rejects a card from a bot and stores neither the honeypot nor the captcha token', async () => {
      await expect(submit(card({ website: 'http://spam.example' }))).rejects.toThrow();
      await submit(card({ captchaToken: 'secret-token-123' }));
      const stored = await inT((c) =>
        c.query<{ payload: unknown }>(
          `SELECT payload FROM outbox WHERE kind = 'twenty.upsertGuest'`,
        ),
      );
      const text = JSON.stringify(stored.rows[0]?.payload);
      expect(text).not.toContain('secret-token-123');
      expect(text).not.toContain('captchaToken');
      expect(text).not.toContain('website');
    });
  },
);
