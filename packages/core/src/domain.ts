// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared vocabulary for The Fold. These string unions are the contract between the Twenty app
// (SELECT option values), the community API (DB enums) and the pure domain logic in this package.

export const LIFECYCLE_STAGES = [
  'NEW_GUEST',
  'WELCOMED',
  'GETTING_CONNECTED',
  'CONNECTED',
  'SERVING',
  'INACTIVE',
  'MOVED_AWAY',
  'DECEASED',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const FOLLOW_UP_KINDS = [
  'WELCOME',
  'FOLLOW_UP',
  'PROMISED_CHECKIN',
  'CARE',
  'DRIFT_CHECKIN',
  'GROUP_INTRO',
] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const FOLLOW_UP_STATUSES = ['OPEN', 'SNOOZED', 'DONE', 'CANCELLED'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_OUTCOMES = [
  'REACHED',
  'LEFT_MESSAGE',
  'NO_RESPONSE',
  'NOT_NEEDED',
  'THEY_ARE_FINE',
] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

export const ATTENDANCE_KINDS = ['SERVICE', 'GROUP', 'EVENT', 'SERVING'] as const;
export type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];

export const ATTENDANCE_SOURCES = ['CHECKIN', 'LEADER', 'STAFF', 'IMPORT'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export const GROUP_TYPES = [
  'SMALL_GROUP',
  'MINISTRY',
  'SERVING_TEAM',
  'CLASS',
  'SUPPORT',
  'YOUTH',
] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

export const GROUP_OPENNESS = ['PUBLIC', 'CLOSED', 'SECRET'] as const;
export type GroupOpenness = (typeof GROUP_OPENNESS)[number];

export const GROUP_ROLES = ['LEADER', 'CO_LEADER', 'MEMBER', 'HOST', 'APPRENTICE'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['INTERESTED', 'REQUESTED', 'ACTIVE', 'PAUSED', 'LEFT'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const EVENT_REGISTRATION_STATUSES = ['GOING', 'MAYBE', 'WAITLIST', 'CANCELLED'] as const;
export type EventRegistrationStatus = (typeof EVENT_REGISTRATION_STATUSES)[number];

export const CARE_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type CareRequestStatus = (typeof CARE_REQUEST_STATUSES)[number];

export const CARE_PRIORITIES = ['NORMAL', 'HIGH', 'URGENT'] as const;
export type CarePriority = (typeof CARE_PRIORITIES)[number];

/** The *kind of care*, never the person's circumstances: a category can itself be sensitive. */
export const CARE_CATEGORIES = [
  'VISIT',
  'MEAL',
  'PRAYER',
  'PRACTICAL_HELP',
  'CHECK_IN',
  'OTHER',
] as const;
export type CareCategory = (typeof CARE_CATEGORIES)[number];

export const CONTACT_METHODS = ['CALL', 'TEXT', 'EMAIL', 'VISIT', 'IN_PERSON'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const COMMUNICATION_PREFERENCES = ['EMAIL', 'PHONE', 'TEXT', 'IN_PERSON'] as const;
export type CommunicationPreference = (typeof COMMUNICATION_PREFERENCES)[number];

export const SHEPHERD_ROLES = ['WELCOMER', 'SHEPHERD'] as const;
export type ShepherdRole = (typeof SHEPHERD_ROLES)[number];

export const TOUCHPOINT_KINDS = ['ATTEMPT', 'AWAY'] as const;
export type TouchpointKind = (typeof TOUCHPOINT_KINDS)[number];

export const DEDUPE_STATUSES = ['CLEAR', 'NEEDS_REVIEW', 'MERGED'] as const;
export type DedupeStatus = (typeof DEDUPE_STATUSES)[number];

export const BACKGROUND_CHECK_STATUSES = ['NONE', 'PENDING', 'CLEARED', 'EXPIRED'] as const;
export type BackgroundCheckStatus = (typeof BACKGROUND_CHECK_STATUSES)[number];

/** Who may read a prayer request. There is intentionally no PUBLIC tier and no default. */
export const PRAYER_TIERS = ['CARE_ONLY', 'GROUP', 'CHURCH'] as const;
export type PrayerTier = (typeof PRAYER_TIERS)[number];

export const PRAYER_STATUSES = ['ACTIVE', 'ANSWERED', 'EXPIRED', 'ARCHIVED', 'REMOVED'] as const;
export type PrayerStatus = (typeof PRAYER_STATUSES)[number];

/** Portal-side staff roles (stored in the community DB, managed by tenant admins). */
export const STAFF_ROLES = [
  'admin',
  'pastor',
  'care_team',
  'welcome_lead',
  'welcomer',
  'group_leader',
  'moderator',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
