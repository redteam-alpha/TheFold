// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WebhookHint } from '@thefold/shared';
import type { PoolClient } from 'pg';

export type HintOutcome = 'DUPLICATE' | 'QUEUED' | 'COALESCED';

/**
 * Twenty webhooks are at-least-once and unordered, so we never trust their payload as the new state.
 * They are only hints that a record MAY have changed:
 *   1. an exact redelivery (same delivery id) is dropped;
 *   2. otherwise it becomes one pending refetch per record -- many hints for the same record while a
 *      refetch is pending coalesce into a single fetch.
 * The refetched record is applied only if it is newer than what we hold (readModels.ts).
 * Must run inside `withTenant`.
 */
export async function recordWebhookHint(
  client: PoolClient,
  hint: WebhookHint,
): Promise<HintOutcome> {
  const delivery = await client.query(
    `INSERT INTO webhook_delivery (tenant_id, delivery_id) VALUES (fold_current_tenant(), $1)
     ON CONFLICT DO NOTHING RETURNING 1`,
    [hint.deliveryId],
  );
  if (delivery.rowCount === 0) return 'DUPLICATE';

  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO webhook_inbox (tenant_id, object_type, record_id)
     VALUES (fold_current_tenant(), $1, $2)
     ON CONFLICT (tenant_id, object_type, record_id) WHERE status = 'PENDING'
     DO UPDATE SET hits = webhook_inbox.hits + 1, last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [hint.objectType, hint.recordId],
  );
  return rows[0]?.inserted ? 'QUEUED' : 'COALESCED';
}

export interface PendingRefetch {
  objectType: string;
  recordId: string;
  hits: number;
}

/**
 * Takes pending refetches and marks them done in the same statement (at-most-once). If the worker then
 * fails to fetch, the change is caught by the hourly `updatedAt > cursor` reconcile; and a hint that
 * arrives while a fetch is running creates a fresh pending row, so a fast second change is never lost.
 */
export async function takeRefetches(client: PoolClient, limit: number): Promise<PendingRefetch[]> {
  const { rows } = await client.query<{ object_type: string; record_id: string; hits: number }>(
    `WITH picked AS (
       SELECT id FROM webhook_inbox WHERE status = 'PENDING' ORDER BY first_seen_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_inbox w SET status = 'DONE', done_at = now()
       FROM picked WHERE w.id = picked.id
     RETURNING w.object_type, w.record_id, w.hits`,
    [limit],
  );
  return rows.map((r) => ({ objectType: r.object_type, recordId: r.record_id, hits: r.hits }));
}

/** Delivery ids only need to outlive Twenty's retry window. */
export async function pruneWebhookDeliveries(
  client: PoolClient,
  olderThanDays: number,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM webhook_delivery WHERE received_at < now() - make_interval(days => $1::int)`,
    [olderThanDays],
  );
  return rowCount ?? 0;
}
