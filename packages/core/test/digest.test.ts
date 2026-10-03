// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isDigestDue,
  planDelivery,
  type NotificationPrefs,
  type PendingNotification,
} from '../src/index.js';

const DAY = 86_400_000;
// 14:00Z = 10:00 in New York (EDT) on Wednesday 30 Sep 2026.
const MORNING = Date.parse('2026-09-30T14:00:00Z');
// 02:00Z on 1 Oct = 22:00 on the 30th in New York: inside quiet hours 21→7.
const NIGHT = Date.parse('2026-10-01T02:00:00Z');

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  modes: {},
  quietHours: { startHour: 21, endHour: 7 },
  digestCadence: 'DAILY',
  digestHour: 8,
  digestIsoWeekday: 1,
  timeZone: 'America/New_York',
  emailOptOut: false,
  ...over,
});
const n = (
  id: string,
  category: PendingNotification['category'],
  sensitive = false,
  createdAt = MORNING,
): PendingNotification => ({
  id,
  category,
  createdAt,
  sensitive,
});

describe('planDelivery', () => {
  it('digests by default and emails only the work someone is waiting on', () => {
    const plan = planDelivery({
      prefs: prefs(),
      now: MORNING,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [
        n('1', 'GROUP_ACTIVITY'),
        n('2', 'FOLLOW_UP_DUE'),
        n('3', 'GROUP_ACTIVITY'),
        n('4', 'EVENT_REMINDER'),
      ],
    });
    expect(plan.sendNow).toEqual(['2']);
    expect(plan.digest.due).toBe(true);
    expect(plan.digest.groups).toEqual([
      { category: 'EVENT_REMINDER', count: 1, ids: ['4'], redact: false },
      { category: 'GROUP_ACTIVITY', count: 2, ids: ['1', '3'], redact: false },
    ]);
  });

  it('holds immediate messages during quiet hours and never sends the digest then either', () => {
    const plan = planDelivery({
      prefs: prefs(),
      now: NIGHT,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [n('1', 'FOLLOW_UP_DUE'), n('2', 'GROUP_ACTIVITY')],
    });
    expect(plan.sendNow).toEqual([]);
    expect(plan.digest.due).toBe(false);
    expect(plan.digest.groups.flatMap((g) => g.ids).sort()).toEqual(['1', '2']);
  });

  it('caps immediate emails per day; overflow rolls into the digest', () => {
    const plan = planDelivery({
      prefs: prefs(),
      now: MORNING,
      immediateSentToday: 2,
      lastDigestAt: null,
      pending: [
        n('1', 'FOLLOW_UP_DUE', false, 1),
        n('2', 'FOLLOW_UP_DUE', false, 2),
        n('3', 'CARE_ASSIGNMENT', false, 3),
      ],
    });
    expect(plan.sendNow).toEqual(['1']);
    expect(plan.digest.groups.flatMap((g) => g.ids)).toEqual(['2', '3']);
  });

  it('security messages ignore quiet hours, the cap, opt-outs and category settings', () => {
    const plan = planDelivery({
      prefs: prefs({ emailOptOut: true, modes: { SECURITY: 'OFF' } }),
      now: NIGHT,
      immediateSentToday: 99,
      lastDigestAt: null,
      pending: [n('1', 'SECURITY'), n('2', 'GROUP_ACTIVITY')],
    });
    expect(plan.sendNow).toEqual(['1']);
    expect(plan.inAppOnly).toEqual(['2']);
  });

  it('honours OFF and the email opt-out by leaving items in the in-app inbox only', () => {
    const off = planDelivery({
      prefs: prefs({ modes: { GROUP_ACTIVITY: 'OFF' } }),
      now: MORNING,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [n('1', 'GROUP_ACTIVITY'), n('2', 'PRAYER')],
    });
    expect(off.inAppOnly).toEqual(['1']);
    expect(off.digest.groups.map((g) => g.category)).toEqual(['PRAYER']);
  });

  it('lets a person choose immediate for a category, still subject to the cap', () => {
    const plan = planDelivery({
      prefs: prefs({ modes: { DIRECT_REPLY: 'IMMEDIATE' } }),
      now: MORNING,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [n('1', 'DIRECT_REPLY')],
    });
    expect(plan.sendNow).toEqual(['1']);
  });

  it('redacts digest groups containing anything confidential', () => {
    const plan = planDelivery({
      prefs: prefs(),
      now: MORNING,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [n('1', 'PRAYER', true), n('2', 'PRAYER', false), n('3', 'ANNOUNCEMENT', false)],
    });
    expect(plan.digest.groups.find((g) => g.category === 'PRAYER')).toMatchObject({
      count: 2,
      redact: true,
    });
    expect(plan.digest.groups.find((g) => g.category === 'ANNOUNCEMENT')).toMatchObject({
      redact: false,
    });
  });

  it('never sends an empty digest', () => {
    const plan = planDelivery({
      prefs: prefs(),
      now: MORNING,
      immediateSentToday: 0,
      lastDigestAt: null,
      pending: [],
    });
    expect(plan.digest).toEqual({ due: false, groups: [] });
  });

  it('is deterministic regardless of input order', () => {
    const items = [
      n('b', 'GROUP_ACTIVITY', false, 5),
      n('a', 'GROUP_ACTIVITY', false, 5),
      n('c', 'FOLLOW_UP_DUE', false, 1),
    ];
    const args = { prefs: prefs(), now: MORNING, immediateSentToday: 0, lastDigestAt: null };
    expect(planDelivery({ ...args, pending: items })).toEqual(
      planDelivery({ ...args, pending: [...items].reverse() }),
    );
  });
});

describe('isDigestDue', () => {
  it('waits for the local digest hour', () => {
    expect(isDigestDue(prefs(), Date.parse('2026-09-30T11:00:00Z'), null)).toBe(false); // 07:00 local
    expect(isDigestDue(prefs(), Date.parse('2026-09-30T12:00:00Z'), null)).toBe(true); // 08:00 local
  });
  it('sends at most once per local day', () => {
    expect(isDigestDue(prefs(), MORNING, MORNING - 2 * 3_600_000)).toBe(false);
    expect(isDigestDue(prefs(), MORNING, MORNING - DAY)).toBe(true);
  });
  it('weekly digests go out on the chosen weekday', () => {
    const weekly = prefs({ digestCadence: 'WEEKLY', digestIsoWeekday: 1 });
    expect(isDigestDue(weekly, MORNING, MORNING - 3 * DAY)).toBe(false); // Wednesday
    const monday = Date.parse('2026-09-28T14:00:00Z');
    expect(isDigestDue(weekly, monday, monday - 7 * DAY)).toBe(true);
  });
  it('a weekly digest that was missed for over a week still goes out', () => {
    const weekly = prefs({ digestCadence: 'WEEKLY', digestIsoWeekday: 1 });
    expect(isDigestDue(weekly, MORNING, MORNING - 10 * DAY)).toBe(true);
  });
  it('uses the tenant time zone, not UTC, for "today"', () => {
    // 03:00Z on 1 Oct is still 30 Sep evening in New York, so "already sent today" compares local dates.
    const evening = Date.parse('2026-10-01T03:00:00Z');
    expect(isDigestDue(prefs(), evening, Date.parse('2026-09-30T20:00:00Z'))).toBe(false);
  });
});
