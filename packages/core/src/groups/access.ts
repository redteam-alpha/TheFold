// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GroupOpenness, GroupRole, MembershipStatus } from '../domain.js';

/**
 * Who sees which group, who sees its members, and who decides join requests (ADR 0008). The portal asks these
 * functions and nothing else, so the rules live in one place and are property-tested.
 *
 * The viewer is always a signed-in adult whose account is linked to a person (children have no accounts).
 */
export interface GroupFacts {
  openness: GroupOpenness;
  deleted: boolean;
}

/** The viewer's own membership in the group, if any. */
export type OwnMembership = { role: GroupRole; status: MembershipStatus } | null;

/** Statuses that mean "this person is connected to the group" (an invitation, a request, or membership). */
const CONNECTED: readonly MembershipStatus[] = ['INTERESTED', 'REQUESTED', 'ACTIVE', 'PAUSED'];
const LEADS: readonly GroupRole[] = ['LEADER', 'CO_LEADER'];

/**
 * PUBLIC and CLOSED groups are listed for every member. A SECRET group (a recovery group, a support group) is
 * visible only to the people connected to it: its existence is itself private.
 */
export function canSeeGroup(group: GroupFacts, own: OwnMembership): boolean {
  if (group.deleted) return false;
  if (group.openness !== 'SECRET') return true;
  return own !== null && CONNECTED.includes(own.status);
}

/** Only active members see who else is in a group. */
export function canSeeMembers(group: GroupFacts, own: OwnMembership): boolean {
  return canSeeGroup(group, own) && own?.status === 'ACTIVE';
}

/** Leaders and co-leaders of the group, while active, decide requests to join it. */
export function canDecideRequests(group: GroupFacts, own: OwnMembership): boolean {
  return canSeeMembers(group, own) && own !== null && LEADS.includes(own.role);
}

/**
 * A member may ask to join a group they can see and are not already in or waiting for. SECRET groups are not
 * joined from the portal: their leaders and the church add people in Twenty.
 */
export function canRequestToJoin(group: GroupFacts, own: OwnMembership): boolean {
  if (!canSeeGroup(group, own) || group.openness === 'SECRET') return false;
  return own === null || own.status === 'LEFT' || own.status === 'INTERESTED';
}

/** A member may step out of anything they are connected to: a membership, a request or an invitation. */
export function canLeave(own: OwnMembership): boolean {
  return own !== null && CONNECTED.includes(own.status);
}

export interface ListedPerson {
  personId: string;
  firstName: string;
  lastName: string;
  isMinor: boolean;
  status: MembershipStatus;
  role: GroupRole;
}

/** "Ada T.": enough to recognise someone you have met, not enough to look a stranger up. */
export function shortName(firstName: string, lastName: string): string {
  const first = firstName.trim();
  const initial = lastName.trim().charAt(0).toUpperCase();
  return [first, initial ? `${initial}.` : ''].filter(Boolean).join(' ') || 'A member';
}

/**
 * The member list a member may see: active adults only, leaders first, then by name. Children are never listed,
 * whatever their membership says (no adult-to-child contact paths; docs/privacy-and-safety.md).
 */
export function visibleMembers(
  people: readonly ListedPerson[],
): { personId: string; name: string; leads: boolean }[] {
  return people
    .filter((p) => !p.isMinor && p.status === 'ACTIVE')
    .map((p) => ({
      personId: p.personId,
      name: shortName(p.firstName, p.lastName),
      leads: LEADS.includes(p.role),
    }))
    .sort(
      (a, b) =>
        Number(b.leads) - Number(a.leads) ||
        a.name.localeCompare(b.name) ||
        a.personId.localeCompare(b.personId),
    );
}
