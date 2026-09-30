// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  addDays,
  fromEpochDay,
  median,
  toEpochDay,
  weekIndex,
  weekStart,
  type DateInterval,
  type LocalDate,
} from '../dates.js';

export interface AttendanceRecord {
  personId: string;
  date: LocalDate;
}

export interface TenantHealthConfig {
  /** Trailing window used to decide whether attendance is being recorded at all. */
  healthWindowDays: number;
  /** Distinct attendees required inside the window; below this the whole run is skipped. */
  minRecentDistinctAttendees: number;
  /** How many completed weeks back to look for church-wide breaks (covers the lapsed cap). */
  breakLookbackWeeks: number;
  /** Rolling number of prior non-break weeks used as the baseline. */
  breakBaselineWeeks: number;
  /** A week is a break when its distinct attendees fall below this fraction of the baseline median. */
  breakThreshold: number;
  /** Non-break weeks of history required before a week can be judged a break. */
  minBaselineWeeks: number;
}

export const DEFAULT_TENANT_HEALTH_CONFIG: Readonly<TenantHealthConfig> = {
  healthWindowDays: 21,
  minRecentDistinctAttendees: 5,
  breakLookbackWeeks: 60,
  breakBaselineWeeks: 8,
  breakThreshold: 0.5,
  minBaselineWeeks: 4,
};

export interface TenantAttendanceAnalysis {
  /** False when nobody seems to be recording attendance; the drift run must be skipped and an admin alerted. */
  healthy: boolean;
  recentDistinctAttendees: number;
  /** Church-wide low-attendance weeks (Mon–Sun), to be excluded from every person's gaps. */
  breakWeeks: DateInterval[];
}

/**
 * Guards against the two ways a drift run can hurt people: flagging everyone because attendance
 * capture silently stopped, and flagging everyone who missed Christmas week.
 * Only completed weeks strictly before `asOf`'s week are judged for breaks.
 */
export function analyzeTenantAttendance(
  records: readonly AttendanceRecord[],
  asOf: LocalDate,
  overrides: Partial<TenantHealthConfig> = {},
): TenantAttendanceAnalysis {
  const cfg = { ...DEFAULT_TENANT_HEALTH_CONFIG, ...overrides };

  const windowStart = addDays(asOf, -(cfg.healthWindowDays - 1));
  const recent = new Set<string>();
  const perWeek = new Map<number, Set<string>>();
  for (const r of records) {
    if (r.date > asOf) continue;
    if (r.date >= windowStart) recent.add(r.personId);
    const w = weekIndex(r.date);
    let set = perWeek.get(w);
    if (!set) perWeek.set(w, (set = new Set()));
    set.add(r.personId);
  }

  const breakWeeks: DateInterval[] = [];
  const currentWeek = weekIndex(asOf);
  const weeks = [...perWeek.keys()];
  if (weeks.length > 0) {
    const firstWeek = Math.max(Math.min(...weeks), currentWeek - cfg.breakLookbackWeeks);
    const recentNonBreak: number[] = [];
    for (let w = firstWeek; w < currentWeek; w++) {
      const count = perWeek.get(w)?.size ?? 0;
      const baseline = recentNonBreak.slice(-cfg.breakBaselineWeeks);
      const isBreak =
        baseline.length >= cfg.minBaselineWeeks && count < cfg.breakThreshold * median(baseline);
      if (isBreak) {
        const start = weekStart(w);
        breakWeeks.push({ start, end: fromEpochDay(toEpochDay(start) + 6) });
      } else {
        recentNonBreak.push(count);
      }
    }
  }

  return {
    healthy: recent.size >= cfg.minRecentDistinctAttendees,
    recentDistinctAttendees: recent.size,
    breakWeeks,
  };
}
