// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WebhookHint } from '@thefold/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import {
  pruneWebhookDeliveries,
  recordWebhookHint,
  takeRefetches,
} from '../src/db/webhookInbox.js';
import {
  upsertMembershipRead,
  upsertPersonRead,
  type PersonReadInput,
} from '../src/db/readModels.js';
import {
  asOwnerInTenant,
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!dbAvailable)('webhook inbox and read models', () => {
  let db: TestDb;
  let a: SeededTenant;
  let b: SeededTenant;
  beforeAll(async () => {
    db = await createTestDatabase();
    a = await seedTenant(db, 'inbox-a');
    b = await seedTenant(db, 'inbox-b');
  });
  afterAll(async () => {
    await db.drop();
  });
  const inA = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.appPool, a.id, fn);
  const hint = (over: Partial<WebhookHint> = {}): WebhookHint => ({
    tenantId: a.id,
    objectType: 'person',
    recordId: R1,
    action: 'updated',
    deliveryId: 'evt-1',
    receivedAt: 0,
    ...over,
  });

  describe('webhook hints', () => {
    it('drops exact redeliveries, coalesces changes to the same record, and queues other records separately', async () => {
      expect(await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'e1' })))).toBe('QUEUED');
      expect(await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'e1' })))).toBe('DUPLICATE');
      expect(await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'e2' })))).toBe('COALESCED');
      expect(await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'e3', recordId: R2 })))).toBe(
        'QUEUED',
      );
      const rows = await inA((c) =>
        c.query<{ record_id: string; hits: number }>(
          `SELECT record_id, hits FROM webhook_inbox WHERE status = 'PENDING' ORDER BY record_id`,
        ),
      );
      expect(rows.rows).toEqual([
        { record_id: R1, hits: 2 },
        { record_id: R2, hits: 1 },
      ]);
    });

    it('a change that arrives after a refetch was taken is not lost: it queues a fresh refetch', async () => {
      const taken = await inA((c) => takeRefetches(c, 10));
      expect(taken.map((t) => t.recordId).sort()).toEqual([R1, R2]);
      expect(taken.find((t) => t.recordId === R1)?.hits).toBe(2);
      expect(await inA((c) => takeRefetches(c, 10))).toEqual([]);
      expect(await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'e4' })))).toBe('QUEUED');
      expect((await inA((c) => takeRefetches(c, 10))).map((t) => t.recordId)).toEqual([R1]);
    });

    it('respects the batch limit and takes oldest first', async () => {
      const ids = [1, 2, 3].map((n) => `3333333${n}-3333-4333-8333-333333333333`);
      for (const [i, id] of ids.entries()) {
        await inA((c) => recordWebhookHint(c, hint({ deliveryId: `o${i}`, recordId: id })));
        await inA((c) =>
          c.query(
            `UPDATE webhook_inbox SET first_seen_at = now() + make_interval(secs => $2) WHERE record_id = $1`,
            [id, i],
          ),
        );
      }
      expect((await inA((c) => takeRefetches(c, 2))).map((t) => t.recordId)).toEqual([
        ids[0],
        ids[1],
      ]);
      expect((await inA((c) => takeRefetches(c, 2))).map((t) => t.recordId)).toEqual([ids[2]]);
    });

    it('forgets old delivery ids so the table stays small, and a redelivery after that is treated as new', async () => {
      await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'old-1', recordId: R2 })));
      // The app role cannot UPDATE deliveries (by design), so back-date the row as the owner.
      await asOwnerInTenant(db, a.id, (c) =>
        c.query(
          `UPDATE webhook_delivery SET received_at = now() - interval '10 days' WHERE delivery_id = 'old-1'`,
        ),
      );
      expect(await inA((c) => pruneWebhookDeliveries(c, 7))).toBeGreaterThanOrEqual(1);
      expect(
        await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'old-1', recordId: R2 }))),
      ).not.toBe('DUPLICATE');
    });

    it('delivery ids are scoped per tenant', async () => {
      expect(
        await inA((c) => recordWebhookHint(c, hint({ deliveryId: 'shared-id', recordId: R1 }))),
      ).not.toBe('DUPLICATE');
      expect(
        await withTenant(db.appPool, b.id, (c) =>
          recordWebhookHint(c, hint({ tenantId: b.id, deliveryId: 'shared-id' })),
        ),
      ).toBe('QUEUED');
    });
  });

  describe('person read model applies only newer data', () => {
    const person = (over: Partial<PersonReadInput> = {}): PersonReadInput => ({
      twentyPersonId: R1,
      twentyUpdatedAt: new Date('2026-09-01T10:00:00Z'),
      firstName: 'Sam',
      lastName: 'Rivera',
      emails: ['Sam@Example.com'],
      phones: [],
      isMinor: false,
      sharedEmail: false,
      householdId: null,
      lifecycleStage: 'CONNECTED',
      doNotContact: false,
      awayUntil: null,
      deletedAt: null,
      ...over,
    });
    const read = () =>
      inA((c) =>
        c.query<{
          first_name: string;
          emails: string[];
          lifecycle_stage: string;
          deleted_at: Date | null;
        }>(
          `SELECT first_name, emails, lifecycle_stage, deleted_at FROM person_read WHERE twenty_person_id = $1`,
          [R1],
        ),
      );

    it('inserts, then ignores stale and equal-timestamp updates, then applies newer ones', async () => {
      expect(await inA((c) => upsertPersonRead(c, person()))).toBe('APPLIED');
      expect((await read()).rows[0]).toMatchObject({
        first_name: 'Sam',
        emails: ['sam@example.com'],
      });

      expect(
        await inA((c) =>
          upsertPersonRead(
            c,
            person({ firstName: 'Older', twentyUpdatedAt: new Date('2026-08-01T00:00:00Z') }),
          ),
        ),
      ).toBe('STALE');
      expect(await inA((c) => upsertPersonRead(c, person({ firstName: 'Same time' })))).toBe(
        'STALE',
      );
      expect((await read()).rows[0]?.first_name).toBe('Sam');

      expect(
        await inA((c) =>
          upsertPersonRead(
            c,
            person({
              firstName: 'Samuel',
              lifecycleStage: 'SERVING',
              twentyUpdatedAt: new Date('2026-09-02T00:00:00Z'),
            }),
          ),
        ),
      ).toBe('APPLIED');
      expect((await read()).rows[0]).toMatchObject({
        first_name: 'Samuel',
        lifecycle_stage: 'SERVING',
      });
    });

    it('propagates deletion, and a late "undeleted" copy cannot resurrect a newer deletion', async () => {
      const deletedAt = new Date('2026-09-05T00:00:00Z');
      expect(
        await inA((c) => upsertPersonRead(c, person({ twentyUpdatedAt: deletedAt, deletedAt }))),
      ).toBe('APPLIED');
      expect(
        await inA((c) =>
          upsertPersonRead(c, person({ twentyUpdatedAt: new Date('2026-09-04T00:00:00Z') })),
        ),
      ).toBe('STALE');
      expect((await read()).rows[0]?.deleted_at).toEqual(deletedAt);
    });

    it('keeps tenants separate even for the same Twenty record id', async () => {
      await withTenant(db.appPool, b.id, (c) =>
        upsertPersonRead(c, person({ firstName: 'Other church' })),
      );
      expect((await read()).rows[0]?.first_name).not.toBe('Other church');
    });

    it('rejects an unknown lifecycle stage at the database', async () => {
      await expect(
        inA((c) => upsertPersonRead(c, person({ twentyPersonId: R2, lifecycleStage: 'VIP' }))),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('membership read model', () => {
    it('applies only newer data', async () => {
      const m = (over = {}) => ({
        twentyMembershipId: R2,
        twentyUpdatedAt: new Date('2026-09-01T00:00:00Z'),
        groupId: R1,
        personId: R2,
        role: 'MEMBER',
        status: 'ACTIVE',
        deletedAt: null,
        ...over,
      });
      expect(await inA((c) => upsertMembershipRead(c, m()))).toBe('APPLIED');
      expect(
        await inA((c) =>
          upsertMembershipRead(
            c,
            m({ status: 'LEFT', twentyUpdatedAt: new Date('2026-08-01T00:00:00Z') }),
          ),
        ),
      ).toBe('STALE');
      expect(
        await inA((c) =>
          upsertMembershipRead(
            c,
            m({ status: 'LEFT', twentyUpdatedAt: new Date('2026-09-09T00:00:00Z') }),
          ),
        ),
      ).toBe('APPLIED');
      const row = await inA((c) =>
        c.query<{ status: string }>(
          `SELECT status FROM membership_read WHERE twenty_membership_id = $1`,
          [R2],
        ),
      );
      expect(row.rows[0]?.status).toBe('LEFT');
    });
  });
});
