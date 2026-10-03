// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeEmail, normalizePhone } from '@thefold/core';
import type { PoolClient } from 'pg';

export type ApplyResult = 'APPLIED' | 'STALE';

export interface PersonReadInput {
  twentyPersonId: string;
  /** Twenty's `updatedAt` for the record. Compared against what we hold. */
  twentyUpdatedAt: Date;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  isMinor: boolean;
  sharedEmail: boolean;
  householdId: string | null;
  lifecycleStage: string;
  doNotContact: boolean;
  awayUntil: string | null;
  deletedAt: Date | null;
}

/**
 * Upsert that only moves forward: a late webhook, a duplicate, or an out-of-order reconcile page can
 * never overwrite newer data. Equal timestamps are STALE too, which makes the operation idempotent.
 */
export async function upsertPersonRead(
  client: PoolClient,
  p: PersonReadInput,
): Promise<ApplyResult> {
  const { rowCount } = await client.query(
    `INSERT INTO person_read AS t (tenant_id, twenty_person_id, twenty_updated_at, first_name, last_name, emails, phones,
                                   is_minor, shared_email, household_id, lifecycle_stage, do_not_contact, away_until, deleted_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, twenty_person_id) DO UPDATE SET
       twenty_updated_at = EXCLUDED.twenty_updated_at,
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       emails = EXCLUDED.emails, phones = EXCLUDED.phones,
       is_minor = EXCLUDED.is_minor, shared_email = EXCLUDED.shared_email,
       household_id = EXCLUDED.household_id, lifecycle_stage = EXCLUDED.lifecycle_stage,
       do_not_contact = EXCLUDED.do_not_contact, away_until = EXCLUDED.away_until,
       deleted_at = EXCLUDED.deleted_at, synced_at = now()
     WHERE t.twenty_updated_at < EXCLUDED.twenty_updated_at`,
    [
      p.twentyPersonId,
      p.twentyUpdatedAt,
      p.firstName,
      p.lastName,
      // Stored normalised so the connection card can find someone by email/phone with an indexed lookup.
      p.emails.map((e) => normalizeEmail(e) ?? e.trim().toLowerCase()),
      p.phones.map((x) => normalizePhone(x) ?? x),
      p.isMinor,
      p.sharedEmail,
      p.householdId,
      p.lifecycleStage,
      p.doNotContact,
      p.awayUntil,
      p.deletedAt,
    ],
  );
  return rowCount === 1 ? 'APPLIED' : 'STALE';
}

export interface MembershipReadInput {
  twentyMembershipId: string;
  twentyUpdatedAt: Date;
  groupId: string;
  personId: string;
  role: string;
  status: string;
  deletedAt: Date | null;
}

export async function upsertMembershipRead(
  client: PoolClient,
  m: MembershipReadInput,
): Promise<ApplyResult> {
  const { rowCount } = await client.query(
    `INSERT INTO membership_read AS t (tenant_id, twenty_membership_id, twenty_updated_at, group_id, person_id, role, status, deleted_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, twenty_membership_id) DO UPDATE SET
       twenty_updated_at = EXCLUDED.twenty_updated_at, group_id = EXCLUDED.group_id, person_id = EXCLUDED.person_id,
       role = EXCLUDED.role, status = EXCLUDED.status, deleted_at = EXCLUDED.deleted_at, synced_at = now()
     WHERE t.twenty_updated_at < EXCLUDED.twenty_updated_at`,
    [m.twentyMembershipId, m.twentyUpdatedAt, m.groupId, m.personId, m.role, m.status, m.deletedAt],
  );
  return rowCount === 1 ? 'APPLIED' : 'STALE';
}

/**
 * What we just wrote to Twenty, shown before Twenty's echo arrives. With Twenty's `updatedAt` it is an ordinary
 * forward-only upsert. Without one it applies anyway but leaves the stored timestamp alone (the epoch for a new
 * row), so the next record from Twenty, webhook or reconcile, always supersedes it.
 */
export async function writeThroughMembership(
  client: PoolClient,
  m: Omit<MembershipReadInput, 'twentyUpdatedAt' | 'deletedAt'> & { twentyUpdatedAt: Date | null },
): Promise<void> {
  await client.query(
    `INSERT INTO membership_read AS t (tenant_id, twenty_membership_id, twenty_updated_at, group_id, person_id, role, status)
     VALUES (fold_current_tenant(), $1, COALESCE($2, 'epoch'::timestamptz), $3, $4, $5, $6)
     ON CONFLICT (tenant_id, twenty_membership_id) DO UPDATE SET
       twenty_updated_at = GREATEST(t.twenty_updated_at, EXCLUDED.twenty_updated_at),
       group_id = EXCLUDED.group_id, person_id = EXCLUDED.person_id, role = EXCLUDED.role,
       status = EXCLUDED.status, deleted_at = NULL, synced_at = now()
     WHERE $2::timestamptz IS NULL OR t.twenty_updated_at < $2::timestamptz`,
    [m.twentyMembershipId, m.twentyUpdatedAt, m.groupId, m.personId, m.role, m.status],
  );
}

export interface GroupReadInput {
  twentyGroupId: string;
  twentyUpdatedAt: Date;
  name: string;
  groupType: string | null;
  openness: string;
  childFriendly: boolean;
  pausedUntil: string | null;
  campusId: string | null;
  description: string | null;
  schedule: string | null;
  capacity: number | null;
  deletedAt: Date | null;
}

export async function upsertGroupRead(client: PoolClient, g: GroupReadInput): Promise<ApplyResult> {
  const { rowCount } = await client.query(
    `INSERT INTO group_read AS t (tenant_id, twenty_group_id, twenty_updated_at, name, group_type, openness,
                                  child_friendly, paused_until, campus_id, description, schedule, capacity, deleted_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, twenty_group_id) DO UPDATE SET
       twenty_updated_at = EXCLUDED.twenty_updated_at, name = EXCLUDED.name, group_type = EXCLUDED.group_type,
       openness = EXCLUDED.openness, child_friendly = EXCLUDED.child_friendly, paused_until = EXCLUDED.paused_until,
       campus_id = EXCLUDED.campus_id, description = EXCLUDED.description, schedule = EXCLUDED.schedule,
       capacity = EXCLUDED.capacity, deleted_at = EXCLUDED.deleted_at, synced_at = now()
     WHERE t.twenty_updated_at < EXCLUDED.twenty_updated_at`,
    [
      g.twentyGroupId,
      g.twentyUpdatedAt,
      g.name,
      g.groupType,
      g.openness,
      g.childFriendly,
      g.pausedUntil,
      g.campusId,
      g.description,
      g.schedule,
      g.capacity,
      g.deletedAt,
    ],
  );
  return rowCount === 1 ? 'APPLIED' : 'STALE';
}
