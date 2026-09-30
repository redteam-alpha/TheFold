// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  connectionCardSchema,
  localDateSchema,
  outboxJobSchema,
  prayerRequestCreateSchema,
  webhookHintSchema,
} from '../src/index.js';

const uuid = '3f0c1b9e-8a44-4b62-9d6e-1c2b3a4d5e6f';

describe('localDateSchema', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(localDateSchema.safeParse('2026-09-30').success).toBe(true);
    expect(localDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(localDateSchema.safeParse('30/09/2026').success).toBe(false);
  });
});

describe('connectionCardSchema', () => {
  const base = {
    firstName: ' Sam ',
    lastName: 'Rivera',
    email: 'sam@example.com',
    contactConsent: { byEmail: true },
  };

  it('accepts a minimal card and trims names', () => {
    const r = connectionCardSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.firstName).toBe('Sam');
      expect(r.data.interests).toEqual([]);
      expect(r.data.householdMembers).toEqual([]);
      expect(r.data.contactConsent).toEqual({ byEmail: true, byPhone: false, byText: false });
    }
  });

  it('needs a way to say hello: email or phone', () => {
    const { email: _email, ...noEmail } = base;
    expect(connectionCardSchema.safeParse(noEmail).success).toBe(false);
    expect(connectionCardSchema.safeParse({ ...noEmail, phone: '555-123-4567' }).success).toBe(
      true,
    );
    expect(connectionCardSchema.safeParse({ ...noEmail, phone: '   ' }).success).toBe(false);
  });

  it('rejects a filled honeypot (bots), bad emails, and oversized household lists', () => {
    expect(
      connectionCardSchema.safeParse({ ...base, website: 'http://spam.example' }).success,
    ).toBe(false);
    expect(connectionCardSchema.safeParse({ ...base, website: '' }).success).toBe(true);
    expect(connectionCardSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    const many = Array.from({ length: 13 }, () => ({ firstName: 'x' }));
    expect(connectionCardSchema.safeParse({ ...base, householdMembers: many }).success).toBe(false);
  });

  it('does not carry a prayer request (that has its own consented flow)', () => {
    const r = connectionCardSchema.safeParse({ ...base, prayerRequest: 'please pray' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty('prayerRequest');
  });
});

describe('prayerRequestCreateSchema', () => {
  const base = {
    body: 'Please pray for my mother’s surgery.',
    tier: 'CHURCH' as const,
    anonymousToCommunity: false,
    aboutSomeoneElse: true,
    followUpWanted: false,
    consentVersion: '2026-09',
  };

  it('accepts a church-wide request', () => {
    expect(prayerRequestCreateSchema.safeParse(base).success).toBe(true);
  });

  it('has no default tier: the person must choose who sees it', () => {
    const { tier: _tier, ...noTier } = base;
    expect(prayerRequestCreateSchema.safeParse(noTier).success).toBe(false);
  });

  it('has no public tier', () => {
    expect(prayerRequestCreateSchema.safeParse({ ...base, tier: 'PUBLIC' }).success).toBe(false);
  });

  it('requires a group exactly for the GROUP tier', () => {
    expect(prayerRequestCreateSchema.safeParse({ ...base, tier: 'GROUP' }).success).toBe(false);
    expect(
      prayerRequestCreateSchema.safeParse({ ...base, tier: 'GROUP', groupId: uuid }).success,
    ).toBe(true);
    expect(
      prayerRequestCreateSchema.safeParse({ ...base, tier: 'CHURCH', groupId: uuid }).success,
    ).toBe(false);
  });

  it('a care-only request always creates a care follow-up', () => {
    expect(
      prayerRequestCreateSchema.safeParse({ ...base, tier: 'CARE_ONLY', followUpWanted: false })
        .success,
    ).toBe(false);
    expect(
      prayerRequestCreateSchema.safeParse({ ...base, tier: 'CARE_ONLY', followUpWanted: true })
        .success,
    ).toBe(true);
  });

  it('needs explicit consent text version, and rejects empty or huge bodies', () => {
    expect(prayerRequestCreateSchema.safeParse({ ...base, consentVersion: '' }).success).toBe(
      false,
    );
    expect(prayerRequestCreateSchema.safeParse({ ...base, body: '   ' }).success).toBe(false);
    expect(prayerRequestCreateSchema.safeParse({ ...base, body: 'x'.repeat(4001) }).success).toBe(
      false,
    );
  });
});

describe('webhookHintSchema and outboxJobSchema', () => {
  it('parses a webhook hint', () => {
    expect(
      webhookHintSchema.safeParse({
        tenantId: uuid,
        objectType: 'person',
        recordId: uuid,
        action: 'updated',
        deliveryId: 'evt_1',
        receivedAt: 1,
      }).success,
    ).toBe(true);
  });

  it('parses the outbox job kinds and rejects unknown ones', () => {
    expect(
      outboxJobSchema.safeParse({
        kind: 'twenty.createFollowUp',
        idempotencyKey: 'welcome:abc',
        followUp: {
          kind: 'WELCOME',
          title: 'Welcome Sam',
          subjectPersonId: uuid,
          ownerPersonId: null,
          dueAt: 1,
        },
      }).success,
    ).toBe(true);
    expect(
      outboxJobSchema.safeParse({
        kind: 'twenty.recordAttendance',
        idempotencyKey: 'att:1',
        attendance: { personId: uuid, date: '2026-09-27', kind: 'SERVICE', source: 'CHECKIN' },
      }).success,
    ).toBe(true);
    expect(
      outboxJobSchema.safeParse({ kind: 'twenty.deleteEverything', idempotencyKey: 'x' }).success,
    ).toBe(false);
  });
});
