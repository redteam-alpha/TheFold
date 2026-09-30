// SPDX-License-Identifier: AGPL-3.0-or-later
import { toLocalParts } from '../dates.js';

export const NOTIFICATION_CATEGORIES = [
  'SECURITY',
  'FOLLOW_UP_DUE',
  'CARE_ASSIGNMENT',
  'DIRECT_REPLY',
  'QUESTION_ANSWER',
  'EVENT_REMINDER',
  'GROUP_ACTIVITY',
  'PRAYER',
  'ANNOUNCEMENT',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type DeliveryMode = 'IMMEDIATE' | 'DIGEST' | 'OFF';

/** Digest-by-default: only work that someone is waiting on is immediate. */
export const DEFAULT_DELIVERY_MODES: Readonly<Record<NotificationCategory, DeliveryMode>> = {
  SECURITY: 'IMMEDIATE',
  FOLLOW_UP_DUE: 'IMMEDIATE',
  CARE_ASSIGNMENT: 'IMMEDIATE',
  DIRECT_REPLY: 'DIGEST',
  QUESTION_ANSWER: 'DIGEST',
  EVENT_REMINDER: 'DIGEST',
  GROUP_ACTIVITY: 'DIGEST',
  PRAYER: 'DIGEST',
  ANNOUNCEMENT: 'DIGEST',
};

export interface NotificationPrefs {
  modes: Partial<Record<NotificationCategory, DeliveryMode>>;
  /** Local hours; `endHour` may be smaller than `startHour` (wraps midnight). Null = none. */
  quietHours: { startHour: number; endHour: number } | null;
  digestCadence: 'DAILY' | 'WEEKLY';
  /** Local hour the digest goes out. */
  digestHour: number;
  /** 1 = Monday … 7 = Sunday; used when cadence is WEEKLY. */
  digestIsoWeekday: number;
  timeZone: string;
  /** No email at all (except SECURITY). The in-app inbox still fills. */
  emailOptOut: boolean;
}

export interface PendingNotification {
  id: string;
  category: NotificationCategory;
  createdAt: number;
  /** Care, prayer or anything confidential: the email carries a count and a link, never content. */
  sensitive: boolean;
}

export interface DigestGroup {
  category: NotificationCategory;
  count: number;
  ids: string[];
  /** Renderer must show "You have N updates" with a login link instead of any content. */
  redact: boolean;
}

export interface DeliveryPlan {
  /** Send an email now, one per id. */
  sendNow: string[];
  digest: { due: boolean; groups: DigestGroup[] };
  /** Not emailed (opted out or category off); they stay in the in-app inbox. */
  inAppOnly: string[];
}

export const MAX_IMMEDIATE_PER_DAY = 3;

function inQuietHours(hour: number, q: NotificationPrefs['quietHours']): boolean {
  if (!q || q.startHour === q.endHour) return false;
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

/**
 * Notification hygiene as code: digest by default, quiet hours respected, a daily cap on
 * immediate emails (overflow rolls into the digest), an empty digest is never sent, and
 * confidential items are redacted. SECURITY messages are exempt from every limit.
 */
export function planDelivery(input: {
  prefs: NotificationPrefs;
  pending: readonly PendingNotification[];
  now: number;
  /** Immediate emails already sent today (local day). */
  immediateSentToday: number;
  lastDigestAt: number | null;
  maxImmediatePerDay?: number;
}): DeliveryPlan {
  const { prefs, now } = input;
  const cap = input.maxImmediatePerDay ?? MAX_IMMEDIATE_PER_DAY;
  const local = toLocalParts(now, prefs.timeZone);
  const quiet = inQuietHours(local.hour, prefs.quietHours);

  const sendNow: string[] = [];
  const inAppOnly: string[] = [];
  const digestBucket: PendingNotification[] = [];
  let immediateBudget = Math.max(0, cap - input.immediateSentToday);

  const ordered = [...input.pending].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  for (const n of ordered) {
    if (n.category === 'SECURITY') {
      sendNow.push(n.id);
      continue;
    }
    const mode = prefs.modes[n.category] ?? DEFAULT_DELIVERY_MODES[n.category];
    if (mode === 'OFF' || prefs.emailOptOut) {
      inAppOnly.push(n.id);
    } else if (mode === 'IMMEDIATE' && !quiet && immediateBudget > 0) {
      sendNow.push(n.id);
      immediateBudget--;
    } else {
      digestBucket.push(n); // DIGEST, quiet hours, or over the daily cap
    }
  }

  const groups = new Map<NotificationCategory, DigestGroup>();
  for (const n of digestBucket) {
    const g = groups.get(n.category) ?? { category: n.category, count: 0, ids: [], redact: false };
    g.count++;
    g.ids.push(n.id);
    g.redact ||= n.sensitive;
    groups.set(n.category, g);
  }
  const digestGroups = [...groups.values()].sort(
    (a, b) =>
      NOTIFICATION_CATEGORIES.indexOf(a.category) - NOTIFICATION_CATEGORIES.indexOf(b.category),
  );

  return {
    sendNow,
    // A digest is never emailed during quiet hours; it goes out at the next opportunity after they end.
    digest: {
      due: digestGroups.length > 0 && !quiet && isDigestDue(prefs, now, input.lastDigestAt),
      groups: digestGroups,
    },
    inAppOnly,
  };
}

/** Due at or after the local digest hour (and, when weekly, on the digest weekday), once per period. */
export function isDigestDue(
  prefs: NotificationPrefs,
  now: number,
  lastDigestAt: number | null,
): boolean {
  const local = toLocalParts(now, prefs.timeZone);
  if (local.hour < prefs.digestHour) return false;
  const last = lastDigestAt == null ? null : toLocalParts(lastDigestAt, prefs.timeZone);
  if (last && last.date >= local.date) return false; // already sent today
  if (prefs.digestCadence === 'DAILY') return true;
  if (local.isoWeekday === prefs.digestIsoWeekday) return true;
  // Catch-up: a weekly digest missed by more than a week still goes out.
  return lastDigestAt != null && now - lastDigestAt > 8 * 86_400_000;
}
