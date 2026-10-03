// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GROUP_OPENNESS,
  GROUP_ROLES,
  MEMBERSHIP_STATUSES,
  canDecideRequests,
  canLeave,
  canRequestToJoin,
  canSeeGroup,
  canSeeMembers,
  shortName,
  visibleMembers,
  type GroupFacts,
  type ListedPerson,
  type OwnMembership,
} from '../src/index.js';

const group = fc.record<GroupFacts>({
  openness: fc.constantFrom(...GROUP_OPENNESS),
  deleted: fc.boolean(),
});
const own: fc.Arbitrary<OwnMembership> = fc.option(
  fc.record({
    role: fc.constantFrom(...GROUP_ROLES),
    status: fc.constantFrom(...MEMBERSHIP_STATUSES),
  }),
  { nil: null },
);

describe('group visibility (ADR 0008)', () => {
  it('never shows a deleted group, and shows a secret one only to the people connected to it', () => {
    fc.assert(
      fc.property(group, own, (g, m) => {
        const seen = canSeeGroup(g, m);
        if (g.deleted) expect(seen).toBe(false);
        if (g.openness === 'SECRET' && seen)
          expect(['INTERESTED', 'REQUESTED', 'ACTIVE', 'PAUSED']).toContain(m?.status);
        if (!g.deleted && g.openness !== 'SECRET') expect(seen).toBe(true);
      }),
    );
  });

  it('shows members only to active members, and lets only active leaders decide', () => {
    fc.assert(
      fc.property(group, own, (g, m) => {
        if (canSeeMembers(g, m)) {
          expect(canSeeGroup(g, m)).toBe(true);
          expect(m?.status).toBe('ACTIVE');
        }
        if (canDecideRequests(g, m)) {
          expect(canSeeMembers(g, m)).toBe(true);
          expect(['LEADER', 'CO_LEADER']).toContain(m?.role);
        }
      }),
    );
  });

  it('never offers to join a secret group, or one the member is already in or waiting for', () => {
    fc.assert(
      fc.property(group, own, (g, m) => {
        if (!canRequestToJoin(g, m)) return;
        expect(g.openness).not.toBe('SECRET');
        expect(canSeeGroup(g, m)).toBe(true);
        expect(['ACTIVE', 'REQUESTED', 'PAUSED']).not.toContain(m?.status);
      }),
    );
  });

  it('lets a member step out of anything they are connected to, and nothing else', () => {
    expect(canLeave(null)).toBe(false);
    expect(canLeave({ role: 'MEMBER', status: 'LEFT' })).toBe(false);
    for (const status of ['INTERESTED', 'REQUESTED', 'ACTIVE', 'PAUSED'] as const)
      expect(canLeave({ role: 'MEMBER', status })).toBe(true);
  });
});

describe('member lists', () => {
  const person = fc.record<ListedPerson>({
    personId: fc.uuid(),
    firstName: fc.string({ maxLength: 12 }),
    lastName: fc.string({ maxLength: 12 }),
    isMinor: fc.boolean(),
    status: fc.constantFrom(...MEMBERSHIP_STATUSES),
    role: fc.constantFrom(...GROUP_ROLES),
  });

  it('never lists a child or anyone who is not an active member, and lists leaders first', () => {
    fc.assert(
      fc.property(fc.array(person, { maxLength: 12 }), (people) => {
        const listed = visibleMembers(people);
        const byId = new Map(people.map((p) => [p.personId, p]));
        for (const l of listed) {
          const p = byId.get(l.personId);
          expect(p?.isMinor).toBe(false);
          expect(p?.status).toBe('ACTIVE');
        }
        const firstMember = listed.findIndex((l) => !l.leads);
        if (firstMember >= 0) expect(listed.slice(firstMember).every((l) => !l.leads)).toBe(true);
      }),
    );
  });

  it('shows a first name and a last initial, never a full surname', () => {
    expect(shortName('Ada', 'Lovelace')).toBe('Ada L.');
    expect(shortName(' ada ', ' lovelace')).toBe('ada L.');
    expect(shortName('Ada', '')).toBe('Ada');
    expect(shortName('', '')).toBe('A member');
    // At most one character of the surname ever shows (as an initial; upper-casing may widen it a little).
    fc.assert(
      fc.property(fc.string(), fc.string(), (f, l) => {
        const out = shortName(f, l);
        if (f.trim() === '' && l.trim() === '') expect(out).toBe('A member');
        else expect(out.length).toBeLessThanOrEqual(f.trim().length + 5);
        expect(out.startsWith(f.trim())).toBe(true);
      }),
    );
  });
});
