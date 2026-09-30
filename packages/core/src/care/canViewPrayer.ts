// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrayerStatus, PrayerTier, StaffRole } from '../domain.js';

export interface PrayerViewer {
  personId: string;
  roles: readonly StaffRole[];
  /** A portal account that is linked to a VERIFIED Person and is an adult. */
  isVerifiedMember: boolean;
  activeGroupIds: readonly string[];
}

export interface PrayerRequestAccessMeta {
  authorPersonId: string;
  tier: PrayerTier;
  groupId?: string | null;
  status: PrayerStatus;
  /** The care-team member the request is assigned to, if any. */
  assignedCareOwnerId?: string | null;
  anonymousToCommunity: boolean;
}

export type PrayerAccessVia =
  'AUTHOR' | 'ASSIGNED_CARE' | 'PASTOR_ASSIGNED' | 'PASTOR_BREAK_GLASS' | 'GROUP_MEMBER' | 'MEMBER';

export type PrayerAccess =
  | {
      allow: true;
      via: PrayerAccessVia;
      /** True whenever someone other than the author reads through the care path; must write audit_log. */
      audit: boolean;
      /** The care team and the author always see who wrote it; the community sees it unless anonymous. */
      showAuthor: boolean;
    }
  | {
      allow: false;
      reason: 'REMOVED' | 'NOT_AUTHORIZED' | 'NOT_A_MEMBER' | 'NOT_IN_GROUP' | 'NOT_ACTIVE';
    };

const MIN_BREAK_GLASS_REASON = 10;

/**
 * The single place that decides who reads a prayer request or care note.
 * - Author: always (unless REMOVED, which hides it from everyone but the author).
 * - Care path: `care_team` only for requests assigned to them; `pastor` when assigned, or with a
 *   written break-glass reason. Every care-path read by someone else is audited.
 * - Community path: GROUP tier needs an active membership in that group; CHURCH tier needs a
 *   verified member; CARE_ONLY is never visible on this path. Expired/archived requests leave the
 *   community path entirely.
 */
export function canViewPrayer(
  viewer: PrayerViewer,
  request: PrayerRequestAccessMeta,
  ctx: { breakGlassReason?: string | null } = {},
): PrayerAccess {
  const isAuthor = viewer.personId === request.authorPersonId;
  if (request.status === 'REMOVED') {
    return isAuthor
      ? { allow: true, via: 'AUTHOR', audit: false, showAuthor: true }
      : { allow: false, reason: 'REMOVED' };
  }
  if (isAuthor) return { allow: true, via: 'AUTHOR', audit: false, showAuthor: true };

  // ---- care path ---------------------------------------------------------------------------
  const assigned =
    request.assignedCareOwnerId != null && request.assignedCareOwnerId === viewer.personId;
  if (viewer.roles.includes('care_team') && assigned) {
    return { allow: true, via: 'ASSIGNED_CARE', audit: true, showAuthor: true };
  }
  if (viewer.roles.includes('pastor')) {
    if (assigned) return { allow: true, via: 'PASTOR_ASSIGNED', audit: true, showAuthor: true };
    if ((ctx.breakGlassReason ?? '').trim().length >= MIN_BREAK_GLASS_REASON) {
      return { allow: true, via: 'PASTOR_BREAK_GLASS', audit: true, showAuthor: true };
    }
  }

  // ---- community path ----------------------------------------------------------------------
  if (request.status !== 'ACTIVE' && request.status !== 'ANSWERED') {
    return { allow: false, reason: 'NOT_ACTIVE' };
  }
  switch (request.tier) {
    case 'CARE_ONLY':
      return { allow: false, reason: 'NOT_AUTHORIZED' };
    case 'GROUP':
      if (!viewer.isVerifiedMember) return { allow: false, reason: 'NOT_A_MEMBER' };
      return request.groupId != null && viewer.activeGroupIds.includes(request.groupId)
        ? {
            allow: true,
            via: 'GROUP_MEMBER',
            audit: false,
            showAuthor: !request.anonymousToCommunity,
          }
        : { allow: false, reason: 'NOT_IN_GROUP' };
    case 'CHURCH':
      return viewer.isVerifiedMember
        ? { allow: true, via: 'MEMBER', audit: false, showAuthor: !request.anonymousToCommunity }
        : { allow: false, reason: 'NOT_A_MEMBER' };
  }
}
