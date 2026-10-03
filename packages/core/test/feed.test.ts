// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GROUP_OPENNESS,
  GROUP_ROLES,
  MEMBERSHIP_STATUSES,
  REACTION_KINDS,
  canModerate,
  canPost,
  canReadFeed,
  reactionSummary,
  visibleText,
  type GroupFacts,
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
const people = ['p1', 'p2', 'p3', 'p4'];

describe('group feed (ADR 0009)', () => {
  it('lets only active members of a live group read and post, and only active leaders moderate', () => {
    fc.assert(
      fc.property(group, own, (g, m) => {
        if (canReadFeed(g, m) || canPost(g, m)) {
          expect(g.deleted).toBe(false);
          expect(m?.status).toBe('ACTIVE');
        }
        expect(canPost(g, m)).toBe(canReadFeed(g, m));
        if (canModerate(g, m)) {
          expect(canReadFeed(g, m)).toBe(true);
          expect(['LEADER', 'CO_LEADER']).toContain(m?.role);
        }
      }),
    );
  });

  it('gives counts to the author alone, never to anyone else, and counts each person once', () => {
    const reaction = fc.record({
      personId: fc.constantFrom(...people),
      kind: fc.constantFrom(...REACTION_KINDS),
    });
    fc.assert(
      fc.property(
        fc.constantFrom(...people),
        fc.constantFrom(...people),
        fc.array(reaction, { maxLength: 10 }),
        (viewer, author, reactions) => {
          const s = reactionSummary(viewer, author, reactions);
          expect(s.mine).toBe(reactions.find((r) => r.personId === viewer)?.kind ?? null);
          if (viewer !== author) {
            expect(s.counts).toBeNull();
            return;
          }
          const others = new Set(reactions.map((r) => r.personId).filter((p) => p !== author));
          const total = Object.values(s.counts ?? {}).reduce((a, b) => a + b, 0);
          expect(total).toBe(others.size);
        },
      ),
    );
  });

  it('shows removed words to their author alone, and pending ones to nobody else', () => {
    const status = fc.constantFrom(
      'PUBLISHED' as const,
      'REMOVED' as const,
      'PENDING_APPROVAL' as const,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...people),
        fc.constantFrom(...people),
        status,
        (viewer, author, st) => {
          const v = visibleText(viewer, { authorPersonId: author, status: st, body: 'words' });
          if (st === 'PUBLISHED')
            expect(v).toEqual({ text: 'words', removed: false, pending: false });
          if (st === 'REMOVED') {
            expect(v?.removed).toBe(true);
            expect(v?.text).toBe(viewer === author ? 'words' : null);
          }
          if (st === 'PENDING_APPROVAL') expect(v === null).toBe(viewer !== author);
        },
      ),
    );
  });
});
