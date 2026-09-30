// SPDX-License-Identifier: AGPL-3.0-or-later
import { TokenBucket, TwentyClient } from '@thefold/twenty-client';
import { FakeTwenty } from '@thefold/twenty-client/testing';
import { guestSchema } from '@thefold/shared';
import { describe, expect, it } from 'vitest';
import { RestTwentyGateway, type GuestUpsertInput } from '../src/twenty/gateway.js';

function setup() {
  const server = new FakeTwenty();
  const bucket = new TokenBucket({
    capacity: 10_000,
    refillPerSecond: 10_000,
    backgroundReserve: 0,
    now: Date.now,
  });
  const client = new TwentyClient({
    baseUrl: 'https://twenty.test',
    apiKey: 'k',
    fetch: server.fetch,
    bucket,
    retry: { sleep: () => Promise.resolve(), random: () => 0 },
  });
  return { server, gateway: new RestTwentyGateway(client) };
}

const input = (
  over: Partial<GuestUpsertInput['guest']> = {},
  more: Partial<GuestUpsertInput> = {},
): GuestUpsertInput => ({
  sourceRef: 'card:abc',
  guest: guestSchema.parse({
    firstName: 'Ana',
    lastName: 'Lopez',
    email: 'ana@example.com',
    phone: '+15551234567',
    interests: ['music'],
    householdMembers: [
      { firstName: 'Diego', isChild: false },
      { firstName: 'Lucia', isChild: true },
    ],
    contactConsent: { byEmail: true, byPhone: true, byText: false },
    ...over,
  }),
  visitedOn: '2026-09-27',
  visitedAt: Date.parse('2026-09-27T15:00:00Z'),
  existingPersonId: null,
  dedupeStatus: 'CLEAR',
  ...more,
});

describe('RestTwentyGateway (against the fake Twenty; shapes are UNVERIFIED until M0)', () => {
  it('creates a household, the guest and the family, linking them with the relation ids the model defines', async () => {
    const { server, gateway } = setup();
    const r = await gateway.upsertGuest(input());
    expect(r.personIds).toHaveLength(3);
    expect(r.householdId).not.toBeNull();

    const [ana, diego, lucia] = server.rows('people');
    expect(ana).toMatchObject({
      name: { firstName: 'Ana', lastName: 'Lopez' },
      emails: { primaryEmail: 'ana@example.com' },
      phones: { primaryPhoneNumber: '+15551234567' },
      lifecycleStage: 'NEW_GUEST',
      firstVisitDate: '2026-09-27',
      dedupeStatus: 'CLEAR',
      consentEmail: true,
      consentPhone: true,
      consentSms: false,
      isHouseholdPrimaryContact: true,
      householdId: r.householdId,
    });
    expect(diego).toMatchObject({
      isMinor: false,
      doNotContact: false,
      householdId: r.householdId,
    });
    // A child is a minor, parent-managed, never contacted directly, linked to their guardian.
    expect(lucia).toMatchObject({
      isMinor: true,
      doNotContact: true,
      guardianId: r.primaryPersonId,
      householdId: r.householdId,
    });
    expect(lucia).not.toHaveProperty('emails');
    expect(lucia).not.toHaveProperty('consentEmail');
  });

  it('is idempotent: the same card creates nothing new', async () => {
    const { server, gateway } = setup();
    const a = await gateway.upsertGuest(input());
    const b = await gateway.upsertGuest(input());
    expect(b).toEqual(a);
    expect(server.rows('people')).toHaveLength(3);
    expect(server.rows('households')).toHaveLength(1);
  });

  it('a known person is attached without a single request, so nothing about them is overwritten', async () => {
    const { server, gateway } = setup();
    const known = '00000000-0000-4000-8000-0000000000c1';
    const r = await gateway.upsertGuest(input({}, { existingPersonId: known }));
    expect(r).toEqual({ primaryPersonId: known, personIds: [known], householdId: null });
    expect(server.calls).toHaveLength(0);
  });

  it('a solo guest gets no household; an unsure match is flagged for staff to merge', async () => {
    const { server, gateway } = setup();
    const r = await gateway.upsertGuest(
      input({ householdMembers: [] }, { dedupeStatus: 'NEEDS_REVIEW' }),
    );
    expect(r.householdId).toBeNull();
    expect(server.rows('households')).toHaveLength(0);
    expect(server.rows('people')[0]).toMatchObject({
      dedupeStatus: 'NEEDS_REVIEW',
      isHouseholdPrimaryContact: false,
    });
  });

  it('writes follow-ups with an owner and subject as relations, and never with free text from the person', async () => {
    const { server, gateway } = setup();
    const subject = '00000000-0000-4000-8000-0000000000d1';
    const owner = '00000000-0000-4000-8000-0000000000d2';
    const a = await gateway.createFollowUp('welcome:x:WELCOME', {
      kind: 'WELCOME',
      title: 'Welcome Ana Lopez',
      subjectPersonId: subject,
      ownerPersonId: owner,
      dueAt: Date.parse('2026-09-29T15:00:00Z'),
      contextSummary: 'First-time guest',
    });
    const b = await gateway.createFollowUp('welcome:x:WELCOME', {
      kind: 'WELCOME',
      title: 'Welcome Ana Lopez',
      subjectPersonId: subject,
      ownerPersonId: owner,
      dueAt: 0,
    });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, id: a.id });
    expect(server.rows('followUps')).toHaveLength(1);
    expect(server.rows('followUps')[0]).toMatchObject({
      name: 'Welcome Ana Lopez',
      kind: 'WELCOME',
      status: 'OPEN',
      dueAt: '2026-09-29T15:00:00.000Z',
      subjectId: subject,
      ownerId: owner,
      sourceRef: 'welcome:x:WELCOME',
    });
  });

  it('an unowned follow-up simply omits the owner', async () => {
    const { server, gateway } = setup();
    await gateway.createFollowUp('welcome:y:WELCOME', {
      kind: 'WELCOME',
      title: 't',
      subjectPersonId: '00000000-0000-4000-8000-0000000000d1',
      ownerPersonId: null,
      dueAt: 1,
    });
    expect(server.rows('followUps')[0]).not.toHaveProperty('ownerId');
  });

  it('a care request in Twenty carries only an opaque reference: no words from the person', async () => {
    const { server, gateway } = setup();
    const ref = '11111111-2222-4333-8444-555555555555';
    await gateway.createCareRequest(
      'care:prayer:1',
      {
        personId: '00000000-0000-4000-8000-0000000000d1',
        ownerPersonId: null,
        priority: 'NORMAL',
        category: 'PRAYER',
        communityRef: ref,
      },
      Date.parse('2026-09-27T15:00:00Z'),
    );
    const row = server.rows('careRequests')[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      name: 'Care 11111111',
      category: 'PRAYER',
      communityRef: ref,
      status: 'OPEN',
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        'category',
        'communityRef',
        'createdAt',
        'id',
        'name',
        'openedAt',
        'personId',
        'priority',
        'sourceRef',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('records attendance idempotently', async () => {
    const { server, gateway } = setup();
    const att = {
      personId: '00000000-0000-4000-8000-0000000000d1',
      date: '2026-09-27',
      kind: 'SERVICE' as const,
      source: 'CHECKIN' as const,
    };
    await gateway.recordAttendance('att:1', att);
    await gateway.recordAttendance('att:1', att);
    expect(server.rows('attendances')).toHaveLength(1);
    expect(server.rows('attendances')[0]).toMatchObject({
      name: 'SERVICE 2026-09-27',
      date: '2026-09-27',
      personId: att.personId,
    });
  });
});
