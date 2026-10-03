// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  addDays,
  analyzeTenantAttendance,
  evaluateDrift,
  resolveDriftUnits,
  type AttendanceRecord,
  type DriftPerson,
  type LocalDate,
} from '../src/index.js';

const ASOF = '2026-09-30'; // Wednesday

const sundays = (last: LocalDate, count: number): LocalDate[] =>
  Array.from({ length: count }, (_, i) => addDays(last, -7 * (count - 1 - i)));

function person(over: Partial<DriftPerson> & { id: string }): DriftPerson {
  return {
    householdId: null,
    isMinor: false,
    lifecycleStage: 'CONNECTED',
    doNotContact: false,
    engagementDates: [],
    ...over,
  };
}

describe('analyzeTenantAttendance', () => {
  /** `people` distinct attendees every Sunday for `weeks` weeks ending `last`, minus overrides. */
  function attendance(
    last: LocalDate,
    weeks: number,
    people: number,
    perWeekOverride: Record<string, number> = {},
  ) {
    const rows: AttendanceRecord[] = [];
    for (const d of sundays(last, weeks)) {
      const n = perWeekOverride[d] ?? people;
      for (let p = 0; p < n; p++) rows.push({ personId: `p${p}`, date: d });
    }
    return rows;
  }

  it('is healthy when people are being recorded', () => {
    const a = analyzeTenantAttendance(attendance('2026-09-27', 20, 30), ASOF);
    expect(a.healthy).toBe(true);
    expect(a.breakWeeks).toEqual([]);
  });

  it('is unhealthy when no attendance was recorded in the last 21 days (capture stopped)', () => {
    const a = analyzeTenantAttendance(attendance('2026-08-30', 20, 30), ASOF);
    expect(a.healthy).toBe(false);
    expect(a.recentDistinctAttendees).toBe(0);
  });

  it('is unhealthy with no data at all', () => {
    expect(analyzeTenantAttendance([], ASOF)).toMatchObject({ healthy: false, breakWeeks: [] });
  });

  it('detects a church-wide break week (Christmas) and returns it as Monday–Sunday', () => {
    const rows = attendance('2026-09-27', 40, 30, { '2026-06-14': 4 });
    const a = analyzeTenantAttendance(rows, ASOF);
    expect(a.breakWeeks).toEqual([{ start: '2026-06-08', end: '2026-06-14' }]);
  });

  it('treats a zero-attendance week in the middle of history as a break, not a mass lapse', () => {
    const rows = attendance('2026-09-27', 40, 30).filter((r) => r.date !== '2026-05-31');
    const a = analyzeTenantAttendance(rows, ASOF);
    expect(a.breakWeeks).toEqual([{ start: '2026-05-25', end: '2026-05-31' }]);
  });

  it('does not judge the current, incomplete week', () => {
    const rows = [...attendance('2026-09-27', 20, 30), { personId: 'p0', date: '2026-09-29' }];
    expect(analyzeTenantAttendance(rows, ASOF).breakWeeks).toEqual([]);
  });

  it('needs history before it will call anything a break', () => {
    const rows = attendance('2026-09-27', 3, 30, { '2026-09-13': 1 });
    expect(analyzeTenantAttendance(rows, ASOF).breakWeeks).toEqual([]);
  });

  it('does not treat weeks before the tenant started recording as breaks', () => {
    const a = analyzeTenantAttendance(attendance('2026-09-27', 10, 30), ASOF);
    expect(a.breakWeeks).toEqual([]);
  });

  it('feeds evaluateDrift: a person is not flagged for missing the church-wide break week', () => {
    const rows = attendance('2026-09-27', 40, 30, { '2026-06-14': 4 });
    const { breakWeeks } = analyzeTenantAttendance(rows, ASOF);
    // Attends weekly, except the closed week, then stops after 19 Jul.
    const dates = sundays('2026-07-19', 12).filter((d) => d !== '2026-06-14');
    const common = {
      unitId: 'u',
      asOf: ASOF,
      engagementDates: dates,
      lifecycleStage: 'CONNECTED' as const,
    };
    const base = {
      ...common,
      isMinor: false,
      doNotContact: false,
      hasOpenDriftFollowUp: false,
      hasOpenCareRequest: false,
    };
    const naive = evaluateDrift({ ...base, excludedIntervals: [] });
    const aware = evaluateDrift({ ...base, excludedIntervals: breakWeeks });
    expect(naive.decision === 'FLAG' && naive.context.longestGapDays).toBe(14);
    expect(aware.decision === 'FLAG' && aware.context.longestGapDays).toBe(7);
  });
});

describe('resolveDriftUnits', () => {
  it('never evaluates a minor on their own', () => {
    const { units, skipped } = resolveDriftUnits([person({ id: 'kid', isMinor: true })]);
    expect(units).toEqual([]);
    expect(skipped).toEqual([{ personId: 'kid', reason: 'MINOR_WITHOUT_ADULT' }]);
  });

  it('evaluates a household on the union of its members, so kids attending keeps the family "present"', () => {
    const { units } = resolveDriftUnits([
      person({
        id: 'mom',
        householdId: 'h1',
        isPrimaryContact: true,
        engagementDates: ['2026-05-03'],
      }),
      person({ id: 'dad', householdId: 'h1', engagementDates: ['2026-05-10'] }),
      person({
        id: 'kid',
        householdId: 'h1',
        isMinor: true,
        engagementDates: ['2026-05-03', '2026-05-17'],
      }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      unitId: 'household:h1',
      subjectPersonId: 'mom',
      memberIds: ['dad', 'kid', 'mom'],
      engagementDates: ['2026-05-03', '2026-05-10', '2026-05-17'],
    });
  });

  it('addresses the item to an adult who can be contacted, never to a minor or a do-not-contact adult', () => {
    const { units } = resolveDriftUnits([
      person({ id: 'a', householdId: 'h', isPrimaryContact: true, doNotContact: true }),
      person({ id: 'b', householdId: 'h' }),
      person({ id: 'kid', householdId: 'h', isMinor: true }),
    ]);
    expect(units[0]?.subjectPersonId).toBe('b');
  });

  it('skips a household where every adult opted out of contact', () => {
    const { units, skipped } = resolveDriftUnits([
      person({ id: 'a', householdId: 'h', doNotContact: true }),
      person({ id: 'kid', householdId: 'h', isMinor: true }),
    ]);
    expect(units).toEqual([]);
    expect(skipped).toEqual([{ personId: 'a', reason: 'DO_NOT_CONTACT' }]);
  });

  it('takes the largest accepted gap in the household and treats a lone adult as a person unit', () => {
    const { units } = resolveDriftUnits([
      person({ id: 'a', householdId: 'h', acceptedGapDays: 30 }),
      person({ id: 'b', householdId: 'h', acceptedGapDays: 50 }),
      person({ id: 'solo', householdId: null }),
      person({ id: 'onlyAdult', householdId: 'h2' }),
    ]);
    expect(units.find((u) => u.unitId === 'household:h')?.acceptedGapDays).toBe(50);
    expect(units.map((u) => u.unitId)).toEqual(['household:h', 'person:onlyAdult', 'person:solo']);
  });

  it('choice of subject is stable regardless of input order', () => {
    const people = [
      person({ id: 'z', householdId: 'h' }),
      person({ id: 'm', householdId: 'h' }),
      person({ id: 'a', householdId: 'h' }),
    ];
    const one = resolveDriftUnits(people).units[0]?.subjectPersonId;
    const two = resolveDriftUnits([...people].reverse()).units[0]?.subjectPersonId;
    expect(one).toBe('a');
    expect(two).toBe('a');
  });
});
