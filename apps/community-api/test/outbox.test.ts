// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OutboxJobInput } from '@thefold/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOutbox,
  completeOutbox,
  DEFAULT_BACKOFF,
  enqueueOutbox,
  failOutbox,
} from '../src/db/outbox.js';
import { withTenant } from '../src/db/tenant.js';
import {
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';

const person = '3f0c1b9e-8a44-4b62-9d6e-1c2b3a4d5e6f';
const job = (key: string): OutboxJobInput => ({
  kind: 'twenty.createFollowUp',
  idempotencyKey: key,
  followUp: {
    kind: 'WELCOME',
    title: 'Welcome',
    subjectPersonId: person,
    ownerPersonId: null,
    dueAt: 1,
  },
});

describe.skipIf(!dbAvailable)('outbox', () => {
  let db: TestDb;
  let a: SeededTenant;
  let b: SeededTenant;
  beforeAll(async () => {
    db = await createTestDatabase();
    a = await seedTenant(db, 'outbox-a');
    b = await seedTenant(db, 'outbox-b');
  });
  afterAll(async () => {
    await db.drop();
  });
  const inA = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.appPool, a.id, fn);

  it('enqueueing the same intent twice creates one job', async () => {
    const first = await inA((c) => enqueueOutbox(c, job('dup-1')));
    const second = await inA((c) => enqueueOutbox(c, job('dup-1')));
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ id: null, duplicate: true });
    const n = await inA((c) => c.query(`SELECT 1 FROM outbox WHERE idempotency_key = 'dup-1'`));
    expect(n.rowCount).toBe(1);
  });

  it('rejects an invalid job before it reaches the database', async () => {
    await expect(
      inA((c) =>
        enqueueOutbox(c, {
          kind: 'twenty.createFollowUp',
          idempotencyKey: 'bad',
        } as unknown as OutboxJobInput),
      ),
    ).rejects.toThrow();
  });

  it('claims due jobs, leases them, and does not hand them out twice', async () => {
    await inA((c) => enqueueOutbox(c, job('claim-1')));
    const first = await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }));
    const mine = first.find((j) => j.idempotencyKey === 'claim-1');
    expect(mine).toMatchObject({ attempts: 1, job: { kind: 'twenty.createFollowUp' } });
    const again = await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }));
    expect(again.find((j) => j.idempotencyKey === 'claim-1')).toBeUndefined();
  });

  it('recovers a job whose worker died, once the lease expires', async () => {
    await inA((c) => enqueueOutbox(c, job('crash-1')));
    await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }));
    await inA((c) =>
      c.query(
        `UPDATE outbox SET locked_until = now() - interval '1 second' WHERE idempotency_key = 'crash-1'`,
      ),
    );
    const reclaimed = await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }));
    expect(reclaimed.find((j) => j.idempotencyKey === 'crash-1')?.attempts).toBe(2);
  });

  it('completes a job once, and never claims it again', async () => {
    await inA((c) => enqueueOutbox(c, job('done-1')));
    const claimed = (await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }))).find(
      (j) => j.idempotencyKey === 'done-1',
    );
    expect(await inA((c) => completeOutbox(c, (claimed as { id: string }).id))).toBe(true);
    expect(await inA((c) => completeOutbox(c, (claimed as { id: string }).id))).toBe(false); // not IN_FLIGHT any more
    const later = await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }));
    expect(later.find((j) => j.idempotencyKey === 'done-1')).toBeUndefined();
  });

  it('retries with exponential backoff, capped, and parks the job as DEAD after the last attempt', async () => {
    await inA((c) => enqueueOutbox(c, job('fail-1')));
    const policy = { baseSeconds: 30, capSeconds: 100, maxAttempts: 4 };
    const seconds: number[] = [];
    let last: Awaited<ReturnType<typeof failOutbox>> = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await inA((c) =>
        c.query(`UPDATE outbox SET next_attempt_at = now() WHERE idempotency_key = 'fail-1'`),
      );
      const claimed = (await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }))).find(
        (j) => j.idempotencyKey === 'fail-1',
      );
      expect(claimed?.attempts).toBe(attempt);
      last = await inA((c) =>
        failOutbox(c, (claimed as { id: string }).id, `boom ${attempt}`, policy),
      );
      const wait = await inA((c) =>
        c.query<{ s: number }>(
          `SELECT extract(epoch FROM next_attempt_at - now())::float8 AS s FROM outbox WHERE idempotency_key = 'fail-1'`,
        ),
      );
      seconds.push(Math.round((wait.rows[0] as { s: number }).s));
    }
    // 30, 60, then 120 capped to 100; the 4th failure is terminal.
    expect(seconds.slice(0, 3).map((s) => Math.round(s / 5) * 5)).toEqual([30, 60, 100]);
    expect(last?.status).toBe('DEAD');
    const row = await inA((c) =>
      c.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM outbox WHERE idempotency_key = 'fail-1'`,
      ),
    );
    expect(row.rows[0]).toEqual({ status: 'DEAD', last_error: 'boom 4' });
    await inA((c) =>
      c.query(`UPDATE outbox SET next_attempt_at = now() WHERE idempotency_key = 'fail-1'`),
    );
    expect(
      (await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }))).find(
        (j) => j.idempotencyKey === 'fail-1',
      ),
    ).toBeUndefined();
  });

  it('exposes the default policy', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseSeconds: 30, capSeconds: 21_600, maxAttempts: 8 });
  });

  it('two workers polling at once get disjoint jobs and never block each other (SKIP LOCKED)', async () => {
    for (let i = 0; i < 10; i++) await inA((c) => enqueueOutbox(c, job(`par-${i}`)));
    let releaseFirst!: () => void;
    const hold = new Promise<void>((r) => (releaseFirst = r));
    const firstHasClaimed = new Promise<string[]>((resolve) => {
      void withTenant(db.appPool, a.id, async (c) => {
        const got = await claimOutbox(c, { limit: 5, leaseSeconds: 60 });
        resolve(got.map((j) => j.idempotencyKey));
        await hold; // keep the first transaction (and its row locks) open
      });
    });
    const first = await firstHasClaimed;
    const second = (await inA((c) => claimOutbox(c, { limit: 100, leaseSeconds: 60 }))).map(
      (j) => j.idempotencyKey,
    );
    releaseFirst();
    const par = (keys: string[]) => keys.filter((k) => k.startsWith('par-'));
    expect(par(first)).toHaveLength(5);
    expect(par(second)).toHaveLength(5);
    expect(par(first).filter((k) => par(second).includes(k))).toEqual([]);
  });

  it('a tenant never claims another tenant’s jobs', async () => {
    await withTenant(db.appPool, b.id, (c) => enqueueOutbox(c, job('only-b')));
    const claimedByA = await inA((c) => claimOutbox(c, { limit: 1000, leaseSeconds: 60 }));
    expect(claimedByA.find((j) => j.idempotencyKey === 'only-b')).toBeUndefined();
    const claimedByB = await withTenant(db.appPool, b.id, (c) =>
      claimOutbox(c, { limit: 1000, leaseSeconds: 60 }),
    );
    expect(claimedByB.map((j) => j.idempotencyKey)).toEqual(['only-b']);
  });
});
