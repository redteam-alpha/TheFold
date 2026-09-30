// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  pickWelcomer,
  planWelcomeSequence,
  toLocalDate,
  type LocalDate,
  type WelcomerCandidate,
} from '@thefold/core';
import type { Guest } from '@thefold/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../db/audit.js';
import { enqueueOutbox } from '../db/outbox.js';
import type { GuestUpsertResult } from '../twenty/gateway.js';

export interface AssignmentInput {
  guest: Guest;
  visitedAt: number;
  visitedOn: LocalDate;
  existingPersonId: string | null;
  result: GuestUpsertResult;
  tenantId: string;
  timezone: string;
  now: Date;
}

export type AssignmentOutcome =
  | { kind: 'ATTENDANCE_ONLY'; reason: 'NO_CONTACT_CONSENT' | 'ALREADY_KNOWN' | 'ALREADY_ASSIGNED' }
  | { kind: 'ASSIGNED'; welcomerId: string }
  | { kind: 'POOL'; reason: string };

const titles = (g: Guest) => ({
  WELCOME: `Welcome ${g.firstName} ${g.lastName}`,
  GROUP_INTRO: `Invite ${g.firstName} to an event or a group`,
  FOLLOW_UP: `Check in with ${g.firstName}: do they feel connected?`,
});

/**
 * After Twenty has created the guest: record their attendance, and unless they did not consent to be
 * contacted (or are already part of the church), assign ONE welcomer for the whole household and queue
 * the welcome sequence. Runs in the same transaction that completes the upsert job, so a crash can never
 * leave a guest created but unassigned, or assigned twice.
 */
export async function assignWelcome(
  client: PoolClient,
  i: AssignmentInput,
): Promise<AssignmentOutcome> {
  const primary = i.result.primaryPersonId;

  await enqueueOutbox(client, {
    kind: 'twenty.recordAttendance',
    idempotencyKey: `att:${primary}:${i.visitedOn}:SERVICE`,
    attendance: { personId: primary, date: i.visitedOn, kind: 'SERVICE', source: 'CHECKIN' },
  });

  const consent = i.guest.contactConsent;
  if (!consent.byEmail && !consent.byPhone && !consent.byText) {
    // They did not say we could contact them. We still record that they came; we do not follow up.
    await writeAudit(client, {
      actorPersonId: null,
      action: 'WELCOME_SKIPPED_NO_CONSENT',
      subjectType: 'PERSON',
      subjectId: primary,
    });
    return { kind: 'ATTENDANCE_ONLY', reason: 'NO_CONTACT_CONSENT' };
  }

  if (i.existingPersonId) {
    // A returning, already-known person is not a "new guest": no welcome sequence.
    const stage = await client.query<{ lifecycle_stage: string }>(
      `SELECT lifecycle_stage FROM person_read WHERE twenty_person_id = $1`,
      [i.existingPersonId],
    );
    if ((stage.rows[0]?.lifecycle_stage ?? 'NEW_GUEST') !== 'NEW_GUEST')
      return { kind: 'ATTENDANCE_ONLY', reason: 'ALREADY_KNOWN' };
  }

  // A single writer per tenant: two guests arriving together must not both be given the same welcomer's last slot.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `welcomer:${i.tenantId}`,
  ]);

  const already = await client.query(`SELECT 1 FROM outbox WHERE idempotency_key = $1`, [
    `welcome:${primary}:WELCOME`,
  ]);
  if (already.rowCount === 1) return { kind: 'ATTENDANCE_ONLY', reason: 'ALREADY_ASSIGNED' };

  const load = await client.query<{
    twenty_person_id: string;
    weight: string;
    max_open: number;
    open_count: number;
    assigned_last_30d: number;
    last_assigned_at: Date | null;
    campus_ids: string[];
    away_until: string | null;
  }>(
    `SELECT twenty_person_id, weight, max_open, open_count, assigned_last_30d, last_assigned_at, campus_ids, away_until::text FROM welcomer_load`,
  );
  const candidates: WelcomerCandidate[] = load.rows.map((r) => ({
    id: r.twenty_person_id,
    weight: Number(r.weight),
    maxOpen: r.max_open,
    openCount: r.open_count,
    assignedLast30d: r.assigned_last_30d,
    lastAssignedAt: r.last_assigned_at ? r.last_assigned_at.getTime() : null,
    campusIds: r.campus_ids,
    awayUntil: r.away_until,
  }));

  const pick = pickWelcomer(
    candidates,
    { id: primary, campusId: i.guest.campusId ?? null, householdMemberIds: i.result.personIds },
    { today: toLocalDate(i.now, i.timezone), tenantId: i.tenantId },
  );

  let owner: string | null = null;
  if (pick.kind === 'ASSIGNED') {
    owner = pick.welcomerId;
    await client.query(
      `UPDATE welcomer_load SET open_count = open_count + 1, assigned_last_30d = assigned_last_30d + 1, last_assigned_at = $2
        WHERE twenty_person_id = $1`,
      [owner, i.now],
    );
    await client.query(
      `INSERT INTO notification (tenant_id, recipient_person_id, category, type, subject_type, subject_id)
       VALUES (fold_current_tenant(), $1, 'FOLLOW_UP_DUE', 'welcome_assigned', 'PERSON', $2)`,
      [owner, primary],
    );
  } else {
    // Never leave a guest without an owner: it goes to the pastor pool unassigned, and an admin can see why.
    await writeAudit(client, {
      actorPersonId: null,
      action: 'WELCOMER_POOL_FALLBACK',
      subjectType: 'PERSON',
      subjectId: primary,
      meta: { reason: pick.reason },
    });
  }

  const t = titles(i.guest);
  const context =
    i.result.personIds.length > 1 ? 'First-time guest, came with family' : 'First-time guest';
  for (const step of planWelcomeSequence(i.visitedAt)) {
    await enqueueOutbox(client, {
      kind: 'twenty.createFollowUp',
      idempotencyKey: `welcome:${primary}:${step.kind}`,
      followUp: {
        kind: step.kind,
        title: t[step.kind as keyof typeof t] ?? step.label,
        subjectPersonId: primary,
        ownerPersonId: owner,
        dueAt: step.dueAt,
        contextSummary: context,
      },
    });
  }
  return owner
    ? { kind: 'ASSIGNED', welcomerId: owner }
    : { kind: 'POOL', reason: pick.kind === 'POOL' ? pick.reason : 'unknown' };
}
