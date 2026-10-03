// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FollowUpKind, FollowUpStatus } from '../domain.js';

const HOUR_MS = 3_600_000;

/**
 * The welcome path for a first-time guest. 48h is a *design target*, not proven science: the widely
 * quoted "36 hours / 48 hours" statistics could not be traced to a primary study (see
 * docs/research/church-and-community-practices.md). What the evidence does support is that most
 * guests who leave contact details get no follow-up at all.
 */
export const WELCOME_SEQUENCE = [
  { kind: 'WELCOME', offsetHours: 48, label: 'Personal welcome (call, text or visit)' },
  { kind: 'GROUP_INTRO', offsetHours: 7 * 24, label: 'Invite to an event or a group' },
  { kind: 'FOLLOW_UP', offsetHours: 21 * 24, label: 'Check in: do you feel connected?' },
] as const satisfies readonly { kind: FollowUpKind; offsetHours: number; label: string }[];

export interface PlannedFollowUp {
  kind: FollowUpKind;
  dueAt: number;
  label: string;
}

/** Follow-ups to create when a guest first appears. `firstVisitAt` is epoch ms. */
export function planWelcomeSequence(firstVisitAt: number): PlannedFollowUp[] {
  return WELCOME_SEQUENCE.map((s) => ({
    kind: s.kind,
    dueAt: firstVisitAt + s.offsetHours * HOUR_MS,
    label: s.label,
  }));
}

export const ESCALATION_POLICY = {
  /** Gentle reminder to the owner, measured from when the follow-up was created. */
  remindOwnerAfterHours: 36,
  /** Tell the welcome-team lead (never the pastor) and offer a reassign. Nudge, not shame. */
  notifyLeadAfterHours: 72,
} as const;

export interface FollowUpClock {
  status: FollowUpStatus;
  createdAt: number;
  /** Set when the owner first logged any attempt. */
  firstActionAt?: number | null;
  snoozeUntil?: number | null;
  remindedAt?: number | null;
  escalatedAt?: number | null;
}

export type FollowUpAction = 'NONE' | 'REMIND_OWNER' | 'NOTIFY_LEAD';

/**
 * What, if anything, the system should do about an unattended follow-up right now.
 * Each action fires at most once (guarded by `remindedAt` / `escalatedAt`). Anyone who has taken a
 * first action, snoozed, finished or cancelled is left alone.
 */
export function nextFollowUpAction(
  f: FollowUpClock,
  now: number,
  policy: typeof ESCALATION_POLICY = ESCALATION_POLICY,
): FollowUpAction {
  if (f.status === 'DONE' || f.status === 'CANCELLED') return 'NONE';
  if (f.status === 'SNOOZED' && (f.snoozeUntil ?? Infinity) > now) return 'NONE';
  if (f.firstActionAt != null) return 'NONE';

  const age = now - f.createdAt;
  if (age >= policy.notifyLeadAfterHours * HOUR_MS && f.escalatedAt == null) return 'NOTIFY_LEAD';
  if (
    age >= policy.remindOwnerAfterHours * HOUR_MS &&
    age < policy.notifyLeadAfterHours * HOUR_MS &&
    f.remindedAt == null
  ) {
    return 'REMIND_OWNER';
  }
  return 'NONE';
}
