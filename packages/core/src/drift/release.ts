// SPDX-License-Identifier: AGPL-3.0-or-later
import { isoWeekLabel, type LocalDate } from '../dates.js';
import type { FollowUpOutcome } from '../domain.js';
import { DEFAULT_DRIFT_CONFIG } from './config.js';

export type DriftOwner = { kind: 'PERSON'; personId: string } | { kind: 'POOL'; poolId: string };

/**
 * Who is asked to check in: the person's own shepherd, else a leader of the group they were most
 * recently active in, else the campus pastor pool. Never the person themselves.
 */
export function resolveDriftOwner(input: {
  subjectPersonId: string;
  primaryShepherdId?: string | null;
  /** Leaders of the subject's groups, most recently attended first. */
  groupLeaderIdsByRecency?: readonly string[];
  campusPastorPoolId: string;
}): DriftOwner {
  const notSelf = (id: string | null | undefined): id is string =>
    !!id && id !== input.subjectPersonId;
  if (notSelf(input.primaryShepherdId)) {
    return { kind: 'PERSON', personId: input.primaryShepherdId };
  }
  const leader = input.groupLeaderIdsByRecency?.find(notSelf);
  if (leader) return { kind: 'PERSON', personId: leader };
  return { kind: 'POOL', poolId: input.campusPastorPoolId };
}

/** One item per unit per ISO week, no matter how many times the nightly job runs. */
export function driftIdempotencyKey(unitId: string, asOf: LocalDate): string {
  return `drift:${unitId}:${isoWeekLabel(asOf)}`;
}

export interface ReleaseCandidate {
  unitId: string;
  /** Key of the owner the item would be assigned to (person id or pool id). */
  ownerKey: string;
  orderingRatio: number;
}

/**
 * Applies the per-shepherd cap. Candidates over the cap are simply deferred: they stay eligible on
 * the next run and no backlog is created. Most-overdue-relative-to-their-own-rhythm first.
 */
export function selectDriftReleases<T extends ReleaseCandidate>(
  candidates: readonly T[],
  openCountsByOwner: Readonly<Record<string, number>>,
  cap: number = DEFAULT_DRIFT_CONFIG.perOwnerCap,
): { release: T[]; deferred: T[] } {
  const counts = new Map(Object.entries(openCountsByOwner));
  const ordered = [...candidates].sort(
    (a, b) => b.orderingRatio - a.orderingRatio || a.unitId.localeCompare(b.unitId),
  );
  const release: T[] = [];
  const deferred: T[] = [];
  for (const c of ordered) {
    const open = counts.get(c.ownerKey) ?? 0;
    if (open < cap) {
      release.push(c);
      counts.set(c.ownerKey, open + 1);
    } else {
      deferred.push(c);
    }
  }
  return { release, deferred };
}

export interface DriftOutcomeState {
  acceptedGapDays: number | null;
  consecutiveNoResponse: number;
  awayUntil: LocalDate | null;
}

export interface DriftOutcomeResult extends DriftOutcomeState {
  /** Tell a pastor (aggregate awareness list); do not keep nagging the person. */
  pastorAwareness: boolean;
}

/**
 * What a shepherd's recorded outcome changes. "They're fine" is a first-class, valid result: it
 * teaches the system that this gap is normal for this person.
 */
export function applyDriftOutcome(
  state: DriftOutcomeState,
  event: {
    outcome: FollowUpOutcome;
    currentGapDays: number;
    /** Set when the shepherd learns the person is travelling or away until a date. */
    awayUntil?: LocalDate | null;
  },
): DriftOutcomeResult {
  const away = event.awayUntil ?? state.awayUntil;
  switch (event.outcome) {
    case 'THEY_ARE_FINE':
      return {
        acceptedGapDays: Math.max(state.acceptedGapDays ?? 0, event.currentGapDays),
        consecutiveNoResponse: 0,
        awayUntil: away,
        pastorAwareness: false,
      };
    case 'NO_RESPONSE':
    case 'LEFT_MESSAGE': {
      const n = state.consecutiveNoResponse + 1;
      return {
        acceptedGapDays: state.acceptedGapDays,
        consecutiveNoResponse: n,
        awayUntil: away,
        pastorAwareness: n >= 2,
      };
    }
    case 'REACHED':
    case 'NOT_NEEDED':
      return {
        acceptedGapDays: state.acceptedGapDays,
        consecutiveNoResponse: 0,
        awayUntil: away,
        pastorAwareness: false,
      };
  }
}
