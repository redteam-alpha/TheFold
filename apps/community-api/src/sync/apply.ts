// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TwentyRecord } from '@thefold/twenty-client';
import type { PoolClient } from 'pg';
import { upsertMembershipRead, upsertPersonRead } from '../db/readModels.js';
import { membershipReadFromTwenty, personReadFromTwenty } from './fromTwenty.js';

export type ApplyOutcome = 'APPLIED' | 'STALE' | 'SKIPPED';

/**
 * The Twenty objects the read models mirror, by the singular name a webhook uses. Anything else is
 * acknowledged and ignored: we only copy what the portal and the workers actually read.
 */
export interface SyncedObject {
  plural: string;
  apply(client: PoolClient, record: TwentyRecord): Promise<ApplyOutcome>;
  /**
   * The record no longer exists in Twenty: hide our copy (kept, marked deleted, for links and audit).
   * Resolves true if this call marked it, false if it was already marked or never copied.
   */
  markGone(client: PoolClient, id: string): Promise<boolean>;
}

export const SYNCED_OBJECTS: Readonly<Record<string, SyncedObject>> = {
  person: {
    plural: 'people',
    async apply(client, record) {
      const row = personReadFromTwenty(record);
      return row ? upsertPersonRead(client, row) : 'SKIPPED';
    },
    async markGone(client, id) {
      const { rowCount } = await client.query(
        `UPDATE person_read SET deleted_at = now(), synced_at = now() WHERE twenty_person_id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    },
  },
  groupMembership: {
    plural: 'groupMemberships',
    async apply(client, record) {
      const row = membershipReadFromTwenty(record);
      return row ? upsertMembershipRead(client, row) : 'SKIPPED';
    },
    async markGone(client, id) {
      const { rowCount } = await client.query(
        `UPDATE membership_read SET deleted_at = now(), synced_at = now() WHERE twenty_membership_id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    },
  },
};
