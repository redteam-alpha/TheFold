// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TwentyClient } from '@thefold/twenty-client';
import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import { takeRefetches } from '../db/webhookInbox.js';
import { errorFields, type Logger } from '../log.js';
import { SYNCED_OBJECTS } from './apply.js';

export interface RefetchReport {
  applied: number;
  stale: number;
  skipped: number;
  gone: number;
  ignored: number;
  failed: number;
}

/**
 * Turns pending webhook hints into fresh reads from Twenty. `takeRefetches` marks the hints done as it takes
 * them (at-most-once): a fetch that fails here is not retried from the inbox; the hourly reconcile picks the
 * change up instead. That keeps one broken record from blocking every hint queued behind it.
 */
export async function processRefetches(
  pool: Pool,
  tenantId: string,
  twenty: TwentyClient,
  opts: { limit?: number; log: Logger },
): Promise<RefetchReport> {
  const report: RefetchReport = {
    applied: 0,
    stale: 0,
    skipped: 0,
    gone: 0,
    ignored: 0,
    failed: 0,
  };
  const hints = await withTenant(pool, tenantId, (c) => takeRefetches(c, opts.limit ?? 100));
  for (const hint of hints) {
    const object = SYNCED_OBJECTS[hint.objectType];
    if (!object) {
      report.ignored++;
      continue;
    }
    try {
      const record = await twenty.getRecord(object.plural, hint.recordId, 'background');
      if (!record) {
        await withTenant(pool, tenantId, (c) => object.markGone(c, hint.recordId));
        report.gone++;
        continue;
      }
      const outcome = await withTenant(pool, tenantId, (c) => object.apply(c, record));
      if (outcome === 'APPLIED') report.applied++;
      else if (outcome === 'STALE') report.stale++;
      else {
        report.skipped++;
        opts.log.warn('refetch.unmappable', {
          tenantId,
          objectType: hint.objectType,
          recordId: hint.recordId,
        });
      }
    } catch (error) {
      report.failed++;
      opts.log.warn('refetch.failed', {
        tenantId,
        objectType: hint.objectType,
        recordId: hint.recordId,
        ...errorFields(error),
      });
    }
  }
  return report;
}
