// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  canDecideRequests,
  canLeave,
  canRequestToJoin,
  canSeeGroup,
  canSeeMembers,
  shortName,
  visibleMembers,
  type GroupOpenness,
  type GroupRole,
  type MembershipStatus,
  type OwnMembership,
} from '@thefold/core';
import type { PoolClient } from 'pg';
import { writeAudit } from '../db/audit.js';
import { enqueueOutbox } from '../db/outbox.js';

/**
 * Groups in the portal (ADR 0008). What a member may see or do is decided by the rules in `@thefold/core`
 * (`canSeeGroup` and friends); this module only reads the rows and queues the writes. Every write goes to Twenty
 * through the outbox, and Twenty stays the record of who is in which group.
 *
 * Everything runs inside `withTenant`, for a VERIFIED member (`person` is their linked Twenty person).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGroupId = (id: string): boolean => UUID.test(id);

interface GroupRow {
  twenty_group_id: string;
  name: string;
  group_type: string | null;
  openness: GroupOpenness;
  child_friendly: boolean;
  paused_until: string | null;
  description: string | null;
  schedule: string | null;
  deleted_at: Date | null;
}

export interface GroupView {
  id: string;
  name: string;
  groupType: string | null;
  openness: GroupOpenness;
  childFriendly: boolean;
  pausedUntil: string | null;
  description: string | null;
  schedule: string | null;
  /** The member's own status in this group, if any (a request shows as REQUESTED straight away). */
  myStatus: MembershipStatus | null;
  canRequestToJoin: boolean;
  canLeave: boolean;
  leads: boolean;
}

/**
 * A person's membership of each group: a queued change (not yet in Twenty) wins over what Twenty last said, so
 * a member who just asked to join sees "Requested" at once. Several rows for one pair (a duplicate made in
 * Twenty) resolve to the newest.
 */
async function ownMemberships(
  c: PoolClient,
  personId: string,
  groupId: string | null,
): Promise<Map<string, NonNullable<OwnMembership>>> {
  const { rows } = await c.query<{ group_id: string; role: GroupRole; status: MembershipStatus }>(
    `SELECT DISTINCT ON (group_id) group_id, role, status FROM (
       SELECT payload->'membership'->>'groupId' AS group_id, payload->'membership'->>'role' AS role,
              payload->'membership'->>'status' AS status, 1 AS rank, created_at AS at
         FROM outbox
        WHERE kind = 'twenty.upsertMembership' AND status IN ('PENDING', 'IN_FLIGHT')
          AND payload->'membership'->>'personId' = $1
       UNION ALL
       SELECT group_id::text, role, status, 2, twenty_updated_at
         FROM membership_read
        WHERE person_id = $1::uuid AND deleted_at IS NULL
     ) m
     WHERE $2::text IS NULL OR group_id = $2::text
     ORDER BY group_id, rank, at DESC`,
    [personId, groupId],
  );
  return new Map(rows.map((r) => [r.group_id, { role: r.role, status: r.status }]));
}

const groupColumns = `twenty_group_id, name, group_type, openness, child_friendly, paused_until::text AS paused_until,
  description, schedule, deleted_at`;

function view(g: GroupRow, own: OwnMembership): GroupView {
  const facts = { openness: g.openness, deleted: g.deleted_at !== null };
  return {
    id: g.twenty_group_id,
    name: g.name,
    groupType: g.group_type,
    openness: g.openness,
    childFriendly: g.child_friendly,
    pausedUntil: g.paused_until,
    description: g.description,
    schedule: g.schedule,
    myStatus: own?.status ?? null,
    canRequestToJoin: canRequestToJoin(facts, own),
    canLeave: canLeave(own),
    leads: canDecideRequests(facts, own),
  };
}

/** Every group the member may see: theirs first, then the rest by name. No counts, no ranking. */
export async function listGroups(c: PoolClient, personId: string): Promise<GroupView[]> {
  const mine = await ownMemberships(c, personId, null);
  const { rows } = await c.query<GroupRow>(
    `SELECT ${groupColumns} FROM group_read WHERE deleted_at IS NULL ORDER BY lower(name), twenty_group_id`,
  );
  return rows
    .filter((g) =>
      canSeeGroup({ openness: g.openness, deleted: false }, mine.get(g.twenty_group_id) ?? null),
    )
    .map((g) => view(g, mine.get(g.twenty_group_id) ?? null))
    .sort((a, b) => Number(isIn(b)) - Number(isIn(a)));
}

const isIn = (g: GroupView) => g.myStatus === 'ACTIVE' || g.myStatus === 'PAUSED';

export interface GroupDetail extends GroupView {
  /** First names of the active adult leaders: who you would be meeting. */
  leaders: string[];
  /** Only for active members. */
  members: { name: string; leads: boolean }[] | null;
  /** Only for the group's leaders: people waiting for an answer. */
  requests: { personId: string; name: string }[] | null;
}

/** One group, or null when it does not exist or the member may not see it (the two look the same). */
export async function groupDetail(
  c: PoolClient,
  personId: string,
  groupId: string,
): Promise<GroupDetail | null> {
  if (!isGroupId(groupId)) return null;
  const g = (
    await c.query<GroupRow>(`SELECT ${groupColumns} FROM group_read WHERE twenty_group_id = $1`, [
      groupId,
    ])
  ).rows[0];
  if (!g) return null;
  const own = (await ownMemberships(c, personId, groupId)).get(groupId) ?? null;
  const facts = { openness: g.openness, deleted: g.deleted_at !== null };
  if (!canSeeGroup(facts, own)) return null;

  const people = (
    await c.query<{
      person_id: string;
      first_name: string;
      last_name: string;
      is_minor: boolean;
      role: GroupRole;
      status: MembershipStatus;
    }>(
      `SELECT DISTINCT ON (m.person_id) m.person_id, p.first_name, p.last_name, p.is_minor, m.role, m.status
         FROM membership_read m
         JOIN person_read p ON p.twenty_person_id = m.person_id AND p.deleted_at IS NULL
        WHERE m.group_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.person_id, m.twenty_updated_at DESC`,
      [groupId],
    )
  ).rows.map((r) => ({
    personId: r.person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    isMinor: r.is_minor,
    role: r.role,
    status: r.status,
  }));
  const listed = visibleMembers(people);
  return {
    ...view(g, own),
    leaders: listed.filter((p) => p.leads).map((p) => p.name.split(' ')[0] ?? p.name),
    members: canSeeMembers(facts, own) ? listed.map(({ name, leads }) => ({ name, leads })) : null,
    requests: canDecideRequests(facts, own)
      ? people
          .filter((p) => p.status === 'REQUESTED' && !p.isMinor)
          .map((p) => ({ personId: p.personId, name: shortName(p.firstName, p.lastName) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : null,
  };
}

export type GroupAction = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_ALLOWED' };

async function queueMembership(
  c: PoolClient,
  m: { groupId: string; personId: string; status: MembershipStatus; role: GroupRole },
  now: Date,
): Promise<void> {
  await enqueueOutbox(c, {
    kind: 'twenty.upsertMembership',
    // A double-click in the same minute is one job; a later change of mind is a new one.
    idempotencyKey: `membership:${m.groupId}:${m.personId}:${m.status}:${Math.floor(now.getTime() / 60_000)}`,
    membership: m,
  });
}

/** Ask to join: a request a leader answers. Never joins directly (ADR 0008). */
export async function requestToJoin(
  c: PoolClient,
  personId: string,
  groupId: string,
  now: Date,
): Promise<GroupAction> {
  const g = await groupDetail(c, personId, groupId);
  if (!g) return { ok: false, reason: 'NOT_FOUND' };
  if (!g.canRequestToJoin) return { ok: false, reason: 'NOT_ALLOWED' };
  await queueMembership(c, { groupId, personId, status: 'REQUESTED', role: 'MEMBER' }, now);
  return { ok: true };
}

/** Leave a group, withdraw a request, or decline an invitation. The role is kept, as Twenty keeps it. */
export async function leaveGroup(
  c: PoolClient,
  personId: string,
  groupId: string,
  now: Date,
): Promise<GroupAction> {
  if (!isGroupId(groupId)) return { ok: false, reason: 'NOT_FOUND' };
  const own = (await ownMemberships(c, personId, groupId)).get(groupId) ?? null;
  if (!own || !canLeave(own)) return { ok: false, reason: 'NOT_ALLOWED' };
  await queueMembership(c, { groupId, personId, status: 'LEFT', role: own.role }, now);
  return { ok: true };
}

/** A leader answers a request: approve makes the person an active member, decline closes the request. */
export async function decideRequest(
  c: PoolClient,
  leaderPersonId: string,
  groupId: string,
  requesterPersonId: string,
  approve: boolean,
  now: Date,
): Promise<GroupAction> {
  const g = await groupDetail(c, leaderPersonId, groupId);
  if (!g) return { ok: false, reason: 'NOT_FOUND' };
  if (!g.requests) return { ok: false, reason: 'NOT_ALLOWED' };
  if (!g.requests.some((r) => r.personId === requesterPersonId))
    return { ok: false, reason: 'NOT_FOUND' };
  await queueMembership(
    c,
    { groupId, personId: requesterPersonId, status: approve ? 'ACTIVE' : 'LEFT', role: 'MEMBER' },
    now,
  );
  await writeAudit(c, {
    actorPersonId: leaderPersonId,
    actorRoles: ['group_leader'],
    action: approve ? 'group.request_approved' : 'group.request_declined',
    subjectType: 'person',
    subjectId: requesterPersonId,
    meta: { groupId },
  });
  return { ok: true };
}
