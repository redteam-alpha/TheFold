// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TwentyClient, TwentyRecord } from '@thefold/twenty-client';
import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { Logger } from '../log.js';
import { SYNCED_OBJECTS } from './apply.js';

export interface ReconcileReport {
  ran: boolean;
  /** Stopped at the page cap with more to read: the next tick continues instead of waiting for the interval. */
  more: boolean;
  pages: number;
  applied: number;
  stale: number;
  skipped: number;
}

/**
 * Re-reads one object's changes since the last run: the safety net under the webhooks (lost deliveries, a
 * worker that was down, a fetch that failed).
 *
 *  - Claim-then-run: `last_run_at` is stamped when a run starts, so two workers never reconcile the same object
 *    at once, and a run that dies simply waits for the next interval.
 *  - A new query starts one second before the cursor: records that share a timestamp are never skipped, and
 *    re-applying one we already hold is a no-op (`STALE`).
 *  - Every page is applied together with the position reached (migration 0004): the query it belongs to and
 *    Twenty's page cursor. A run capped at `maxPages`, or one that crashed, resumes exactly there, so a batch
 *    of thousands of records stamped with the same second is read once, not forever.
 */
export async function reconcileObject(
  pool: Pool,
  tenantId: string,
  twenty: TwentyClient,
  objectType: string,
  opts: { everyMs: number; maxPages?: number; pageSize?: number; log: Logger },
): Promise<ReconcileReport> {
  const object = SYNCED_OBJECTS[objectType];
  if (!object) throw new Error(`Not a synced object: ${objectType}`);
  const report: ReconcileReport = {
    ran: false,
    more: false,
    pages: 0,
    applied: 0,
    stale: 0,
    skipped: 0,
  };

  const claimed = await withTenant(pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO sync_cursor (tenant_id, object_type) VALUES (fold_current_tenant(), $1) ON CONFLICT DO NOTHING`,
      [objectType],
    );
    const { rows } = await c.query<{
      cursor_updated_at: Date;
      resume_since: Date | null;
      resume_after: string | null;
    }>(
      `UPDATE sync_cursor SET last_run_at = now()
        WHERE object_type = $1 AND (last_run_at IS NULL OR last_run_at < now() - make_interval(secs => $2::float8))
        RETURNING cursor_updated_at, resume_since, resume_after`,
      [objectType, opts.everyMs / 1000],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return report;
  report.ran = true;

  const since = (
    claimed.resume_since ?? new Date(Math.max(0, claimed.cursor_updated_at.getTime() - 1000))
  ).toISOString();
  let after = claimed.resume_after;
  const seen = new Set<string>();

  for (;;) {
    const page = await twenty.listUpdatedSincePage(object.plural, since, {
      after,
      pageSize: opts.pageSize ?? 60,
    });
    const next = page.nextCursor ?? null;
    if (next !== null && seen.has(next)) throw new Error(`Pagination cursor repeated: ${next}`);
    if (next !== null) seen.add(next);

    const newest = page.items.reduce<number>((max, r: TwentyRecord) => {
      const t = typeof r['updatedAt'] === 'string' ? Date.parse(r['updatedAt']) : NaN;
      return Number.isNaN(t) ? max : Math.max(max, t);
    }, claimed.cursor_updated_at.getTime());
    await withTenant(pool, tenantId, async (c) => {
      for (const record of page.items) {
        const outcome = await object.apply(c, record);
        if (outcome === 'APPLIED') report.applied++;
        else if (outcome === 'STALE') report.stale++;
        else report.skipped++;
      }
      await c.query(
        `UPDATE sync_cursor
            SET cursor_updated_at = GREATEST(cursor_updated_at, $2),
                resume_since = CASE WHEN $3::text IS NULL THEN NULL ELSE $4::timestamptz END,
                resume_after = $3::text
          WHERE object_type = $1`,
        [objectType, new Date(newest), next, since],
      );
    });
    report.pages++;
    if (next === null) break;
    after = next;
    if (report.pages >= (opts.maxPages ?? 50)) {
      report.more = true;
      break;
    }
  }

  if (report.more)
    await withTenant(pool, tenantId, (c) =>
      c.query(`UPDATE sync_cursor SET last_run_at = NULL WHERE object_type = $1`, [objectType]),
    );
  if (report.skipped > 0)
    opts.log.warn('reconcile.unmappable', { tenantId, objectType, skipped: report.skipped });
  return report;
}
