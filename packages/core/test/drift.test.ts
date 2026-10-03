// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyDriftOutcome,
  describeRhythm,
  driftIdempotencyKey,
  evaluateDrift,
  resolveDriftOwner,
  selectDriftReleases,
  type DriftInput,
  type LocalDate,
} from '../src/index.js';

// 2026-09-27 is a Sunday; 2026-09-30 is the Wednesday after.
const ASOF = '2026-09-30';

const input = (over: Partial<DriftInput> = {}): DriftInput => ({
  unitId: 'u1',
  asOf: ASOF,
  engagementDates: [],
  lifecycleStage: 'CONNECTED',
  isMinor: false,
  doNotContact: false,
  awayUntil: null,
  acceptedGapDays: null,
  excludedIntervals: [],
  hasOpenDriftFollowUp: false,
  hasOpenCareRequest: false,
  snoozedUntil: null,
  lastOutcome: null,
  ...over,
});

/** `count` dates `step` days apart, the last being `last`. */
const rhythm = (last: LocalDate, count: number, step: number): LocalDate[] =>
  Array.from({ length: count }, (_, i) => addDays(last, -step * (count - 1 - i)));

const decision = (i: DriftInput) => evaluateDrift(i);

describe('evaluateDrift: baseline sufficiency', () => {
  it('skips with only three data points', () => {
    const r = decision(input({ engagementDates: rhythm('2026-08-09', 3, 7) }));
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'INSUFFICIENT_DATA' });
  });

  it('skips a newcomer with four consecutive weeks (span < 28 days); the welcome pipeline owns them', () => {
    const r = decision(input({ engagementDates: rhythm('2026-08-09', 4, 7) }));
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'INSUFFICIENT_DATA' });
  });

  it('skips with no engagement at all', () => {
    expect(decision(input())).toMatchObject({ decision: 'SKIP', reason: 'INSUFFICIENT_DATA' });
  });

  it('ignores engagement dated in the future', () => {
    const r = decision(
      input({ engagementDates: ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'] }),
    );
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'INSUFFICIENT_DATA' });
  });
});

describe('evaluateDrift: own-rhythm threshold', () => {
  const weekly = rhythm('2026-09-06', 12, 7);

  it('flags a weekly regular after three missed Sundays', () => {
    // Last seen Sunday 6 Sep; missed 13th, 20th and 27th; today is the Monday after (28th).
    const r = decision(input({ asOf: '2026-09-28', engagementDates: weekly }));
    expect(r).toMatchObject({ decision: 'FLAG' });
    if (r.decision === 'FLAG') {
      expect(r.context.currentGapDays).toBe(22);
      expect(r.context.thresholdDays).toBe(21);
      expect(r.context.medianGapDays).toBe(7);
      expect(r.context.summary).toBe('usually attends most weeks; last seen 3 weeks ago');
      expect(r.orderingRatio).toBeCloseTo(22 / 21);
    }
  });

  it('does not flag on the third missed Sunday itself (gap = 21 is not > 21)', () => {
    const r = decision(input({ asOf: '2026-09-27', engagementDates: weekly }));
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'WITHIN_BASELINE' });
  });

  it('does not flag an every-three-weeks attender at five weeks', () => {
    const r = decision(input({ asOf: '2026-10-04', engagementDates: rhythm('2026-08-30', 8, 21) }));
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'WITHIN_BASELINE' });
  });

  it('flags that same attender once they are well past their own rhythm', () => {
    const r = decision(input({ asOf: '2026-11-08', engagementDates: rhythm('2026-08-30', 8, 21) }));
    expect(r.decision).toBe('FLAG');
    if (r.decision === 'FLAG') {
      expect(r.context.medianGapDays).toBe(21);
      expect(r.context.thresholdDays).toBe(63);
      expect(r.context.summary).toBe('usually attends about every 3 weeks; last seen 10 weeks ago');
    }
  });

  it('counts two engagements in the same week once', () => {
    // The Wednesday before each Sunday is in the same Monday–Sunday week.
    const midweek = weekly.map((d) => addDays(d, -4));
    const asOf = '2026-09-28';
    const plain = decision(input({ asOf, engagementDates: weekly }));
    const doubled = decision(input({ asOf, engagementDates: [...weekly, ...midweek] }));
    expect(plain.decision).toBe('FLAG');
    expect(doubled).toEqual(plain);
  });

  it('a later engagement in a *new* week does move "last seen", but not the rhythm', () => {
    const nextWeek = weekly.map((d) => addDays(d, 3)); // the Wednesday after each Sunday: the following week
    const asOf = '2026-10-05'; // 26 days after the last Wednesday, 29 after the last Sunday
    const plain = decision(input({ asOf, engagementDates: weekly }));
    const shifted = decision(input({ asOf, engagementDates: [...weekly, ...nextWeek] }));
    expect(plain.decision).toBe('FLAG');
    expect(shifted.decision).toBe('FLAG');
    if (plain.decision === 'FLAG' && shifted.decision === 'FLAG') {
      expect(shifted.context.lastEngagement).toBe('2026-09-09');
      expect(plain.context.lastEngagement).toBe('2026-09-06');
      expect(shifted.context.medianGapDays).toBe(7);
    }
  });

  it('is independent of the order and duplication of input dates', () => {
    const a = decision(input({ asOf: '2026-09-28', engagementDates: weekly }));
    const b = decision(
      input({ asOf: '2026-09-28', engagementDates: [...weekly, ...weekly].reverse() }),
    );
    expect(b).toEqual(a);
  });

  it('honours acceptedGapDays after a shepherd said "they are fine"', () => {
    const base = input({ asOf: '2026-10-16', engagementDates: weekly }); // 40 days since 6 Sep
    expect(decision(base).decision).toBe('FLAG');
    expect(decision({ ...base, acceptedGapDays: 40 })).toMatchObject({
      decision: 'SKIP',
      reason: 'WITHIN_BASELINE', // T = 1.5 × 40 = 60
    });
  });
});

describe('evaluateDrift: exclusions', () => {
  const weekly = rhythm('2026-08-30', 12, 7);

  it('does not count time the person was marked away', () => {
    const flagged = decision(input({ engagementDates: weekly }));
    expect(flagged.decision).toBe('FLAG'); // 31 days since 30 Aug
    const away = decision(
      input({
        engagementDates: weekly,
        excludedIntervals: [{ start: '2026-09-01', end: '2026-09-27' }],
      }),
    );
    expect(away).toMatchObject({ decision: 'SKIP', reason: 'WITHIN_BASELINE' }); // 31 − 27 = 4
  });

  it('skips someone who is away right now, and restarts the clock when they return', () => {
    expect(decision(input({ engagementDates: weekly, awayUntil: '2026-10-05' }))).toMatchObject({
      decision: 'SKIP',
      reason: 'AWAY',
    });
    // Back on 20 Sep: only 10 days of "gap" since return, well within the 21-day floor.
    expect(decision(input({ engagementDates: weekly, awayUntil: '2026-09-20' }))).toMatchObject({
      decision: 'SKIP',
      reason: 'WITHIN_BASELINE',
    });
  });

  it('does not let a church-wide break inflate the baseline', () => {
    // Weekly Sundays 3 May – 19 Jul, skipping 14 Jun (church closed that week: Mon 8 – Sun 14 Jun).
    const dates = rhythm('2026-07-19', 12, 7).filter((d) => d !== '2026-06-14');
    const withoutBreak = decision(input({ engagementDates: dates }));
    const withBreak = decision(
      input({
        engagementDates: dates,
        excludedIntervals: [{ start: '2026-06-08', end: '2026-06-14' }],
      }),
    );
    expect(withoutBreak.decision === 'FLAG' && withoutBreak.context.longestGapDays).toBe(14);
    expect(withBreak.decision === 'FLAG' && withBreak.context.longestGapDays).toBe(7);
  });
});

describe('evaluateDrift: eligibility', () => {
  const weekly = rhythm('2026-08-30', 12, 7);
  const flagged = input({ engagementDates: weekly });
  const cases: [string, Partial<DriftInput>, string][] = [
    ['a minor', { isMinor: true }, 'MINOR'],
    ['do-not-contact', { doNotContact: true }, 'DO_NOT_CONTACT'],
    ['a new guest', { lifecycleStage: 'NEW_GUEST' }, 'INELIGIBLE_STAGE'],
    ['someone inactive', { lifecycleStage: 'INACTIVE' }, 'INELIGIBLE_STAGE'],
    ['someone who moved away', { lifecycleStage: 'MOVED_AWAY' }, 'INELIGIBLE_STAGE'],
    ['a deceased person', { lifecycleStage: 'DECEASED' }, 'INELIGIBLE_STAGE'],
    ['a snoozed person', { snoozedUntil: '2026-10-15' }, 'SNOOZED'],
    ['an open drift check-in', { hasOpenDriftFollowUp: true }, 'OPEN_DRIFT_FOLLOWUP'],
    ['an open care request', { hasOpenCareRequest: true }, 'OPEN_CARE_REQUEST'],
  ];
  it('starts from a flagged baseline', () => expect(decision(flagged).decision).toBe('FLAG'));
  it.each(cases)('skips %s', (_name, over, reason) => {
    expect(decision({ ...flagged, ...over })).toMatchObject({ decision: 'SKIP', reason });
  });

  it.each(['GETTING_CONNECTED', 'CONNECTED', 'SERVING'] as const)('evaluates stage %s', (stage) => {
    expect(decision({ ...flagged, lifecycleStage: stage }).decision).toBe('FLAG');
  });

  describe('cooldowns', () => {
    it.each(['REACHED', 'LEFT_MESSAGE', 'NO_RESPONSE'] as const)(
      '%s cools down for 42 days, then releases',
      (outcome) => {
        expect(
          decision({ ...flagged, lastOutcome: { outcome, on: addDays(ASOF, -41) } }),
        ).toMatchObject({
          decision: 'SKIP',
          reason: 'COOLDOWN',
        });
        expect(
          decision({ ...flagged, lastOutcome: { outcome, on: addDays(ASOF, -42) } }).decision,
        ).toBe('FLAG');
      },
    );
    it.each(['THEY_ARE_FINE', 'NOT_NEEDED'] as const)(
      '%s cools down for 90 days, then releases',
      (outcome) => {
        expect(
          decision({ ...flagged, lastOutcome: { outcome, on: addDays(ASOF, -89) } }),
        ).toMatchObject({
          decision: 'SKIP',
          reason: 'COOLDOWN',
        });
        expect(
          decision({ ...flagged, lastOutcome: { outcome, on: addDays(ASOF, -90) } }).decision,
        ).toBe('FLAG');
      },
    );
  });
});

describe('evaluateDrift: long absences', () => {
  it('sends a 6–12 month absence to the quarterly pastor review list, not a routine check-in', () => {
    const r = decision(input({ engagementDates: rhythm('2026-03-01', 10, 7) })); // 213 days ago
    expect(r.decision).toBe('REVIEW_LIST');
  });

  it('stops surfacing someone after a year; staff should update their lifecycle stage', () => {
    const r = decision(input({ engagementDates: rhythm('2025-08-03', 10, 7) })); // 423 days ago
    expect(r).toMatchObject({ decision: 'SKIP', reason: 'LONG_LAPSED' });
  });
});

describe('evaluateDrift: late-entered attendance', () => {
  it('stops flagging once the missing Sunday is backfilled', () => {
    const dates = rhythm('2026-08-30', 12, 7);
    expect(decision(input({ engagementDates: dates })).decision).toBe('FLAG');
    expect(decision(input({ engagementDates: [...dates, '2026-09-27'] }))).toMatchObject({
      decision: 'SKIP',
      reason: 'WITHIN_BASELINE',
    });
  });
});

describe('evaluateDrift: properties', () => {
  it('for a perfectly weekly attender the decision depends only on days since last seen', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 30 }), fc.integer({ min: 0, max: 450 }), (weeks, k) => {
        const last = '2026-01-04';
        const r = evaluateDrift(
          input({ asOf: addDays(last, k), engagementDates: rhythm(last, weeks, 7) }),
        );
        if (k <= 21) expect(r).toMatchObject({ decision: 'SKIP', reason: 'WITHIN_BASELINE' });
        else if (k <= 180) expect(r.decision).toBe('FLAG');
        else if (k <= 365) expect(r.decision).toBe('REVIEW_LIST');
        else expect(r).toMatchObject({ decision: 'SKIP', reason: 'LONG_LAPSED' });
      }),
    );
  });

  it('never flags a minor or do-not-contact person, whatever their history', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 0, maxLength: 40 }),
        fc.boolean(),
        (offsets, minor) => {
          const dates = offsets.map((o) => addDays('2026-01-01', o));
          const r = evaluateDrift(
            input({ engagementDates: dates, isMinor: minor, doNotContact: !minor }),
          );
          expect(r.decision).toBe('SKIP');
        },
      ),
    );
  });

  it('a flag always has a current gap strictly above its own threshold', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 4, maxLength: 60 }),
        fc.integer({ min: 0, max: 400 }),
        (offsets, extra) => {
          const dates = offsets.map((o) => addDays('2026-01-01', o));
          const r = evaluateDrift(
            input({ asOf: addDays('2026-07-20', extra), engagementDates: dates }),
          );
          if (r.decision === 'FLAG') {
            expect(r.context.currentGapDays).toBeGreaterThan(r.context.thresholdDays);
            expect(r.context.thresholdDays).toBeGreaterThanOrEqual(21);
          }
        },
      ),
    );
  });
});

describe('describeRhythm', () => {
  it('pluralises and rounds', () => {
    expect(describeRhythm(14, 63)).toBe(
      'usually attends about every 2 weeks; last seen 9 weeks ago',
    );
    expect(describeRhythm(7, 8)).toBe('usually attends most weeks; last seen 1 week ago');
  });
});

describe('releasing drift check-ins', () => {
  it('caps open items per shepherd and defers the rest without creating a backlog', () => {
    const candidates = [
      { unitId: 'a', ownerKey: 'p1', orderingRatio: 1.2 },
      { unitId: 'b', ownerKey: 'p1', orderingRatio: 3.0 },
      { unitId: 'c', ownerKey: 'p1', orderingRatio: 2.0 },
      { unitId: 'd', ownerKey: 'p2', orderingRatio: 1.1 },
    ];
    const { release, deferred } = selectDriftReleases(candidates, { p1: 1 }, 3);
    expect(release.map((c) => c.unitId)).toEqual(['b', 'c', 'd']); // p1 had 1 open, room for 2
    expect(deferred.map((c) => c.unitId)).toEqual(['a']);
  });

  it('never exceeds the cap for anyone, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ownerKey: fc.constantFrom('p1', 'p2', 'p3'),
            orderingRatio: fc.double({ min: 1, max: 10, noNaN: true }),
          }),
          { maxLength: 50 },
        ),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 8 }),
        (rows, open, cap) => {
          const candidates = rows.map((r, i) => ({ ...r, unitId: `u${i}` }));
          const { release, deferred } = selectDriftReleases(
            candidates,
            { p1: open, p2: open, p3: open },
            cap,
          );
          expect(release.length + deferred.length).toBe(candidates.length);
          for (const owner of ['p1', 'p2', 'p3']) {
            const n = release.filter((c) => c.ownerKey === owner).length;
            expect(open + n <= Math.max(cap, open)).toBe(true);
          }
        },
      ),
    );
  });

  it('is idempotent per ISO week', () => {
    expect(driftIdempotencyKey('household:h1', '2026-09-28')).toBe('drift:household:h1:2026-W40');
    expect(driftIdempotencyKey('household:h1', '2026-10-04')).toBe('drift:household:h1:2026-W40');
    expect(driftIdempotencyKey('household:h1', '2026-10-05')).toBe('drift:household:h1:2026-W41');
  });

  it('resolves the owner: shepherd, then group leader, then the pastor pool; never the person themselves', () => {
    const base = { subjectPersonId: 'me', campusPastorPoolId: 'pool1' };
    expect(
      resolveDriftOwner({ ...base, primaryShepherdId: 's1', groupLeaderIdsByRecency: ['g1'] }),
    ).toEqual({
      kind: 'PERSON',
      personId: 's1',
    });
    expect(
      resolveDriftOwner({
        ...base,
        primaryShepherdId: 'me',
        groupLeaderIdsByRecency: ['me', 'g2'],
      }),
    ).toEqual({
      kind: 'PERSON',
      personId: 'g2',
    });
    expect(resolveDriftOwner(base)).toEqual({ kind: 'POOL', poolId: 'pool1' });
  });
});

describe('recording outcomes', () => {
  const fresh = { acceptedGapDays: null, consecutiveNoResponse: 0, awayUntil: null };

  it('"they are fine" teaches the system this gap is normal', () => {
    expect(
      applyDriftOutcome(fresh, { outcome: 'THEY_ARE_FINE', currentGapDays: 45 }),
    ).toMatchObject({
      acceptedGapDays: 45,
      pastorAwareness: false,
    });
    expect(
      applyDriftOutcome(
        { ...fresh, acceptedGapDays: 60 },
        { outcome: 'THEY_ARE_FINE', currentGapDays: 45 },
      ).acceptedGapDays,
    ).toBe(60);
  });

  it('two unanswered attempts go to pastor awareness instead of more nagging', () => {
    const one = applyDriftOutcome(fresh, { outcome: 'NO_RESPONSE', currentGapDays: 30 });
    expect(one).toMatchObject({ consecutiveNoResponse: 1, pastorAwareness: false });
    const two = applyDriftOutcome(one, { outcome: 'LEFT_MESSAGE', currentGapDays: 30 });
    expect(two).toMatchObject({ consecutiveNoResponse: 2, pastorAwareness: true });
  });

  it('reaching them resets the counter and can record travel', () => {
    const r = applyDriftOutcome(
      { ...fresh, consecutiveNoResponse: 1 },
      { outcome: 'REACHED', currentGapDays: 30, awayUntil: '2026-12-01' },
    );
    expect(r).toMatchObject({
      consecutiveNoResponse: 0,
      awayUntil: '2026-12-01',
      pastorAwareness: false,
    });
  });
});
