// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalDate } from '../dates.js';
import type { LifecycleStage } from '../domain.js';

export interface DriftPerson {
  id: string;
  householdId: string | null;
  isMinor: boolean;
  isPrimaryContact?: boolean;
  lifecycleStage: LifecycleStage;
  doNotContact: boolean;
  awayUntil?: LocalDate | null;
  acceptedGapDays?: number | null;
  engagementDates: readonly LocalDate[];
}

/** What gets evaluated: one adult, or one household. */
export interface DriftUnit {
  unitId: string;
  /** The adult a shepherd would actually contact. Never a minor. */
  subjectPersonId: string;
  memberIds: string[];
  engagementDates: LocalDate[];
  lifecycleStage: LifecycleStage;
  isMinor: false;
  doNotContact: false;
  awayUntil: LocalDate | null;
  acceptedGapDays: number | null;
}

export interface DriftUnitSkip {
  personId: string;
  reason: 'MINOR_WITHOUT_ADULT' | 'DO_NOT_CONTACT';
}

/**
 * Minors are never evaluated on their own. A household with more than one member is evaluated on
 * the union of everyone's engagement (a family whose kids attend Sunday school is not "gone"), and
 * produces one item addressed to one adult. Single adults are evaluated individually.
 */
export function resolveDriftUnits(people: readonly DriftPerson[]): {
  units: DriftUnit[];
  skipped: DriftUnitSkip[];
} {
  const units: DriftUnit[] = [];
  const skipped: DriftUnitSkip[] = [];

  const byHousehold = new Map<string, DriftPerson[]>();
  const singles: DriftPerson[] = [];
  for (const p of people) {
    if (p.householdId) {
      const list = byHousehold.get(p.householdId) ?? [];
      list.push(p);
      byHousehold.set(p.householdId, list);
    } else {
      singles.push(p);
    }
  }

  for (const p of singles) {
    if (p.isMinor) skipped.push({ personId: p.id, reason: 'MINOR_WITHOUT_ADULT' });
    else if (p.doNotContact) skipped.push({ personId: p.id, reason: 'DO_NOT_CONTACT' });
    else units.push(buildUnit(`person:${p.id}`, p, [p]));
  }

  for (const [householdId, members] of byHousehold) {
    const adults = members.filter((m) => !m.isMinor);
    if (adults.length === 0) {
      for (const m of members) skipped.push({ personId: m.id, reason: 'MINOR_WITHOUT_ADULT' });
      continue;
    }
    const contactable = adults.filter((a) => !a.doNotContact);
    if (contactable.length === 0) {
      for (const a of adults) skipped.push({ personId: a.id, reason: 'DO_NOT_CONTACT' });
      continue;
    }
    // Prefer the primary contact; otherwise the lowest id, so the choice is stable across runs.
    const subject =
      contactable.find((a) => a.isPrimaryContact) ??
      [...contactable].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!subject) continue;

    if (members.length === 1) units.push(buildUnit(`person:${subject.id}`, subject, members));
    else units.push(buildUnit(`household:${householdId}`, subject, members));
  }

  units.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return { units, skipped };
}

function buildUnit(
  unitId: string,
  subject: DriftPerson,
  members: readonly DriftPerson[],
): DriftUnit {
  const accepted = members.reduce<number | null>((max, m) => {
    if (m.acceptedGapDays == null) return max;
    return max == null ? m.acceptedGapDays : Math.max(max, m.acceptedGapDays);
  }, null);
  return {
    unitId,
    subjectPersonId: subject.id,
    memberIds: members.map((m) => m.id).sort(),
    engagementDates: [...new Set(members.flatMap((m) => m.engagementDates))].sort(),
    lifecycleStage: subject.lifecycleStage,
    isMinor: false,
    doNotContact: false,
    awayUntil: subject.awayUntil ?? null,
    acceptedGapDays: accepted,
  };
}
