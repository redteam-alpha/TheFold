// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FollowUpOutcome, LifecycleStage } from '../domain.js';

/**
 * Tunable drift parameters. Defaults come from the research in docs/research: static thresholds
 * are distrusted by staff, and the typical churched adult attends ~1.6 times a month, so the
 * baseline is each person's own rhythm rather than a church-wide "missed N weeks" rule.
 */
export interface DriftConfig {
  /** Baseline window, measured back from the person's last engagement. */
  lookbackDays: number;
  /** Minimum distinct active weeks inside the window before we trust a baseline. */
  minActiveWeeks: number;
  /** Minimum days between first and last engagement inside the window. */
  minSpanDays: number;
  /** Never flag before this many days without engagement. */
  floorDays: number;
  /** Threshold multiplier on the person's median gap. */
  medianMultiplier: number;
  /** Threshold multiplier on the person's longest baseline gap (or accepted gap). */
  longestGapMultiplier: number;
  /** Beyond this many days the person goes to the quarterly pastor review list, not a check-in. */
  reviewAfterDays: number;
  /** Beyond this many days we stop surfacing the person; staff should update their lifecycle. */
  lapsedAfterDays: number;
  /** Quiet period after a personal contact attempt (reached, left message, no response). */
  cooldownAfterContactDays: number;
  /** Quiet period after "they're fine" or "not needed". */
  cooldownAfterFineDays: number;
  /** Lifecycle stages for which drift is evaluated at all. */
  eligibleStages: readonly LifecycleStage[];
  /** Default cap of open drift items per shepherd. */
  perOwnerCap: number;
}

export const DEFAULT_DRIFT_CONFIG: Readonly<DriftConfig> = {
  lookbackDays: 180,
  minActiveWeeks: 4,
  minSpanDays: 28,
  floorDays: 21,
  medianMultiplier: 3,
  longestGapMultiplier: 1.5,
  reviewAfterDays: 180,
  lapsedAfterDays: 365,
  cooldownAfterContactDays: 42,
  cooldownAfterFineDays: 90,
  eligibleStages: ['GETTING_CONNECTED', 'CONNECTED', 'SERVING'],
  perOwnerCap: 5,
};

/** Outcomes that mean "someone tried"; they start the shorter cooldown. */
export const CONTACT_ATTEMPT_OUTCOMES: readonly FollowUpOutcome[] = [
  'REACHED',
  'LEFT_MESSAGE',
  'NO_RESPONSE',
];

/** Outcomes that mean "no action needed"; they start the longer cooldown. */
export const NO_ACTION_OUTCOMES: readonly FollowUpOutcome[] = ['THEY_ARE_FINE', 'NOT_NEEDED'];
