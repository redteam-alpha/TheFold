// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ESCALATION_POLICY,
  WELCOME_SEQUENCE,
  nextFollowUpAction,
  pickWelcomer,
  planWelcomeSequence,
  type FollowUpClock,
  type WelcomerCandidate,
} from '../src/index.js';

const HOUR = 3_600_000;
const opts = { today: '2026-09-30', tenantId: 't1' };

interface Sim {
  id: string;
  weight: number;
  maxOpen: number;
  open: number;
  recent: number;
  last: number | null;
  total: number;
}

function simulate(
  arrivals: number,
  welcomers: { id: string; weight?: number; maxOpen?: number }[],
) {
  const state = new Map<string, Sim>(
    welcomers.map((w) => [
      w.id,
      {
        id: w.id,
        weight: w.weight ?? 1,
        maxOpen: w.maxOpen ?? 1_000_000,
        open: 0,
        recent: 0,
        last: null,
        total: 0,
      },
    ]),
  );
  let pooled = 0;
  for (let i = 0; i < arrivals; i++) {
    const candidates: WelcomerCandidate[] = [...state.values()].map((s) => ({
      id: s.id,
      weight: s.weight,
      openCount: s.open,
      assignedLast30d: s.recent,
      maxOpen: s.maxOpen,
      lastAssignedAt: s.last,
    }));
    const pick = pickWelcomer(candidates, { id: `guest${i}` }, opts);
    if (pick.kind === 'POOL') {
      pooled++;
      continue;
    }
    const s = state.get(pick.welcomerId) as Sim;
    s.open++;
    s.recent++;
    s.last = i;
    s.total++;
  }
  return { state, pooled };
}

describe('pickWelcomer', () => {
  it('spreads 1000 guests evenly across equal-weight welcomers (max − min ≤ 1)', () => {
    const { state } = simulate(1000, [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
      { id: 'f' },
      { id: 'g' },
    ]);
    const totals = [...state.values()].map((s) => s.total);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('gives a weight-2 welcomer about twice the guests of a weight-1', () => {
    const { state } = simulate(1000, [
      { id: 'big', weight: 2 },
      { id: 'small', weight: 1 },
    ]);
    const big = state.get('big')?.total ?? 0;
    const small = state.get('small')?.total ?? 0;
    expect(Math.abs(big - 2 * small)).toBeLessThanOrEqual(3);
  });

  it('property: fair for any number of equal-weight welcomers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 300 }),
        (n, guests) => {
          const { state } = simulate(
            guests,
            Array.from({ length: n }, (_, i) => ({ id: `w${i}` })),
          );
          const totals = [...state.values()].map((s) => s.total);
          expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never exceeds anyone’s maxOpen, then falls back to the pastor pool', () => {
    const { state, pooled } = simulate(20, [
      { id: 'a', maxOpen: 3 },
      { id: 'b', maxOpen: 3 },
      { id: 'c', maxOpen: 3 },
    ]);
    for (const s of state.values()) expect(s.open).toBeLessThanOrEqual(3);
    expect(pooled).toBe(11);
  });

  it('is deterministic and independent of candidate order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            openCount: fc.integer({ min: 0, max: 4 }),
            assignedLast30d: fc.integer({ min: 0, max: 6 }),
            lastAssignedAt: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.string(),
        (rows, guestId) => {
          const candidates: WelcomerCandidate[] = rows.map((r, i) => ({
            id: `w${i}`,
            maxOpen: 10,
            ...r,
          }));
          const a = pickWelcomer(candidates, { id: guestId }, opts);
          const b = pickWelcomer([...candidates].reverse(), { id: guestId }, opts);
          expect(b).toEqual(a);
          expect(pickWelcomer(candidates, { id: guestId }, opts)).toEqual(a);
        },
      ),
    );
  });

  it('breaks ties by least-recently assigned', () => {
    const pick = pickWelcomer(
      [
        { id: 'recent', openCount: 1, assignedLast30d: 1, maxOpen: 5, lastAssignedAt: 900 },
        { id: 'long-ago', openCount: 1, assignedLast30d: 1, maxOpen: 5, lastAssignedAt: 100 },
        { id: 'never', openCount: 1, assignedLast30d: 1, maxOpen: 5, lastAssignedAt: null },
      ],
      { id: 'g' },
      opts,
    );
    expect(pick).toEqual({ kind: 'ASSIGNED', welcomerId: 'never' });
  });

  it('never assigns a welcomer to their own family or to themselves', () => {
    const c = (id: string): WelcomerCandidate => ({
      id,
      openCount: 0,
      assignedLast30d: 0,
      maxOpen: 5,
      lastAssignedAt: null,
    });
    expect(
      pickWelcomer([c('mom'), c('other')], { id: 'guest', householdMemberIds: ['mom'] }, opts),
    ).toEqual({ kind: 'ASSIGNED', welcomerId: 'other' });
    expect(pickWelcomer([c('me')], { id: 'me' }, opts)).toEqual({
      kind: 'POOL',
      reason: 'NO_ELIGIBLE_WELCOMER',
    });
  });

  it('skips welcomers who are away, and respects campus', () => {
    const base = { openCount: 0, assignedLast30d: 0, maxOpen: 5, lastAssignedAt: null };
    const list: WelcomerCandidate[] = [
      { id: 'away', ...base, awayUntil: '2026-10-05' },
      { id: 'back', ...base, awayUntil: '2026-09-20' },
      { id: 'north', ...base, campusIds: ['north'] },
    ];
    expect(pickWelcomer(list, { id: 'g', campusId: 'south' }, opts)).toEqual({
      kind: 'ASSIGNED',
      welcomerId: 'back',
    });
    expect(
      pickWelcomer([list[2] as WelcomerCandidate], { id: 'g', campusId: 'south' }, opts).kind,
    ).toBe('POOL');
    expect(
      pickWelcomer([list[2] as WelcomerCandidate], { id: 'g', campusId: 'north' }, opts).kind,
    ).toBe('ASSIGNED');
    expect(pickWelcomer([list[2] as WelcomerCandidate], { id: 'g' }, opts).kind).toBe('POOL');
  });

  it('falls back to the pool when nobody is eligible', () => {
    expect(pickWelcomer([], { id: 'g' }, opts)).toEqual({
      kind: 'POOL',
      reason: 'NO_ELIGIBLE_WELCOMER',
    });
  });
});

describe('welcome sequence', () => {
  it('plans a 48h welcome, a day-7 invite and a day-21 check-in', () => {
    const t0 = Date.parse('2026-09-27T15:00:00Z');
    const plan = planWelcomeSequence(t0);
    expect(plan.map((p) => [p.kind, (p.dueAt - t0) / HOUR])).toEqual([
      ['WELCOME', 48],
      ['GROUP_INTRO', 168],
      ['FOLLOW_UP', 504],
    ]);
    expect(WELCOME_SEQUENCE).toHaveLength(3);
  });
});

describe('nextFollowUpAction', () => {
  const t0 = 1_000_000_000_000;
  const open = (over: Partial<FollowUpClock> = {}): FollowUpClock => ({
    status: 'OPEN',
    createdAt: t0,
    ...over,
  });

  it('leaves a fresh follow-up alone', () => {
    expect(nextFollowUpAction(open(), t0 + 35 * HOUR)).toBe('NONE');
  });
  it('reminds the owner once, at 36h', () => {
    expect(nextFollowUpAction(open(), t0 + 36 * HOUR)).toBe('REMIND_OWNER');
    expect(nextFollowUpAction(open({ remindedAt: t0 + 36 * HOUR }), t0 + 40 * HOUR)).toBe('NONE');
  });
  it('notifies the welcome lead (not the pastor) once, at 72h', () => {
    expect(nextFollowUpAction(open({ remindedAt: t0 + 36 * HOUR }), t0 + 72 * HOUR)).toBe(
      'NOTIFY_LEAD',
    );
    expect(nextFollowUpAction(open({ escalatedAt: t0 + 72 * HOUR }), t0 + 100 * HOUR)).toBe('NONE');
  });
  it('escalates even if the 36h reminder was missed', () => {
    expect(nextFollowUpAction(open(), t0 + 80 * HOUR)).toBe('NOTIFY_LEAD');
  });
  it('leaves alone anyone who has started, finished, cancelled, or is snoozed', () => {
    const late = t0 + 100 * HOUR;
    expect(nextFollowUpAction(open({ firstActionAt: t0 + HOUR }), late)).toBe('NONE');
    expect(nextFollowUpAction(open({ status: 'DONE' }), late)).toBe('NONE');
    expect(nextFollowUpAction(open({ status: 'CANCELLED' }), late)).toBe('NONE');
    expect(nextFollowUpAction(open({ status: 'SNOOZED', snoozeUntil: late + HOUR }), late)).toBe(
      'NONE',
    );
    expect(nextFollowUpAction(open({ status: 'SNOOZED', snoozeUntil: late - HOUR }), late)).toBe(
      'NOTIFY_LEAD',
    );
  });
  it('the policy matches the documented 36h / 72h', () => {
    expect(ESCALATION_POLICY).toEqual({ remindOwnerAfterHours: 36, notifyLeadAfterHours: 72 });
  });
});
