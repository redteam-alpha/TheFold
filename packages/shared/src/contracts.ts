// SPDX-License-Identifier: AGPL-3.0-or-later
import { FOLLOW_UP_KINDS, PRAYER_TIERS, toEpochDay } from '@thefold/core';
import { z } from 'zod';

/** A calendar day, `YYYY-MM-DD`, validated as a real date. */
export const localDateSchema = z.string().refine(
  (s) => {
    try {
      toEpochDay(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected a real calendar date in YYYY-MM-DD form' },
);

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/**
 * The public connection card ("I'm new here"). Deliberately small: name, one way to reach the
 * person, what they're interested in, and what they consent to. A prayer request is NOT part of
 * this payload — it has its own consented flow (`prayerRequestCreateSchema`).
 */
export const connectionCardSchema = z
  .object({
    firstName: trimmed(80),
    lastName: trimmed(80),
    email: z.email().max(254).optional(),
    phone: optionalTrimmed(40),
    /** People the guest came with; they get their own Person, linked into one household. */
    householdMembers: z
      .array(
        z.object({
          firstName: trimmed(80),
          lastName: optionalTrimmed(80),
          isChild: z.boolean().default(false),
        }),
      )
      .max(12)
      .default([]),
    interests: z.array(trimmed(60)).max(20).default([]),
    howHeard: optionalTrimmed(200),
    visitedOn: localDateSchema.optional(),
    campusId: z.uuid().optional(),
    /** Consent to be contacted by the church. Without any contact method + consent there is no follow-up. */
    contactConsent: z.object({
      byEmail: z.boolean().default(false),
      byPhone: z.boolean().default(false),
      byText: z.boolean().default(false),
    }),
    /** Anti-abuse: must be empty. Filled by bots. */
    website: z.string().max(0).optional(),
    captchaToken: z.string().max(4096).optional(),
  })
  .refine((c) => c.email !== undefined || (c.phone !== undefined && c.phone !== ''), {
    message: 'Please share an email or a phone number so someone can say hello',
    path: ['email'],
  });
export type ConnectionCardInput = z.input<typeof connectionCardSchema>;
export type ConnectionCard = z.output<typeof connectionCardSchema>;

/**
 * Creating a prayer request. `tier` has no default on purpose: the person must choose who sees it.
 */
export const prayerRequestCreateSchema = z
  .object({
    body: trimmed(4000),
    tier: z.enum(PRAYER_TIERS),
    groupId: z.uuid().optional(),
    anonymousToCommunity: z.boolean(),
    aboutSomeoneElse: z.boolean(),
    followUpWanted: z.boolean(),
    /** The version of the consent text the person saw and accepted. */
    consentVersion: trimmed(40),
  })
  .refine((r) => (r.tier === 'GROUP') === (r.groupId !== undefined), {
    message: 'A group is required for the GROUP tier, and only for the GROUP tier',
    path: ['groupId'],
  })
  .refine((r) => r.tier !== 'CARE_ONLY' || r.followUpWanted, {
    message: 'A care-only request always creates a care follow-up',
    path: ['followUpWanted'],
  });
export type PrayerRequestCreateInput = z.input<typeof prayerRequestCreateSchema>;
export type PrayerRequestCreate = z.output<typeof prayerRequestCreateSchema>;

/** What the webhook adapter distils from a Twenty webhook: "this record may have changed". */
export const webhookHintSchema = z.object({
  tenantId: z.uuid(),
  objectType: z.string().min(1).max(80),
  recordId: z.uuid(),
  action: z.enum(['created', 'updated', 'deleted']),
  /** Twenty's own delivery/event id if it provides one, otherwise a hash of the payload. */
  deliveryId: z.string().min(1).max(200),
  receivedAt: z.number().int().nonnegative(),
});
export type WebhookHint = z.infer<typeof webhookHintSchema>;

/**
 * Jobs the outbox sends to Twenty. `idempotencyKey` is written to the Twenty record's `sourceRef`
 * so a retry after a timeout finds the record instead of creating a second one.
 */
export const outboxJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('twenty.createFollowUp'),
    idempotencyKey: z.string().min(1).max(200),
    followUp: z.object({
      kind: z.enum(FOLLOW_UP_KINDS),
      title: trimmed(200),
      subjectPersonId: z.uuid(),
      ownerPersonId: z.uuid().nullable(),
      dueAt: z.number().int().nonnegative(),
      contextSummary: optionalTrimmed(500),
    }),
  }),
  z.object({
    kind: z.literal('twenty.upsertGuest'),
    idempotencyKey: z.string().min(1).max(200),
    guest: connectionCardSchema,
  }),
  z.object({
    kind: z.literal('twenty.createCareRequest'),
    idempotencyKey: z.string().min(1).max(200),
    careRequest: z.object({
      personId: z.uuid(),
      ownerPersonId: z.uuid().nullable(),
      priority: z.enum(['NORMAL', 'HIGH', 'URGENT']),
      /** Coarse *kind of care*, never the person's circumstances. */
      category: z.enum(['VISIT', 'MEAL', 'PRAYER', 'PRACTICAL_HELP', 'CHECK_IN', 'OTHER']),
      /** Opaque pointer to the confidential record in community-api. Not the text. */
      communityRef: z.uuid(),
    }),
  }),
  z.object({
    kind: z.literal('twenty.recordAttendance'),
    idempotencyKey: z.string().min(1).max(200),
    attendance: z.object({
      personId: z.uuid(),
      date: localDateSchema,
      kind: z.enum(['SERVICE', 'GROUP', 'EVENT', 'SERVING']),
      source: z.enum(['CHECKIN', 'LEADER', 'STAFF', 'IMPORT']),
      ref: optionalTrimmed(200),
    }),
  }),
]);
/** What callers pass in (defaults and transforms not yet applied). */
export type OutboxJobInput = z.input<typeof outboxJobSchema>;
/** What comes out of the queue after validation. */
export type OutboxJob = z.output<typeof outboxJobSchema>;
