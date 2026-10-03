// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  excludedDaysBetween,
  fromEpochDay,
  isoWeekLabel,
  median,
  mergeIntervals,
  toEpochDay,
  toLocalDate,
  toLocalParts,
  weekIndex,
  weekStart,
} from '../src/index.js';

const anyDay = fc
  .integer({ min: toEpochDay('1990-01-01'), max: toEpochDay('2100-12-31') })
  .map(fromEpochDay);

describe('LocalDate arithmetic', () => {
  it('round-trips epoch days', () => {
    expect(toEpochDay('1970-01-01')).toBe(0);
    expect(fromEpochDay(0)).toBe('1970-01-01');
    expect(fromEpochDay(toEpochDay('2026-09-30'))).toBe('2026-09-30');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-9-3', 'yesterday', '', '2026-00-10'])(
    'rejects %j',
    (bad) => {
      expect(() => toEpochDay(bad)).toThrow(RangeError);
    },
  );

  it('handles leap days', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
  });

  it('property: addDays and diffDays are inverses', () => {
    fc.assert(
      fc.property(anyDay, fc.integer({ min: -4000, max: 4000 }), (d, n) => {
        expect(addDays(addDays(d, n), -n)).toBe(d);
        expect(diffDays(addDays(d, n), d)).toBe(n);
      }),
    );
  });
});

describe('ISO weeks', () => {
  it('puts Monday..Sunday in one week', () => {
    // 2026-09-28 is a Monday; 2026-09-30 (today in the test fixtures) is a Wednesday.
    const w = weekIndex('2026-09-28');
    for (const d of ['2026-09-28', '2026-09-30', '2026-10-04']) expect(weekIndex(d)).toBe(w);
    expect(weekIndex('2026-10-05')).toBe(w + 1);
    expect(weekIndex('2026-09-27')).toBe(w - 1);
  });

  it('week starts fall on Mondays', () => {
    expect(weekStart(weekIndex('2026-10-04'))).toBe('2026-09-28');
  });

  it.each([
    ['2026-09-30', '2026-W40'],
    ['2021-01-03', '2020-W53'],
    ['2018-12-31', '2019-W01'],
    ['2020-12-31', '2020-W53'],
    ['2026-01-01', '2026-W01'],
    ['2025-12-29', '2026-W01'],
  ])('labels %s as %s', (date, label) => {
    expect(isoWeekLabel(date)).toBe(label);
  });

  it('property: every day lies inside its own Monday-started week', () => {
    fc.assert(
      fc.property(anyDay, (d) => {
        const start = weekStart(weekIndex(d));
        expect(diffDays(d, start)).toBeGreaterThanOrEqual(0);
        expect(diffDays(d, start)).toBeLessThan(7);
        expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
      }),
    );
  });
});

describe('time zones', () => {
  it('uses the tenant calendar day, not the UTC day', () => {
    // 03:30Z on Monday 28 Sep is still Sunday evening in Los Angeles.
    expect(toLocalDate('2026-09-28T03:30:00Z', 'America/Los_Angeles')).toBe('2026-09-27');
    expect(toLocalDate('2026-09-28T03:30:00Z', 'UTC')).toBe('2026-09-28');
    expect(weekIndex(toLocalDate('2026-09-28T03:30:00Z', 'America/Los_Angeles'))).toBe(
      weekIndex('2026-09-27'),
    );
    expect(weekIndex(toLocalDate('2026-09-28T03:30:00Z', 'UTC'))).toBe(weekIndex('2026-09-28'));
  });

  it('crosses the date line', () => {
    expect(toLocalDate('2026-01-01T03:30:00Z', 'America/New_York')).toBe('2025-12-31');
    expect(toLocalDate('2026-01-01T03:30:00Z', 'Pacific/Auckland')).toBe('2026-01-01');
  });

  it('is correct on the spring-forward day', () => {
    expect(toLocalDate('2026-03-08T06:59:59Z', 'America/New_York')).toBe('2026-03-08');
    expect(toLocalParts(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York').hour).toBe(3);
  });

  it('reports midnight as hour 0, never 24', () => {
    const p = toLocalParts(Date.parse('2026-01-01T05:00:00Z'), 'America/New_York');
    expect(p).toEqual({ date: '2026-01-01', hour: 0, isoWeekday: 4 });
  });

  it('rejects invalid instants', () => {
    expect(() => toLocalDate('not a date', 'UTC')).toThrow(RangeError);
  });
});

describe('intervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(
      mergeIntervals([
        { start: '2026-01-10', end: '2026-01-12' },
        { start: '2026-01-01', end: '2026-01-05' },
        { start: '2026-01-06', end: '2026-01-08' },
        { start: '2026-01-11', end: '2026-01-20' },
      ]),
    ).toEqual([
      { start: '2026-01-01', end: '2026-01-08' },
      { start: '2026-01-10', end: '2026-01-20' },
    ]);
  });

  it('counts excluded days in (from, to]', () => {
    const merged = mergeIntervals([{ start: '2026-01-05', end: '2026-01-09' }]);
    expect(excludedDaysBetween(merged, '2026-01-01', '2026-01-31')).toBe(5);
    expect(excludedDaysBetween(merged, '2026-01-05', '2026-01-31')).toBe(4); // exclusive start
    expect(excludedDaysBetween(merged, '2026-01-01', '2026-01-07')).toBe(3);
    expect(excludedDaysBetween(merged, '2026-01-20', '2026-01-10')).toBe(0);
  });

  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(() => median([])).toThrow();
  });
});
