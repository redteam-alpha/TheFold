// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalDate } from '../dates.js';

export interface PersonIdentity {
  id: string;
  firstName: string;
  lastName: string;
  emails: readonly string[];
  phones: readonly string[];
  birthdate?: LocalDate | null;
  isMinor: boolean;
  /** Staff-set flag: several people legitimately use this email (families are common). */
  sharedEmail?: boolean;
  householdId?: string | null;
}

export interface IntakeCandidate {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  birthdate?: LocalDate | null;
}

export type MatchReason = 'EMAIL' | 'SHARED_EMAIL' | 'PHONE' | 'NAME' | 'BIRTHDATE';

export interface IdentityMatch {
  personId: string;
  score: number;
  reasons: MatchReason[];
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return null;
  const domain = e.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  return /\s/.test(e) ? null : e;
}

/** Best-effort E.164. Bare 10-digit numbers (and 11 starting with the country code) use `defaultCountryCode`. */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountryCode = '1',
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+'))
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return null;
}

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

function similarity(a: string, b: string): number {
  const [x, y] = [normalizeName(a), normalizeName(b)];
  if (x.length === 0 || y.length === 0) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** 0..1 average of first- and last-name similarity. */
export function nameSimilarity(
  a: { firstName: string; lastName: string },
  b: { firstName: string; lastName: string },
): number {
  return (similarity(a.firstName, b.firstName) + similarity(a.lastName, b.lastName)) / 2;
}

const W = { email: 0.5, sharedEmail: 0.15, phone: 0.3, name: 0.3, birthdate: 0.3 } as const;

export function scoreMatch(candidate: IntakeCandidate, person: PersonIdentity): IdentityMatch {
  const reasons: MatchReason[] = [];
  let score = 0;

  const email = normalizeEmail(candidate.email);
  if (email && person.emails.some((e) => normalizeEmail(e) === email)) {
    score += person.sharedEmail ? W.sharedEmail : W.email;
    reasons.push(person.sharedEmail ? 'SHARED_EMAIL' : 'EMAIL');
  }
  const phone = normalizePhone(candidate.phone);
  if (phone && person.phones.some((p) => normalizePhone(p) === phone)) {
    score += W.phone;
    reasons.push('PHONE');
  }
  const nameSim = nameSimilarity(candidate, person);
  if (nameSim >= 0.6) {
    score += W.name * nameSim;
    reasons.push('NAME');
  }
  if (candidate.birthdate && person.birthdate) {
    if (candidate.birthdate === person.birthdate) {
      score += W.birthdate;
      reasons.push('BIRTHDATE');
    } else {
      score -= W.birthdate; // two different birthdays is strong evidence of two different people
    }
  }
  return { personId: person.id, score: Math.max(0, Math.min(1, score)), reasons };
}

const REVIEW_THRESHOLD = 0.4;
const STRONG_THRESHOLD = 0.8;
const CONTENDER_THRESHOLD = 0.6;

export function findMatches(
  candidate: IntakeCandidate,
  people: readonly PersonIdentity[],
): IdentityMatch[] {
  return people
    .map((p) => scoreMatch(candidate, p))
    .filter((m) => m.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.personId.localeCompare(b.personId));
}

export type IntakeDecision =
  /** No plausible match: create a clean Person. */
  | { decision: 'NEW' }
  /** One clear match: attach the attendance to this Person; do not overwrite their details. */
  | { decision: 'EXISTING'; personId: string }
  /**
   * Plausible but unclear: create the Person anyway (so the follow-up is never lost) with
   * dedupeStatus=NEEDS_REVIEW and let staff merge. We never auto-merge.
   */
  | { decision: 'NEEDS_REVIEW'; candidateIds: string[] };

export function classifyIntake(
  candidate: IntakeCandidate,
  people: readonly PersonIdentity[],
): IntakeDecision {
  const matches = findMatches(candidate, people);
  const top = matches[0];
  if (!top) return { decision: 'NEW' };

  const byId = new Map(people.map((p) => [p.id, p]));
  const topPerson = byId.get(top.personId);
  const contenders = matches.filter((m) => m.score >= CONTENDER_THRESHOLD);
  if (top.score >= STRONG_THRESHOLD && contenders.length === 1 && topPerson && !topPerson.isMinor) {
    return { decision: 'EXISTING', personId: top.personId };
  }
  return { decision: 'NEEDS_REVIEW', candidateIds: matches.map((m) => m.personId) };
}

export type PortalLinkDecision =
  /** Exactly one adult owns this verified email and it is not shared: link the portal account. */
  | { decision: 'AUTO_LINK'; personId: string }
  /** Ambiguous or shared: show a household picker and require staff confirmation (PENDING_REVIEW). */
  | { decision: 'NEEDS_STAFF_CONFIRMATION'; candidateIds: string[] }
  /** Nobody has this email: route through the connection card. */
  | { decision: 'NO_MATCH' };

/**
 * Links a portal login (proved by magic link to `verifiedEmail`) to a Person.
 * Only adults can be linked automatically; a child who uses a parent's email never becomes a
 * portal account, and shared family emails always go to a human.
 */
export function decidePortalLink(
  verifiedEmail: string,
  people: readonly PersonIdentity[],
): PortalLinkDecision {
  const email = normalizeEmail(verifiedEmail);
  if (!email) return { decision: 'NO_MATCH' };
  const owners = people.filter((p) => p.emails.some((e) => normalizeEmail(e) === email));
  const adults = owners.filter((p) => !p.isMinor);
  const only = adults[0];
  if (adults.length === 1 && only && !only.sharedEmail) {
    return { decision: 'AUTO_LINK', personId: only.id };
  }
  if (owners.length === 0) return { decision: 'NO_MATCH' };
  return { decision: 'NEEDS_STAFF_CONFIRMATION', candidateIds: owners.map((p) => p.id).sort() };
}

/**
 * Whether a sign-in link may be emailed to `email` at all: only when an adult in the church's records uses
 * that address. A child's own address never gets one (children have no portal account; parents manage them),
 * and an address nobody in the records uses gets nothing, so the sign-in form cannot be used to send mail to
 * strangers. The sign-in form answers the same either way, so this never tells anyone who belongs.
 */
export function mayReceiveSignInLink(email: string, people: readonly PersonIdentity[]): boolean {
  const e = normalizeEmail(email);
  return (
    e !== null && people.some((p) => !p.isMinor && p.emails.some((x) => normalizeEmail(x) === e))
  );
}
