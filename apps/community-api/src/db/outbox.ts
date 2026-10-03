// SPDX-License-Identifier: AGPL-3.0-or-later
import { outboxJobSchema, type OutboxJob, type OutboxJobInput } from '@thefold/shared';
import type { PoolClient } from 'pg';

export interface ClaimedJob {
  id: string;
  idempotencyKey: string;
  attempts: number;
  job: OutboxJob;
}

export interface BackoffPolicy {
  baseSeconds: number;
  capSeconds: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: Readonly<BackoffPolicy> = {
  baseSeconds: 30,
  capSeconds: 6 * 3600,
  maxAttempts: 8,
};

/**
 * Queue a write to Twenty. The (tenant, idempotency key) pair is unique, so enqueueing the same
 * intent twice -- a double-clicked form, a retried request -- is harmless. Must run inside `withTenant`.
 */
export async function enqueueOutbox(
  client: PoolClient,
  input: OutboxJobInput,
): Promise<{ id: string | null; duplicate: boolean }> {
  const job = outboxJobSchema.parse(input);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox (tenant_id, kind, idempotency_key, payload)
     VALUES (fold_current_tenant(), $1, $2, $3)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [job.kind, job.idempotencyKey, JSON.stringify(job)],
  );
  const id = rows[0]?.id ?? null;
  return { id, duplicate: id === null };
}

/**
 * Leases due jobs. `FOR UPDATE SKIP LOCKED` lets several workers poll without blocking each other; a
 * worker that dies leaves an IN_FLIGHT row whose lease expires, and the next poll picks it up again.
 */
export async function claimOutbox(
  client: PoolClient,
  opts: { limit: number; leaseSeconds: number },
): Promise<ClaimedJob[]> {
  const { rows } = await client.query<{
    id: string;
    idempotency_key: string;
    attempts: number;
    payload: unknown;
  }>(
    `WITH due AS (
       SELECT id FROM outbox
       WHERE status IN ('PENDING', 'IN_FLIGHT')
         AND next_attempt_at <= now()
         AND (locked_until IS NULL OR locked_until < now())
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox o
        SET status = 'IN_FLIGHT',
            attempts = o.attempts + 1,
            locked_until = now() + make_interval(secs => $2::float8)
       FROM due
      WHERE o.id = due.id
     RETURNING o.id, o.idempotency_key, o.attempts, o.payload`,
    [opts.limit, opts.leaseSeconds],
  );
  return rows.map((r) => ({
    id: r.id,
    idempotencyKey: r.idempotency_key,
    attempts: r.attempts,
    job: outboxJobSchema.parse(r.payload),
  }));
}

export async function completeOutbox(client: PoolClient, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE outbox SET status = 'DONE', done_at = now(), locked_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'IN_FLIGHT'`,
    [id],
  );
  return rowCount === 1;
}

/** Exponential backoff with a cap; after `maxAttempts` the job is parked as DEAD for a human to look at. */
export async function failOutbox(
  client: PoolClient,
  id: string,
  error: string,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): Promise<{ status: 'PENDING' | 'DEAD'; nextAttemptAt: Date } | null> {
  const { rows } = await client.query<{ status: 'PENDING' | 'DEAD'; next_attempt_at: Date }>(
    `UPDATE outbox
        SET status = CASE WHEN attempts >= $5 THEN 'DEAD' ELSE 'PENDING' END,
            last_error = left($2, 2000),
            locked_until = NULL,
            next_attempt_at = now() + make_interval(secs => LEAST($3::float8 * power(2, attempts - 1), $4::float8))
      WHERE id = $1 AND status = 'IN_FLIGHT'
      RETURNING status, next_attempt_at`,
    [id, error, policy.baseSeconds, policy.capSeconds, policy.maxAttempts],
  );
  const row = rows[0];
  return row ? { status: row.status, nextAttemptAt: row.next_attempt_at } : null;
}
