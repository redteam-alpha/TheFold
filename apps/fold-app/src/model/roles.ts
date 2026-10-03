// SPDX-License-Identifier: AGPL-3.0-or-later
import { id } from '@thefold/shared';
import type { defineRole } from 'twenty-sdk/define';
import { ALL_OBJECT_KEYS, objectId } from './build.js';

export type RoleConfig = Parameters<typeof defineRole>[0];

/**
 * Roles use only object- and field-level permissions. Row-level permissions and SSO are enterprise-licensed
 * in Twenty (docs/enterprise-avoid.md) and are never relied on. Confidential text is not in Twenty at all
 * (ADR 0004); the only sensitive object here is careRequest, which carries metadata, and it is visible to
 * admins, pastors and the care team ONLY. Anything not listed is denied.
 */
export const CARE_OBJECT = 'careRequest';
const NON_CARE = ALL_OBJECT_KEYS.filter((k) => k !== CARE_OBJECT);

interface RoleSpec {
  key: string;
  label: string;
  description: string;
  icon: string;
  read: readonly string[];
  update: readonly string[];
  softDelete: readonly string[];
  settings?: boolean;
  /** For the service account the community API uses; never assignable to people. */
  serviceAccount?: boolean;
  /** Person fields this role may not see. */
  hidePersonFields?: readonly string[];
}

const HIDDEN_FROM_MOST = ['backgroundCheckStatus', 'backgroundCheckDate', 'birthdate'] as const;

export const ROLE_SPECS: readonly RoleSpec[] = [
  {
    key: 'admin',
    label: 'Church admin',
    description:
      'Runs the workspace. Can see everything, including care metadata, and change settings.',
    icon: 'IconShieldCheck',
    read: ALL_OBJECT_KEYS,
    update: ALL_OBJECT_KEYS,
    softDelete: ALL_OBJECT_KEYS,
    settings: true,
  },
  {
    key: 'pastor',
    label: 'Pastor',
    description:
      'Sees everyone and all care metadata. Confidential text still requires the portal, with an audit trail.',
    icon: 'IconBuildingChurch',
    read: ALL_OBJECT_KEYS,
    update: ALL_OBJECT_KEYS,
    softDelete: ALL_OBJECT_KEYS,
  },
  {
    key: 'careTeam',
    label: 'Care team',
    description: 'Follows through on care requests and promised check-ins.',
    icon: 'IconHeartHandshake',
    read: [
      'person',
      'household',
      'attendance',
      'churchGroup',
      'groupMembership',
      'followUp',
      'touchpoint',
      'careRequest',
    ],
    update: ['followUp', 'touchpoint', 'careRequest'],
    softDelete: [],
    hidePersonFields: HIDDEN_FROM_MOST.filter((f) => f !== 'birthdate'),
  },
  {
    key: 'welcomeLead',
    label: 'Welcome team lead',
    description:
      'Sees the welcome queue, reassigns follow-ups, and gets a nudge when one runs late. Cannot see care requests.',
    icon: 'IconHandStop',
    read: [
      'person',
      'household',
      'attendance',
      'churchGroup',
      'churchEvent',
      'followUp',
      'touchpoint',
    ],
    update: ['followUp', 'touchpoint'],
    softDelete: [],
    hidePersonFields: HIDDEN_FROM_MOST,
  },
  {
    key: 'staff',
    label: 'Church staff',
    description:
      'Day-to-day CRM work: people, groups, events, attendance. Cannot see care requests.',
    icon: 'IconUsers',
    read: NON_CARE,
    update: NON_CARE,
    softDelete: ['attendance', 'groupMembership', 'eventRegistration', 'touchpoint'],
  },
  {
    key: 'readOnly',
    label: 'Read only',
    description:
      'Can look but not change. Cannot see care requests, background checks or birthdates.',
    icon: 'IconEye',
    read: NON_CARE,
    update: [],
    softDelete: [],
    hidePersonFields: HIDDEN_FROM_MOST,
  },
  {
    key: 'service',
    label: 'The Fold service account',
    description: 'Used only by the community service through an API key. Not assignable to people.',
    icon: 'IconRobot',
    read: ALL_OBJECT_KEYS,
    update: ALL_OBJECT_KEYS,
    softDelete: ['attendance', 'groupMembership', 'eventRegistration', 'followUp', 'touchpoint'],
    serviceAccount: true,
  },
];

export function buildRole(key: string): RoleConfig {
  const spec = ROLE_SPECS.find((r) => r.key === key);
  if (!spec) throw new Error(`Unknown role: ${key}`);
  const objects = new Set([...spec.read, ...spec.update, ...spec.softDelete]);
  return {
    universalIdentifier: id.role(spec.key),
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    canUpdateAllSettings: spec.settings ?? false,
    canBeAssignedToUsers: !spec.serviceAccount,
    canBeAssignedToApiKeys: spec.serviceAccount ?? false,
    canBeAssignedToAgents: false,
    objectPermissions: [...objects].map((o) => ({
      objectUniversalIdentifier: objectId(o),
      canReadObjectRecords: spec.read.includes(o),
      canUpdateObjectRecords: spec.update.includes(o),
      canSoftDeleteObjectRecords: spec.softDelete.includes(o),
      canDestroyObjectRecords: false,
    })),
    fieldPermissions: (spec.hidePersonFields ?? []).map((f) => ({
      objectUniversalIdentifier: objectId('person'),
      fieldUniversalIdentifier: id.field('person', f),
      canReadFieldValue: false,
      canUpdateFieldValue: false,
    })),
  };
}
