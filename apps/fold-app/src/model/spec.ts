// SPDX-License-Identifier: AGPL-3.0-or-later
// The Fold's church data model, declared as plain data. `build.ts` turns it into Twenty SDK manifests.
// Keeping the model as data lets tests check it (unique ids, reciprocal relations, enums in sync with
// packages/core, no free-text where confidential text must not live) without booting Twenty.
//
// SENSITIVE TEXT RULE (ADR 0004): nothing here stores prayer requests, care notes or anything a
// congregant confided. The only free-text fields are names, schedules, locations and system-generated
// context summaries. `test/model.test.ts` fails if a field is added with a body/notes/comment-style name.
import {
  ATTENDANCE_KINDS,
  ATTENDANCE_SOURCES,
  BACKGROUND_CHECK_STATUSES,
  CARE_CATEGORIES,
  CARE_PRIORITIES,
  CARE_REQUEST_STATUSES,
  COMMUNICATION_PREFERENCES,
  CONTACT_METHODS,
  DEDUPE_STATUSES,
  EVENT_REGISTRATION_STATUSES,
  FOLLOW_UP_KINDS,
  FOLLOW_UP_OUTCOMES,
  FOLLOW_UP_STATUSES,
  GROUP_OPENNESS,
  GROUP_ROLES,
  GROUP_TYPES,
  LIFECYCLE_STAGES,
  MEMBERSHIP_STATUSES,
  SHEPHERD_ROLES,
  TOUCHPOINT_KINDS,
} from '@thefold/core';

export type ScalarType =
  | 'TEXT'
  | 'DATE'
  | 'DATE_TIME'
  | 'INT'
  | 'BOOLEAN'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'ARRAY'
  | 'ADDRESS';

export interface ScalarSpec {
  name: string;
  label: string;
  type: ScalarType;
  icon?: string;
  /** SELECT / MULTI_SELECT values, in display order. */
  options?: readonly string[];
  /** SELECT value or BOOLEAN. */
  default?: string | boolean;
  /** Written by our services as an idempotency key; unique in Twenty. */
  unique?: boolean;
}

export interface ObjectSpec {
  key: string;
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string;
  icon: string;
  fields: readonly ScalarSpec[];
}

const sourceRef: ScalarSpec = {
  name: 'sourceRef',
  label: 'Source reference',
  type: 'TEXT',
  unique: true,
  icon: 'IconKey',
};
const nameField = (label = 'Name'): ScalarSpec => ({
  name: 'name',
  label,
  type: 'TEXT',
  icon: 'IconAbc',
});

export const OBJECTS: readonly ObjectSpec[] = [
  {
    key: 'household',
    nameSingular: 'household',
    namePlural: 'households',
    labelSingular: 'Household',
    labelPlural: 'Households',
    description:
      'People who live together. Drift check-ins are addressed to a household, not to its children.',
    icon: 'IconHome',
    fields: [
      nameField(),
      { name: 'address', label: 'Address', type: 'ADDRESS', icon: 'IconMap' },
      sourceRef,
    ],
  },
  {
    key: 'campus',
    nameSingular: 'campus',
    namePlural: 'campuses',
    labelSingular: 'Campus',
    labelPlural: 'Campuses',
    description:
      'A location the church meets at. Hidden from navigation until a church has more than one.',
    icon: 'IconBuildingChurch',
    fields: [
      nameField(),
      { name: 'timezone', label: 'Time zone (IANA)', type: 'TEXT', icon: 'IconClock' },
    ],
  },
  {
    key: 'attendance',
    nameSingular: 'attendance',
    namePlural: 'attendances',
    labelSingular: 'Attendance',
    labelPlural: 'Attendances',
    description: 'One person present at one service, group meeting, event or serving shift.',
    icon: 'IconCalendarCheck',
    fields: [
      nameField('Label'),
      { name: 'date', label: 'Date', type: 'DATE', icon: 'IconCalendar' },
      {
        name: 'kind',
        label: 'Kind',
        type: 'SELECT',
        options: ATTENDANCE_KINDS,
        default: 'SERVICE',
      },
      { name: 'source', label: 'Recorded by', type: 'SELECT', options: ATTENDANCE_SOURCES },
      { name: 'ref', label: 'Group / event reference', type: 'TEXT' },
      sourceRef,
    ],
  },
  {
    key: 'churchGroup',
    nameSingular: 'churchGroup',
    namePlural: 'churchGroups',
    labelSingular: 'Group',
    labelPlural: 'Groups',
    description: 'Small groups, ministries, serving teams and classes.',
    icon: 'IconUsersGroup',
    fields: [
      nameField(),
      {
        name: 'groupType',
        label: 'Type',
        type: 'SELECT',
        options: GROUP_TYPES,
        default: 'SMALL_GROUP',
      },
      {
        name: 'openness',
        label: 'Who can find it',
        type: 'SELECT',
        options: GROUP_OPENNESS,
        default: 'CLOSED',
      },
      { name: 'schedule', label: 'Schedule', type: 'TEXT', icon: 'IconClock' },
      { name: 'capacity', label: 'Capacity', type: 'INT', icon: 'IconUsers' },
      { name: 'interests', label: 'Interests', type: 'ARRAY', icon: 'IconTags' },
      { name: 'childFriendly', label: 'Child friendly', type: 'BOOLEAN', default: false },
      { name: 'pausedUntil', label: 'Paused until', type: 'DATE', icon: 'IconPlayerPause' },
      { name: 'description', label: 'Description', type: 'TEXT' },
    ],
  },
  {
    key: 'groupMembership',
    nameSingular: 'groupMembership',
    namePlural: 'groupMemberships',
    labelSingular: 'Group membership',
    labelPlural: 'Group memberships',
    description: 'Who is in which group, in what role.',
    icon: 'IconUserPlus',
    fields: [
      nameField('Label'),
      { name: 'role', label: 'Role', type: 'SELECT', options: GROUP_ROLES, default: 'MEMBER' },
      {
        name: 'status',
        label: 'Status',
        type: 'SELECT',
        options: MEMBERSHIP_STATUSES,
        default: 'INTERESTED',
      },
      { name: 'joinedAt', label: 'Joined', type: 'DATE' },
    ],
  },
  {
    key: 'churchEvent',
    nameSingular: 'churchEvent',
    namePlural: 'churchEvents',
    labelSingular: 'Event',
    labelPlural: 'Events',
    description: 'Gatherings people can RSVP to.',
    icon: 'IconCalendarEvent',
    fields: [
      nameField(),
      { name: 'startsAt', label: 'Starts', type: 'DATE_TIME' },
      { name: 'endsAt', label: 'Ends', type: 'DATE_TIME' },
      { name: 'location', label: 'Location', type: 'TEXT', icon: 'IconMapPin' },
      { name: 'capacity', label: 'Capacity', type: 'INT' },
      { name: 'description', label: 'Description', type: 'TEXT' },
    ],
  },
  {
    key: 'eventRegistration',
    nameSingular: 'eventRegistration',
    namePlural: 'eventRegistrations',
    labelSingular: 'Event registration',
    labelPlural: 'Event registrations',
    description: 'One person’s RSVP to one event.',
    icon: 'IconTicket',
    fields: [
      nameField('Label'),
      {
        name: 'status',
        label: 'RSVP',
        type: 'SELECT',
        options: EVENT_REGISTRATION_STATUSES,
        default: 'GOING',
      },
      { name: 'attended', label: 'Attended', type: 'BOOLEAN', default: false },
    ],
  },
  {
    key: 'followUp',
    nameSingular: 'followUp',
    namePlural: 'followUps',
    labelSingular: 'Follow-up',
    labelPlural: 'Follow-ups',
    description:
      'Something a named person promised to do for someone: welcome a guest, keep a promised check-in, ask how someone is. One owner, one due date, never lost.',
    icon: 'IconHeartHandshake',
    fields: [
      nameField('Title'),
      { name: 'kind', label: 'Kind', type: 'SELECT', options: FOLLOW_UP_KINDS },
      {
        name: 'status',
        label: 'Status',
        type: 'SELECT',
        options: FOLLOW_UP_STATUSES,
        default: 'OPEN',
      },
      { name: 'outcome', label: 'Outcome', type: 'SELECT', options: FOLLOW_UP_OUTCOMES },
      { name: 'dueAt', label: 'Due', type: 'DATE_TIME', icon: 'IconCalendarDue' },
      { name: 'snoozeUntil', label: 'Snoozed until', type: 'DATE_TIME' },
      { name: 'firstActionAt', label: 'First action', type: 'DATE_TIME' },
      { name: 'completedAt', label: 'Completed', type: 'DATE_TIME' },
      { name: 'escalatedAt', label: 'Escalated', type: 'DATE_TIME' },
      // System-generated and non-sensitive, e.g. "usually attends about every 2 weeks; last seen 9 weeks ago".
      { name: 'contextSummary', label: 'Context', type: 'TEXT' },
      sourceRef,
    ],
  },
  {
    key: 'touchpoint',
    nameSingular: 'touchpoint',
    namePlural: 'touchpoints',
    labelSingular: 'Touchpoint',
    labelPlural: 'Touchpoints',
    description:
      'A logged attempt to reach someone, or an interval they are away. Deliberately has no notes field: what a person confides is recorded in the portal, not here.',
    icon: 'IconPhoneCall',
    fields: [
      nameField('Label'),
      {
        name: 'kind',
        label: 'Kind',
        type: 'SELECT',
        options: TOUCHPOINT_KINDS,
        default: 'ATTEMPT',
      },
      { name: 'method', label: 'Method', type: 'SELECT', options: CONTACT_METHODS },
      { name: 'outcome', label: 'Outcome', type: 'SELECT', options: FOLLOW_UP_OUTCOMES },
      { name: 'occurredAt', label: 'When', type: 'DATE_TIME' },
      { name: 'awayStart', label: 'Away from', type: 'DATE' },
      { name: 'awayEnd', label: 'Away until', type: 'DATE' },
      sourceRef,
    ],
  },
  {
    key: 'careRequest',
    nameSingular: 'careRequest',
    namePlural: 'careRequests',
    labelSingular: 'Care request',
    labelPlural: 'Care requests',
    description:
      'Metadata about care being offered. The confidential details live in the community service, referenced by an opaque id. Visible to the care team and pastors only.',
    icon: 'IconHeart',
    fields: [
      nameField('Reference'),
      {
        name: 'status',
        label: 'Status',
        type: 'SELECT',
        options: CARE_REQUEST_STATUSES,
        default: 'OPEN',
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'SELECT',
        options: CARE_PRIORITIES,
        default: 'NORMAL',
      },
      { name: 'category', label: 'Kind of care', type: 'SELECT', options: CARE_CATEGORIES },
      { name: 'communityRef', label: 'Community reference', type: 'TEXT', icon: 'IconLink' },
      { name: 'openedAt', label: 'Opened', type: 'DATE_TIME' },
      { name: 'firstResponseAt', label: 'First response', type: 'DATE_TIME' },
      { name: 'resolvedAt', label: 'Resolved', type: 'DATE_TIME' },
      sourceRef,
    ],
  },
];

/** Fields The Fold adds to Twenty's built-in Person. */
export const PERSON_FIELDS: readonly ScalarSpec[] = [
  {
    name: 'lifecycleStage',
    label: 'Lifecycle stage',
    type: 'SELECT',
    options: LIFECYCLE_STAGES,
    default: 'NEW_GUEST',
    icon: 'IconRoute',
  },
  { name: 'firstVisitDate', label: 'First visit', type: 'DATE', icon: 'IconDoorEnter' },
  { name: 'welcomedAt', label: 'Welcomed', type: 'DATE_TIME', icon: 'IconHandStop' },
  {
    name: 'dedupeStatus',
    label: 'Duplicate check',
    type: 'SELECT',
    options: DEDUPE_STATUSES,
    default: 'CLEAR',
  },
  { name: 'sourceRef', label: 'Source reference', type: 'TEXT', unique: true, icon: 'IconKey' },
  { name: 'isMinor', label: 'Minor', type: 'BOOLEAN', default: false, icon: 'IconBabyCarriage' },
  { name: 'birthdate', label: 'Birthdate', type: 'DATE', icon: 'IconCake' },
  {
    name: 'isHouseholdPrimaryContact',
    label: 'Household primary contact',
    type: 'BOOLEAN',
    default: false,
  },
  { name: 'sharedEmail', label: 'Email shared with family', type: 'BOOLEAN', default: false },
  {
    name: 'shepherdRoles',
    label: 'Volunteer roles',
    type: 'MULTI_SELECT',
    options: SHEPHERD_ROLES,
  },
  { name: 'maxOpenItems', label: 'Most open follow-ups', type: 'INT', icon: 'IconGauge' },
  { name: 'interests', label: 'Interests', type: 'ARRAY', icon: 'IconTags' },
  { name: 'awayUntil', label: 'Away until', type: 'DATE', icon: 'IconPlane' },
  { name: 'acceptedGapDays', label: 'Normal gap between visits (days)', type: 'INT' },
  {
    name: 'doNotContact',
    label: 'Do not contact',
    type: 'BOOLEAN',
    default: false,
    icon: 'IconBellOff',
  },
  { name: 'consentEmail', label: 'OK to email', type: 'BOOLEAN', default: false },
  { name: 'consentPhone', label: 'OK to call', type: 'BOOLEAN', default: false },
  { name: 'consentSms', label: 'OK to text', type: 'BOOLEAN', default: false },
  { name: 'consentAt', label: 'Consent given', type: 'DATE_TIME' },
  {
    name: 'communicationPreference',
    label: 'Preferred contact',
    type: 'SELECT',
    options: COMMUNICATION_PREFERENCES,
  },
  // Status and date only. The report itself is never stored (FCRA; see docs/privacy-and-safety.md).
  {
    name: 'backgroundCheckStatus',
    label: 'Background check',
    type: 'SELECT',
    options: BACKGROUND_CHECK_STATUSES,
    default: 'NONE',
  },
  { name: 'backgroundCheckDate', label: 'Background check date', type: 'DATE' },
];

export type OnDelete = 'CASCADE' | 'SET_NULL';

/**
 * A relation is declared once and generated on both sides, so the two halves cannot disagree.
 * `many` holds the foreign key; `one` is the inverse collection.
 */
export interface RelationSpec {
  many: { object: string; name: string; label: string };
  one: { object: string; name: string; label: string };
  onDelete: OnDelete;
}

export const RELATIONS: readonly RelationSpec[] = [
  {
    many: { object: 'person', name: 'household', label: 'Household' },
    one: { object: 'household', name: 'members', label: 'Members' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'person', name: 'campus', label: 'Campus' },
    one: { object: 'campus', name: 'people', label: 'People' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'person', name: 'primaryShepherd', label: 'Primary shepherd' },
    one: { object: 'person', name: 'shepherdedPeople', label: 'People they shepherd' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'person', name: 'guardian', label: 'Guardian' },
    one: { object: 'person', name: 'dependents', label: 'Dependents' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'attendance', name: 'person', label: 'Person' },
    one: { object: 'person', name: 'attendances', label: 'Attendances' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'churchGroup', name: 'campus', label: 'Campus' },
    one: { object: 'campus', name: 'groups', label: 'Groups' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'groupMembership', name: 'person', label: 'Person' },
    one: { object: 'person', name: 'groupMemberships', label: 'Group memberships' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'groupMembership', name: 'group', label: 'Group' },
    one: { object: 'churchGroup', name: 'memberships', label: 'Memberships' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'churchEvent', name: 'group', label: 'Group' },
    one: { object: 'churchGroup', name: 'events', label: 'Events' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'churchEvent', name: 'campus', label: 'Campus' },
    one: { object: 'campus', name: 'events', label: 'Events' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'eventRegistration', name: 'person', label: 'Person' },
    one: { object: 'person', name: 'eventRegistrations', label: 'Event registrations' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'eventRegistration', name: 'event', label: 'Event' },
    one: { object: 'churchEvent', name: 'registrations', label: 'Registrations' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'followUp', name: 'subject', label: 'About' },
    one: { object: 'person', name: 'followUpsAbout', label: 'Follow-ups about them' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'followUp', name: 'owner', label: 'Owner' },
    one: { object: 'person', name: 'followUpsOwned', label: 'Follow-ups they own' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'touchpoint', name: 'followUp', label: 'Follow-up' },
    one: { object: 'followUp', name: 'touchpoints', label: 'Touchpoints' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'touchpoint', name: 'person', label: 'Person' },
    one: { object: 'person', name: 'touchpoints', label: 'Touchpoints' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'touchpoint', name: 'actor', label: 'Made by' },
    one: { object: 'person', name: 'touchpointsMade', label: 'Touchpoints they made' },
    onDelete: 'SET_NULL',
  },
  {
    many: { object: 'careRequest', name: 'person', label: 'Person' },
    one: { object: 'person', name: 'careRequests', label: 'Care requests' },
    onDelete: 'CASCADE',
  },
  {
    many: { object: 'careRequest', name: 'owner', label: 'Owner' },
    one: { object: 'person', name: 'careRequestsOwned', label: 'Care requests they own' },
    onDelete: 'SET_NULL',
  },
];
