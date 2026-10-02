// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canViewPrayer,
  classifyIntake,
  decidePortalLink,
  findMatches,
  levenshtein,
  mayReceiveSignInLink,
  nameSimilarity,
  normalizeEmail,
  normalizePhone,
  type PersonIdentity,
  type PrayerRequestAccessMeta,
  type PrayerViewer,
} from '../src/index.js';

const p = (over: Partial<PersonIdentity> & { id: string }): PersonIdentity => ({
  firstName: 'Sam',
  lastName: 'Rivera',
  emails: [],
  phones: [],
  isMinor: false,
  ...over,
});

describe('normalisation', () => {
  it('normalises emails', () => {
    expect(normalizeEmail('  Sam.Rivera@Example.COM ')).toBe('sam.rivera@example.com');
    for (const bad of [
      '',
      null,
      undefined,
      'nope',
      'a@b',
      'a@@b.com',
      '@x.com',
      'a b@x.com',
      'a@.com',
    ]) {
      expect(normalizeEmail(bad as string | null)).toBeNull();
    }
  });
  it('normalises phones to E.164', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('1-555-123-4567')).toBe('+15551234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('555-1234')).toBeNull();
    expect(normalizePhone('', '1')).toBeNull();
  });
  it('measures name similarity ignoring case, accents and punctuation', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(
      nameSimilarity(
        { firstName: 'José', lastName: "O'Brien" },
        { firstName: 'jose', lastName: 'obrien' },
      ),
    ).toBe(1);
    expect(
      nameSimilarity(
        { firstName: 'Sam', lastName: 'Rivera' },
        { firstName: 'Priya', lastName: 'Shah' },
      ),
    ).toBeLessThan(0.4);
  });
});

describe('classifyIntake (connection card)', () => {
  const sam = p({ id: 'sam', emails: ['sam@example.com'], phones: ['+15551234567'] });

  it('creates a clean Person when nothing plausible matches', () => {
    expect(
      classifyIntake({ firstName: 'Priya', lastName: 'Shah', email: 'priya@example.com' }, [sam]),
    ).toEqual({
      decision: 'NEW',
    });
    expect(classifyIntake({ firstName: 'Sam', lastName: 'Rivera' }, [])).toEqual({
      decision: 'NEW',
    });
  });

  it('attaches to the existing Person on a clear email + name match', () => {
    expect(
      classifyIntake({ firstName: 'Sam', lastName: 'Rivera', email: 'SAM@example.com' }, [sam]),
    ).toEqual({
      decision: 'EXISTING',
      personId: 'sam',
    });
  });

  it('never auto-merges on a shared family email: the same name needs a human, a different family member is simply new', () => {
    const ana = p({
      id: 'ana',
      firstName: 'Ana',
      lastName: 'Rivera',
      emails: ['family@example.com'],
      sharedEmail: true,
    });
    // Ana fills in a card again with the family address: probably her, but the email alone proves nothing.
    expect(
      classifyIntake({ firstName: 'Ana', lastName: 'Rivera', email: 'family@example.com' }, [ana]),
    ).toEqual({
      decision: 'NEEDS_REVIEW',
      candidateIds: ['ana'],
    });
    // Sam uses the same family address: a different person in the same household.
    expect(
      classifyIntake({ firstName: 'Sam', lastName: 'Rivera', email: 'family@example.com' }, [ana]),
    ).toEqual({
      decision: 'NEW',
    });
  });

  it('asks for review when a similar name arrives with a different email', () => {
    const r = classifyIntake({ firstName: 'Samuel', lastName: 'Rivera', phone: '555-123-4567' }, [
      sam,
    ]);
    expect(r.decision).toBe('NEEDS_REVIEW');
  });

  it('two different birthdays are strong evidence of two different people', () => {
    const a = p({ id: 'a', emails: ['x@example.com'], birthdate: '1980-01-01' });
    const r = classifyIntake(
      { firstName: 'Sam', lastName: 'Rivera', email: 'x@example.com', birthdate: '1990-05-05' },
      [a],
    );
    expect(r.decision).not.toBe('EXISTING');
  });

  it('never attaches an adult’s card to a minor’s record', () => {
    const kid = p({ id: 'kid', emails: ['sam@example.com'], isMinor: true });
    expect(
      classifyIntake({ firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com' }, [kid])
        .decision,
    ).toBe('NEEDS_REVIEW');
  });

  it('two equally strong candidates are ambiguous', () => {
    const twin = p({ id: 'twin', emails: ['sam@example.com'] });
    const r = classifyIntake({ firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com' }, [
      sam,
      twin,
    ]);
    expect(r).toMatchObject({ decision: 'NEEDS_REVIEW' });
  });

  it('orders matches by score then id, deterministically', () => {
    const ms = findMatches({ firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com' }, [
      p({ id: 'b', emails: ['sam@example.com'] }),
      p({ id: 'a', emails: ['sam@example.com'] }),
    ]);
    expect(ms.map((m) => m.personId)).toEqual(['a', 'b']);
  });
});

describe('decidePortalLink', () => {
  it('auto-links when exactly one adult owns the verified email', () => {
    expect(
      decidePortalLink(' Sam@Example.com', [p({ id: 'sam', emails: ['sam@example.com'] })]),
    ).toEqual({
      decision: 'AUTO_LINK',
      personId: 'sam',
    });
  });
  it('still auto-links the parent when their child’s record carries the same email', () => {
    const r = decidePortalLink('mom@example.com', [
      p({ id: 'mom', emails: ['mom@example.com'] }),
      p({ id: 'kid', emails: ['mom@example.com'], isMinor: true }),
    ]);
    expect(r).toEqual({ decision: 'AUTO_LINK', personId: 'mom' });
  });
  it('never auto-links a shared family email; a human confirms', () => {
    const r = decidePortalLink('family@example.com', [
      p({ id: 'mom', emails: ['family@example.com'], sharedEmail: true }),
    ]);
    expect(r).toEqual({ decision: 'NEEDS_STAFF_CONFIRMATION', candidateIds: ['mom'] });
  });
  it('never auto-links when two adults have the same email', () => {
    const r = decidePortalLink('x@example.com', [
      p({ id: 'b', emails: ['x@example.com'] }),
      p({ id: 'a', emails: ['x@example.com'] }),
    ]);
    expect(r).toEqual({ decision: 'NEEDS_STAFF_CONFIRMATION', candidateIds: ['a', 'b'] });
  });
  it('never links a portal account to a minor', () => {
    const r = decidePortalLink('kid@example.com', [
      p({ id: 'kid', emails: ['kid@example.com'], isMinor: true }),
    ]);
    expect(r).toEqual({ decision: 'NEEDS_STAFF_CONFIRMATION', candidateIds: ['kid'] });
  });
  it('reports no match for an unknown or malformed email', () => {
    expect(
      decidePortalLink('who@example.com', [p({ id: 's', emails: ['sam@example.com'] })]),
    ).toEqual({ decision: 'NO_MATCH' });
    expect(decidePortalLink('garbage', [])).toEqual({ decision: 'NO_MATCH' });
  });
});

describe('portal sign-in properties (who an emailed link may reach, and who it links to)', () => {
  const EMAILS = ['a@example.com', 'b@example.com', 'family@example.com'];
  const person = fc.record({
    id: fc.uuid(),
    emails: fc.subarray(EMAILS),
    isMinor: fc.boolean(),
    sharedEmail: fc.boolean(),
  });
  const people = fc
    .uniqueArray(person, { selector: (x) => x.id, maxLength: 6 })
    .map((xs) => xs.map((x) => p(x)));
  const email = fc.constantFrom(...EMAILS, 'nobody@example.com', 'not an email');

  it('never links an account to a minor, a shared address, or one of several owners', () => {
    fc.assert(
      fc.property(email, people, (e, ps) => {
        const d = decidePortalLink(e, ps);
        if (d.decision !== 'AUTO_LINK') return;
        const owners = ps.filter((x) => x.emails.includes(e));
        const linked = ps.find((x) => x.id === d.personId);
        expect(linked?.isMinor).toBe(false);
        expect(linked?.sharedEmail).toBe(false);
        expect(owners.filter((x) => !x.isMinor)).toHaveLength(1);
      }),
    );
  });

  it('decides the same way whatever order the records come in', () => {
    fc.assert(
      fc.property(email, people, fc.integer(), (e, ps, seed) => {
        const shuffled = [...ps].sort(
          (x, y) => ((x.id.charCodeAt(0) * seed) % 7) - ((y.id.charCodeAt(0) * seed) % 7),
        );
        expect(decidePortalLink(e, shuffled)).toEqual(decidePortalLink(e, ps));
        expect(mayReceiveSignInLink(e, shuffled)).toBe(mayReceiveSignInLink(e, ps));
      }),
    );
  });

  it('emails a link only when an adult in the records uses the address', () => {
    fc.assert(
      fc.property(email, people, (e, ps) => {
        const adultOwner = ps.some((x) => !x.isMinor && x.emails.includes(e));
        expect(mayReceiveSignInLink(e, ps)).toBe(adultOwner);
        // Whenever a link is emailed, the account it creates links to someone or goes to a human.
        if (adultOwner) expect(decidePortalLink(e, ps).decision).not.toBe('NO_MATCH');
      }),
    );
  });

  it('never emails a child’s own address, even in upper case', () => {
    expect(
      mayReceiveSignInLink('Kid@Example.com', [
        p({ id: 'kid', emails: ['kid@example.com'], isMinor: true }),
      ]),
    ).toBe(false);
    expect(
      mayReceiveSignInLink(' Mom@Example.com ', [p({ id: 'mom', emails: ['mom@example.com'] })]),
    ).toBe(true);
  });
});

describe('canViewPrayer', () => {
  const viewer = (over: Partial<PrayerViewer> = {}): PrayerViewer => ({
    personId: 'v',
    roles: [],
    isVerifiedMember: true,
    activeGroupIds: [],
    ...over,
  });
  const req = (over: Partial<PrayerRequestAccessMeta> = {}): PrayerRequestAccessMeta => ({
    authorPersonId: 'author',
    tier: 'CHURCH',
    status: 'ACTIVE',
    anonymousToCommunity: false,
    ...over,
  });

  it('the author always sees their own request, even a removed one', () => {
    for (const tier of ['CARE_ONLY', 'GROUP', 'CHURCH'] as const) {
      expect(canViewPrayer(viewer({ personId: 'author' }), req({ tier }))).toMatchObject({
        allow: true,
        via: 'AUTHOR',
        audit: false,
      });
    }
    expect(canViewPrayer(viewer({ personId: 'author' }), req({ status: 'REMOVED' })).allow).toBe(
      true,
    );
  });

  it('a removed request is hidden from everyone else, even pastors', () => {
    expect(
      canViewPrayer(viewer({ roles: ['pastor'] }), req({ status: 'REMOVED' }), {
        breakGlassReason: 'a good enough reason',
      }),
    ).toEqual({
      allow: false,
      reason: 'REMOVED',
    });
  });

  describe('CARE_ONLY', () => {
    const r = req({ tier: 'CARE_ONLY', assignedCareOwnerId: 'nurse' });
    it('is invisible to the congregation', () => {
      expect(canViewPrayer(viewer(), r)).toEqual({ allow: false, reason: 'NOT_AUTHORIZED' });
      expect(
        canViewPrayer(viewer({ roles: ['group_leader', 'moderator', 'admin'] }), r).allow,
      ).toBe(false);
    });
    it('is visible to the assigned care-team member, with an audit entry', () => {
      expect(canViewPrayer(viewer({ personId: 'nurse', roles: ['care_team'] }), r)).toEqual({
        allow: true,
        via: 'ASSIGNED_CARE',
        audit: true,
        showAuthor: true,
      });
    });
    it('is NOT visible to unassigned care-team members', () => {
      expect(canViewPrayer(viewer({ personId: 'other', roles: ['care_team'] }), r).allow).toBe(
        false,
      );
    });
    it('a pastor needs assignment or a written break-glass reason', () => {
      const pastor = viewer({ personId: 'pastor', roles: ['pastor'] });
      expect(canViewPrayer(pastor, r).allow).toBe(false);
      expect(canViewPrayer(pastor, r, { breakGlassReason: 'too short' }).allow).toBe(false);
      expect(canViewPrayer(pastor, r, { breakGlassReason: '   ' }).allow).toBe(false);
      expect(
        canViewPrayer(pastor, r, { breakGlassReason: 'Family emergency; contacting spouse' }),
      ).toMatchObject({
        allow: true,
        via: 'PASTOR_BREAK_GLASS',
        audit: true,
      });
      expect(canViewPrayer(pastor, { ...r, assignedCareOwnerId: 'pastor' })).toMatchObject({
        via: 'PASTOR_ASSIGNED',
        audit: true,
      });
    });
    it('the admin role alone grants nothing', () => {
      expect(
        canViewPrayer(viewer({ roles: ['admin'] }), r, {
          breakGlassReason: 'I am the admin, let me in',
        }).allow,
      ).toBe(false);
    });
  });

  describe('GROUP', () => {
    const r = req({ tier: 'GROUP', groupId: 'g1', anonymousToCommunity: true });
    it('is visible to active members of that group only', () => {
      expect(canViewPrayer(viewer({ activeGroupIds: ['g1'] }), r)).toMatchObject({
        allow: true,
        via: 'GROUP_MEMBER',
        audit: false,
      });
      expect(canViewPrayer(viewer({ activeGroupIds: ['g2'] }), r)).toEqual({
        allow: false,
        reason: 'NOT_IN_GROUP',
      });
      expect(canViewPrayer(viewer({ activeGroupIds: ['g1'], isVerifiedMember: false }), r)).toEqual(
        { allow: false, reason: 'NOT_A_MEMBER' },
      );
    });
    it('a GROUP request with no group is visible to no one on the community path', () => {
      expect(
        canViewPrayer(viewer({ activeGroupIds: ['g1'] }), req({ tier: 'GROUP', groupId: null }))
          .allow,
      ).toBe(false);
    });
    it('hides an anonymous author from the group', () => {
      expect(canViewPrayer(viewer({ activeGroupIds: ['g1'] }), r)).toMatchObject({
        showAuthor: false,
      });
    });
  });

  describe('CHURCH', () => {
    it('is visible to verified members only', () => {
      expect(canViewPrayer(viewer(), req())).toMatchObject({
        allow: true,
        via: 'MEMBER',
        showAuthor: true,
      });
      expect(canViewPrayer(viewer({ isVerifiedMember: false }), req())).toEqual({
        allow: false,
        reason: 'NOT_A_MEMBER',
      });
    });
    it('respects anonymity for the community but not for the care team', () => {
      const anon = req({ anonymousToCommunity: true, assignedCareOwnerId: 'nurse' });
      expect(canViewPrayer(viewer(), anon)).toMatchObject({ showAuthor: false });
      expect(
        canViewPrayer(viewer({ personId: 'nurse', roles: ['care_team'] }), anon),
      ).toMatchObject({ showAuthor: true });
    });
  });

  it('expired and archived requests leave the community path but stay with the care path', () => {
    for (const status of ['EXPIRED', 'ARCHIVED'] as const) {
      expect(canViewPrayer(viewer(), req({ status }))).toEqual({
        allow: false,
        reason: 'NOT_ACTIVE',
      });
      expect(
        canViewPrayer(
          viewer({ personId: 'nurse', roles: ['care_team'] }),
          req({ status, assignedCareOwnerId: 'nurse' }),
        ).allow,
      ).toBe(true);
    }
    expect(canViewPrayer(viewer(), req({ status: 'ANSWERED' })).allow).toBe(true);
  });
});
