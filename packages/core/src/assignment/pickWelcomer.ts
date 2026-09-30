// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalDate } from '../dates.js';

export interface WelcomerCandidate {
  id: string;
  /** Relative capacity; a weight-2 welcomer takes about twice as many guests as a weight-1. */
  weight?: number;
  openCount: number;
  assignedLast30d: number;
  maxOpen: number;
  /** Epoch ms of the last assignment, or null if never assigned. */
  lastAssignedAt: number | null;
  /** Campuses this welcomer serves; empty means any campus. */
  campusIds?: readonly string[];
  awayUntil?: LocalDate | null;
}

export interface GuestToWelcome {
  id: string;
  campusId?: string | null;
  /** The guest's own household members; a welcomer never welcomes their own family. */
  householdMemberIds?: readonly string[];
}

export type WelcomerPick =
  | { kind: 'ASSIGNED'; welcomerId: string }
  /** Nobody is eligible: assign to the campus pastor pool and alert an admin. Never leave it ownerless. */
  | { kind: 'POOL'; reason: 'NO_ELIGIBLE_WELCOMER' };

/** How much an assignment in the last 30 days counts against a welcomer, relative to an open item. */
const RECENT_ASSIGNMENT_WEIGHT = 0.5;

/**
 * Fair, deterministic welcomer selection.
 * Load = (open + 0.5 × assigned in last 30 days) / weight; lowest load wins, then whoever was
 * assigned least recently, then a stable hash so ties don't always fall to the same person.
 * The result never depends on the order of `candidates`.
 */
export function pickWelcomer(
  candidates: readonly WelcomerCandidate[],
  guest: GuestToWelcome,
  opts: { today: LocalDate; tenantId: string },
): WelcomerPick {
  const family = new Set(guest.householdMemberIds ?? []);
  const eligible = candidates.filter((c) => {
    if (family.has(c.id) || c.id === guest.id) return false;
    if (c.openCount >= c.maxOpen) return false;
    if (c.awayUntil && c.awayUntil >= opts.today) return false;
    if (c.campusIds && c.campusIds.length > 0) {
      return guest.campusId != null && c.campusIds.includes(guest.campusId);
    }
    return true;
  });
  if (eligible.length === 0) return { kind: 'POOL', reason: 'NO_ELIGIBLE_WELCOMER' };

  const ranked = eligible
    .map((c) => ({
      c,
      load: (c.openCount + RECENT_ASSIGNMENT_WEIGHT * c.assignedLast30d) / (c.weight ?? 1),
      last: c.lastAssignedAt ?? Number.NEGATIVE_INFINITY,
      tie: fnv1a(`${opts.tenantId}|${guest.id}|${c.id}`),
    }))
    .sort(
      (a, b) => a.load - b.load || a.last - b.last || a.tie - b.tie || a.c.id.localeCompare(b.c.id),
    );

  return { kind: 'ASSIGNED', welcomerId: (ranked[0] as (typeof ranked)[number]).c.id };
}

/** 32-bit FNV-1a. Not cryptographic; only used for stable tie-breaking. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
