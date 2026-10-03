// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GROUP_OPENNESS,
  GROUP_ROLES,
  GROUP_TYPES,
  LIFECYCLE_STAGES,
  MEMBERSHIP_STATUSES,
} from '@thefold/core';
import type { TwentyRecord } from '@thefold/twenty-client';
import type { GroupReadInput, MembershipReadInput, PersonReadInput } from '../db/readModels.js';

/**
 * Twenty records → read-model rows. Shapes: composite `name`/`emails`/`phones` and `<relation>Id` were seen on
 * v2.43.0 (M0 `person-shapes`); field names are ours (apps/fold-app/src/model/spec.ts). A record without a
 * usable id or `updatedAt` maps to null: without `updatedAt` there is no safe way to order it against what we
 * already hold, so it is left for the next reconcile rather than guessed. The same goes for a select value we
 * do not know (a stage added in Twenty but not here): guessing one would change how the person is treated.
 */
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bool = (v: unknown): boolean => v === true;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T | null => {
  const s = str(v);
  if (s === null) return fallback;
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
};

function phoneWithCode(number: unknown, code: unknown): string | null {
  const n = str(number);
  if (!n) return null;
  const c = str(code);
  return n.startsWith('+') || !c ? n : `${c.startsWith('+') ? c : `+${c}`}${n}`;
}

export function personReadFromTwenty(r: TwentyRecord): PersonReadInput | null {
  const updatedAt = date(r['updatedAt']);
  const lifecycleStage = oneOf(LIFECYCLE_STAGES, r['lifecycleStage'], 'NEW_GUEST');
  if (!updatedAt || !lifecycleStage) return null;
  const name = obj(r['name']);
  const emails = obj(r['emails']);
  const phones = obj(r['phones']);
  const additionalEmails = Array.isArray(emails['additionalEmails'])
    ? (emails['additionalEmails'] as unknown[])
    : [];
  const additionalPhones = Array.isArray(phones['additionalPhones'])
    ? (phones['additionalPhones'] as unknown[])
    : [];
  const away = str(r['awayUntil']);
  return {
    twentyPersonId: r.id,
    twentyUpdatedAt: updatedAt,
    firstName: str(name['firstName']) ?? '',
    lastName: str(name['lastName']) ?? '',
    emails: [emails['primaryEmail'], ...additionalEmails]
      .map(str)
      .filter((e): e is string => e !== null),
    phones: [
      phoneWithCode(
        phones['primaryPhoneNumber'],
        phones['primaryPhoneCallingCode'] ?? phones['primaryPhoneCountryCode'],
      ),
      ...additionalPhones.map((p) =>
        typeof p === 'string'
          ? p
          : phoneWithCode(obj(p)['number'], obj(p)['callingCode'] ?? obj(p)['countryCode']),
      ),
    ].filter((p): p is string => p !== null && p !== ''),
    isMinor: bool(r['isMinor']),
    sharedEmail: bool(r['sharedEmail']),
    householdId: str(r['householdId']),
    lifecycleStage,
    // A minor is never contacted directly, whatever the record says.
    doNotContact: bool(r['doNotContact']) || bool(r['isMinor']),
    awayUntil: away ? away.slice(0, 10) : null,
    deletedAt: date(r['deletedAt']),
  };
}

export function membershipReadFromTwenty(r: TwentyRecord): MembershipReadInput | null {
  const updatedAt = date(r['updatedAt']);
  const groupId = str(r['groupId']);
  const personId = str(r['personId']);
  const role = oneOf(GROUP_ROLES, r['groupRole'], 'MEMBER');
  const status = oneOf(MEMBERSHIP_STATUSES, r['status'], 'ACTIVE');
  if (!updatedAt || !groupId || !personId || !role || !status) return null;
  return {
    twentyMembershipId: r.id,
    twentyUpdatedAt: updatedAt,
    groupId,
    personId,
    role,
    status,
    deletedAt: date(r['deletedAt']),
  };
}

/**
 * An unknown openness maps to null (skipped, not guessed): reading it as PUBLIC could show a secret group to the
 * whole church. A missing one is CLOSED, Twenty's default for the field.
 */
export function groupReadFromTwenty(r: TwentyRecord): GroupReadInput | null {
  const updatedAt = date(r['updatedAt']);
  const openness = oneOf(GROUP_OPENNESS, r['openness'], 'CLOSED');
  if (!updatedAt || !openness) return null;
  const groupType = str(r['groupType']);
  const paused = str(r['pausedUntil']);
  const capacity = r['capacity'];
  return {
    twentyGroupId: r.id,
    twentyUpdatedAt: updatedAt,
    name: str(r['name']) ?? '',
    groupType:
      groupType && (GROUP_TYPES as readonly string[]).includes(groupType) ? groupType : null,
    openness,
    childFriendly: bool(r['childFriendly']),
    pausedUntil: paused ? paused.slice(0, 10) : null,
    campusId: str(r['campusId']),
    description: str(r['description']),
    schedule: str(r['schedule']),
    capacity:
      typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0 ? capacity : null,
    deletedAt: date(r['deletedAt']),
  };
}
