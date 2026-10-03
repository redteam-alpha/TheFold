// SPDX-License-Identifier: AGPL-3.0-or-later
// Calendar-day arithmetic without a date library. All church data is tenant-local: attendance is
// a calendar day, not an instant. `toLocalDate` is the one place instants become calendar days.

/** A calendar day in the tenant's time zone, formatted `YYYY-MM-DD`. */
export type LocalDate = string;

/** Inclusive on both ends. */
export interface DateInterval {
  start: LocalDate;
  end: LocalDate;
}

const MS_PER_DAY = 86_400_000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 (a Thursday). Throws on malformed or impossible dates. */
export function toEpochDay(date: LocalDate): number {
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid LocalDate: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`Invalid LocalDate: ${date}`);
  }
  return Math.round(ms / MS_PER_DAY);
}

export function fromEpochDay(epochDay: number): LocalDate {
  const d = new Date(epochDay * MS_PER_DAY);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** `a - b` in whole days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return toEpochDay(a) - toEpochDay(b);
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

/**
 * Monday-based ISO week index. Week 0 is the week containing 1970-01-01 (Mon 1969-12-29 – Sun 1970-01-04).
 * The Thursday of week `w` is epoch day `w * 7`, which also fixes the ISO week-year.
 */
export function weekIndex(date: LocalDate): number {
  return Math.floor((toEpochDay(date) + 3) / 7);
}

/** The Monday that starts week `w`. */
export function weekStart(w: number): LocalDate {
  return fromEpochDay(w * 7 - 3);
}

/** `YYYY-Www`, e.g. `2026-W40`. Stable idempotency-key ingredient. */
export function isoWeekLabel(date: LocalDate): string {
  const w = weekIndex(date);
  const thursday = fromEpochDay(w * 7);
  const year = Number(thursday.slice(0, 4));
  const jan1 = toEpochDay(`${String(year).padStart(4, '0')}-01-01`);
  const weekNo = Math.floor((w * 7 - jan1) / 7) + 1;
  return `${String(year).padStart(4, '0')}-W${String(weekNo).padStart(2, '0')}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Converts an instant to the calendar day it falls on in `timeZone` (IANA name). */
export function toLocalDate(instant: Date | number | string, timeZone: string): LocalDate {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid instant: ${String(instant)}`);
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}

/** Sorts and merges overlapping or adjacent intervals. Does not mutate the input. */
export function mergeIntervals(intervals: readonly DateInterval[]): DateInterval[] {
  const spans = intervals
    .map((i) => ({ s: toEpochDay(i.start), e: toEpochDay(i.end) }))
    .filter((i) => i.e >= i.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out: { s: number; e: number }[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.s <= last.e + 1) last.e = Math.max(last.e, span.e);
    else out.push({ ...span });
  }
  return out.map((i) => ({ start: fromEpochDay(i.s), end: fromEpochDay(i.e) }));
}

/**
 * Number of days `d` with `fromExclusive < d <= toInclusive` that fall inside `merged`
 * (which must come from `mergeIntervals`).
 */
export function excludedDaysBetween(
  merged: readonly DateInterval[],
  fromExclusive: LocalDate,
  toInclusive: LocalDate,
): number {
  const lo = toEpochDay(fromExclusive) + 1;
  const hi = toEpochDay(toInclusive);
  if (hi < lo) return 0;
  let total = 0;
  for (const i of merged) {
    const s = Math.max(toEpochDay(i.start), lo);
    const e = Math.min(toEpochDay(i.end), hi);
    if (e >= s) total += e - s + 1;
  }
  return total;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

export interface LocalParts {
  date: LocalDate;
  /** 0–23 in the tenant's time zone. */
  hour: number;
  /** 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
}

/** Calendar day, hour and weekday of an instant in `timeZone`. */
export function toLocalParts(instant: Date | number, timeZone: string): LocalParts {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  const d = instant instanceof Date ? instant : new Date(instant);
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p['year']}-${p['month']}-${p['day']}`;
  const isoWeekday = ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
  return { date, hour: Number(p['hour']) % 24, isoWeekday };
}
