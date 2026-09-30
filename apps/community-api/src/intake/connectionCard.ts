// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import {
  classifyIntake,
  normalizeEmail,
  normalizePhone,
  toLocalDate,
  type IntakeDecision,
  type PersonIdentity,
} from '@thefold/core';
import { connectionCardSchema, type ConnectionCardInput, type Guest } from '@thefold/shared';
import type { PoolClient } from 'pg';
import { enqueueOutbox } from '../db/outbox.js';

export interface IntakeOutcome {
  /** QUEUED: a new card. DUPLICATE: the same person submitted the same visit already; nothing changed. */
  status: 'QUEUED' | 'DUPLICATE';
  match: IntakeDecision['decision'];
  idempotencyKey: string;
}

/** Same person + same day = same card, so a double-tapped Submit or a refresh cannot create a second guest. */
export function cardIdempotencyKey(
  guest: Pick<Guest, 'firstName' | 'lastName' | 'email' | 'phone'>,
  visitedOn: string,
): string {
  const parts = [
    normalizeEmail(guest.email) ?? '',
    normalizePhone(guest.phone) ?? '',
    guest.firstName.trim().toLowerCase(),
    guest.lastName.trim().toLowerCase(),
    visitedOn,
  ];
  return `card:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`;
}

/**
 * Handles a submitted connection card, inside `withTenant`.
 *
 * It does NOT talk to Twenty and does NOT choose a welcomer: it validates, checks whether we already know
 * this person, and queues one idempotent job. The worker creates the records in Twenty and, once Twenty
 * has assigned ids, assigns the welcomer (assignment.ts). Doing the slow, failure-prone work off the
 * request path means a guest is never told "something went wrong" after they filled in a card.
 *
 * The honeypot (`website`) and captcha token are validated here and then dropped: they are never stored.
 */
export async function submitConnectionCard(
  client: PoolClient,
  raw: ConnectionCardInput,
  now: Date,
): Promise<IntakeOutcome> {
  const { website: _honeypot, captchaToken: _captcha, ...guest } = connectionCardSchema.parse(raw);

  const { rows: tenantRows } = await client.query<{ timezone: string }>(
    'SELECT timezone FROM tenant',
  );
  const timezone = tenantRows[0]?.timezone ?? 'UTC';
  const visitedOn = guest.visitedOn ?? toLocalDate(now, timezone);

  const email = normalizeEmail(guest.email);
  const phone = normalizePhone(guest.phone);
  const { rows } = await client.query<{
    twenty_person_id: string;
    first_name: string;
    last_name: string;
    emails: string[];
    phones: string[];
    is_minor: boolean;
    shared_email: boolean;
    household_id: string | null;
    birthdate: string | null;
  }>(
    `SELECT twenty_person_id, first_name, last_name, emails, phones, is_minor, shared_email, household_id, NULL AS birthdate
       FROM person_read
      WHERE deleted_at IS NULL
        AND (emails && $1::text[] OR phones && $2::text[] OR lower(last_name) = lower($3))
      LIMIT 25`,
    [email ? [email] : [], phone ? [phone] : [], guest.lastName],
  );
  const people: PersonIdentity[] = rows.map((r) => ({
    id: r.twenty_person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    emails: r.emails,
    phones: r.phones,
    isMinor: r.is_minor,
    sharedEmail: r.shared_email,
    householdId: r.household_id,
    birthdate: r.birthdate,
  }));

  const match = classifyIntake(
    { firstName: guest.firstName, lastName: guest.lastName, email, phone },
    people,
  );
  const key = cardIdempotencyKey(guest, visitedOn);
  const { duplicate } = await enqueueOutbox(client, {
    kind: 'twenty.upsertGuest',
    idempotencyKey: key,
    guest: { ...guest, visitedOn },
    visitedAt: now.getTime(),
    existingPersonId: match.decision === 'EXISTING' ? match.personId : null,
    dedupe: {
      status: match.decision === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'CLEAR',
      candidateIds: match.decision === 'NEEDS_REVIEW' ? match.candidateIds : [],
    },
  });
  return { status: duplicate ? 'DUPLICATE' : 'QUEUED', match: match.decision, idempotencyKey: key };
}
