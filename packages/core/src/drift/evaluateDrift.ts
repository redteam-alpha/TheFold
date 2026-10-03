// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  addDays,
  diffDays,
  excludedDaysBetween,
  maxDate,
  mergeIntervals,
  median,
  weekIndex,
  weekStart,
  type DateInterval,
  type LocalDate,
} from '../dates.js';
import type { FollowUpOutcome, LifecycleStage } from '../domain.js';
import {
  CONTACT_ATTEMPT_OUTCOMES,
  DEFAULT_DRIFT_CONFIG,
  NO_ACTION_OUTCOMES,
  type DriftConfig,
} from './config.js';

export interface DriftInput {
  /** Person id, or household id when a household is evaluated as one unit. */
  unitId: string;
  /** Today, in the tenant's time zone. */
  asOf: LocalDate;
  /**
   * Confirmed engagement days only: service, group, event or serving attendance.
   * RSVPs and portal activity are deliberately not signals.
   */
  engagementDates: readonly LocalDate[];
  lifecycleStage: LifecycleStage;
  isMinor: boolean;
  doNotContact: boolean;
  awayUntil?: LocalDate | null;
  /** Gap (days) staff told us is normal for this person; raises the threshold. */
  acceptedGapDays?: number | null;
  /** Days that should not count against anyone: away intervals, paused groups, church-wide breaks. */
  excludedIntervals: readonly DateInterval[];
  hasOpenDriftFollowUp: boolean;
  hasOpenCareRequest: boolean;
  snoozedUntil?: LocalDate | null;
  lastOutcome?: { outcome: FollowUpOutcome; on: LocalDate } | null;
}

export type DriftSkipReason =
  | 'MINOR'
  | 'DO_NOT_CONTACT'
  | 'INELIGIBLE_STAGE'
  | 'AWAY'
  | 'SNOOZED'
  | 'OPEN_DRIFT_FOLLOWUP'
  | 'OPEN_CARE_REQUEST'
  | 'COOLDOWN'
  | 'INSUFFICIENT_DATA'
  | 'WITHIN_BASELINE'
  | 'LONG_LAPSED';

export interface DriftContext {
  lastEngagement: LocalDate;
  /** Median gap between active weeks, in days, after exclusions. */
  medianGapDays: number;
  longestGapDays: number;
  thresholdDays: number;
  /** Days since the later of last engagement and the end of any away period, after exclusions. */
  currentGapDays: number;
  activeWeeks: number;
  /** Human-readable, non-sensitive. Never derived from messages or prayer content. */
  summary: string;
}

export type DriftResult =
  /** Create a compassionate check-in item for a shepherd. Nothing is ever sent to the person. */
  | { decision: 'FLAG'; unitId: string; context: DriftContext; orderingRatio: number }
  /** Too long gone for a routine check-in; goes on the quarterly pastor review list. */
  | { decision: 'REVIEW_LIST'; unitId: string; context: DriftContext }
  | { decision: 'SKIP'; unitId: string; reason: DriftSkipReason };

const skip = (unitId: string, reason: DriftSkipReason): DriftResult => ({
  decision: 'SKIP',
  unitId,
  reason,
});

/**
 * Baseline-relative drift detection.
 *
 * There is no score. The function answers one question: "has this person been away noticeably
 * longer than *their own* rhythm, and is it appropriate to ask a shepherd to check in?".
 * `orderingRatio` exists only to order a shepherd's queue; it must never be shown to anyone.
 *
 * Threshold: T = max(floor, 3·median gap, 1.5·max(longest baseline gap, accepted gap)).
 * Flag when T < currentGap <= reviewAfterDays.
 */
export function evaluateDrift(
  input: DriftInput,
  overrides: Partial<DriftConfig> = {},
): DriftResult {
  const cfg: DriftConfig = { ...DEFAULT_DRIFT_CONFIG, ...overrides };
  const { unitId, asOf } = input;

  // ---- eligibility -------------------------------------------------------------------------
  if (input.isMinor) return skip(unitId, 'MINOR');
  if (input.doNotContact) return skip(unitId, 'DO_NOT_CONTACT');
  if (!cfg.eligibleStages.includes(input.lifecycleStage)) return skip(unitId, 'INELIGIBLE_STAGE');
  if (input.awayUntil && input.awayUntil >= asOf) return skip(unitId, 'AWAY');
  if (input.snoozedUntil && input.snoozedUntil >= asOf) return skip(unitId, 'SNOOZED');
  if (input.hasOpenDriftFollowUp) return skip(unitId, 'OPEN_DRIFT_FOLLOWUP');
  if (input.hasOpenCareRequest) return skip(unitId, 'OPEN_CARE_REQUEST');

  if (input.lastOutcome) {
    const since = diffDays(asOf, input.lastOutcome.on);
    const { outcome } = input.lastOutcome;
    if (CONTACT_ATTEMPT_OUTCOMES.includes(outcome) && since < cfg.cooldownAfterContactDays) {
      return skip(unitId, 'COOLDOWN');
    }
    if (NO_ACTION_OUTCOMES.includes(outcome) && since < cfg.cooldownAfterFineDays) {
      return skip(unitId, 'COOLDOWN');
    }
  }

  // ---- baseline ----------------------------------------------------------------------------
  const dates = [...new Set(input.engagementDates)].filter((d) => d <= asOf).sort();
  const lastEngagement = dates[dates.length - 1];
  if (lastEngagement === undefined) return skip(unitId, 'INSUFFICIENT_DATA');

  const windowStart = addDays(lastEngagement, -cfg.lookbackDays);
  const windowDates = dates.filter((d) => d >= windowStart);
  const firstInWindow = windowDates[0] as string;
  const activeWeeks = [...new Set(windowDates.map(weekIndex))].sort((a, b) => a - b);

  if (
    activeWeeks.length < cfg.minActiveWeeks ||
    diffDays(lastEngagement, firstInWindow) < cfg.minSpanDays
  ) {
    return skip(unitId, 'INSUFFICIENT_DATA');
  }

  const excluded = mergeIntervals(input.excludedIntervals);
  const gaps: number[] = [];
  for (let i = 1; i < activeWeeks.length; i++) {
    const from = weekStart(activeWeeks[i - 1] as number);
    const to = weekStart(activeWeeks[i] as number);
    gaps.push(Math.max(0, diffDays(to, from) - excludedDaysBetween(excluded, from, to)));
  }
  const medianGap = median(gaps);
  const longestGap = Math.max(...gaps);

  const threshold = Math.max(
    cfg.floorDays,
    cfg.medianMultiplier * medianGap,
    cfg.longestGapMultiplier * Math.max(longestGap, input.acceptedGapDays ?? 0),
  );

  // ---- current gap -------------------------------------------------------------------------
  const gapStart = input.awayUntil ? maxDate(lastEngagement, input.awayUntil) : lastEngagement;
  const currentGap = Math.max(
    0,
    diffDays(asOf, gapStart) - excludedDaysBetween(excluded, gapStart, asOf),
  );

  const context: DriftContext = {
    lastEngagement,
    medianGapDays: medianGap,
    longestGapDays: longestGap,
    thresholdDays: threshold,
    currentGapDays: currentGap,
    activeWeeks: activeWeeks.length,
    summary: describeRhythm(medianGap, diffDays(asOf, lastEngagement)),
  };

  if (currentGap <= threshold) return skip(unitId, 'WITHIN_BASELINE');
  if (currentGap <= cfg.reviewAfterDays) {
    return { decision: 'FLAG', unitId, context, orderingRatio: currentGap / threshold };
  }
  if (currentGap <= cfg.lapsedAfterDays) return { decision: 'REVIEW_LIST', unitId, context };
  return skip(unitId, 'LONG_LAPSED');
}

/** e.g. "usually attends about every 2 weeks; last seen 9 weeks ago". */
export function describeRhythm(medianGapDays: number, daysSinceLastSeen: number): string {
  const every = Math.max(1, Math.round(medianGapDays / 7));
  const ago = Math.max(1, Math.round(daysSinceLastSeen / 7));
  const rhythm = every === 1 ? 'most weeks' : `about every ${every} weeks`;
  return `usually attends ${rhythm}; last seen ${ago} ${ago === 1 ? 'week' : 'weeks'} ago`;
}
