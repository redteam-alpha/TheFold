// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalDate } from '@thefold/core';
import type { Guest, OutboxJobInput } from '@thefold/shared';
import type { TwentyClient } from '@thefold/twenty-client';

/**
 * Everything the community service needs to WRITE to Twenty, as a port. Workers depend on this
 * interface, never on HTTP, so they are testable without a server and the REST details (unverified until
 * M0) live in exactly one place: `RestTwentyGateway`.
 *
 * Every method is idempotent on its `sourceRef`: calling it twice with the same reference returns the
 * same records and creates nothing new. That is what makes retries and worker crashes harmless.
 */
export interface GuestUpsertInput {
  sourceRef: string;
  guest: Guest;
  visitedOn: LocalDate;
  visitedAt: number;
  existingPersonId: string | null;
  dedupeStatus: 'CLEAR' | 'NEEDS_REVIEW';
}

export interface GuestUpsertResult {
  /** The adult the welcome is addressed to (the person who filled in the card). */
  primaryPersonId: string;
  /** Everyone created for this card, primary first. Welcomers are never chosen from this list. */
  personIds: string[];
  householdId: string | null;
}

type FollowUpJob = Extract<OutboxJobInput, { kind: 'twenty.createFollowUp' }>;
type CareRequestJob = Extract<OutboxJobInput, { kind: 'twenty.createCareRequest' }>;
type AttendanceJob = Extract<OutboxJobInput, { kind: 'twenty.recordAttendance' }>;
type MembershipJob = Extract<OutboxJobInput, { kind: 'twenty.upsertMembership' }>;

export interface TwentyGateway {
  upsertGuest(input: GuestUpsertInput): Promise<GuestUpsertResult>;
  createFollowUp(
    sourceRef: string,
    followUp: FollowUpJob['followUp'],
  ): Promise<{ id: string; created: boolean }>;
  createCareRequest(
    sourceRef: string,
    careRequest: CareRequestJob['careRequest'],
    openedAt: number,
  ): Promise<{ id: string; created: boolean }>;
  recordAttendance(
    sourceRef: string,
    attendance: AttendanceJob['attendance'],
  ): Promise<{ id: string; created: boolean }>;
  /** Creates or updates THE membership of a person in a group. `updatedAt` is Twenty's, when it says. */
  upsertMembership(
    membership: MembershipJob['membership'],
    today: string,
  ): Promise<{ id: string; created: boolean; updatedAt: string | null }>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The real thing, over Twenty's REST API. The payload shapes below (composite `emails`/`phones`, relations
 * set through `<field>Id`) come from Twenty's docs and are UNVERIFIED until the M0 harness has run
 * (docs/verification-status.md). If M0 says they differ, this is the only file that changes.
 */
export class RestTwentyGateway implements TwentyGateway {
  constructor(private readonly client: TwentyClient) {}

  async upsertGuest(input: GuestUpsertInput): Promise<GuestUpsertResult> {
    const { guest, sourceRef } = input;

    // A clear match: attach to the person we already know and change nothing about them.
    if (input.existingPersonId) {
      return {
        primaryPersonId: input.existingPersonId,
        personIds: [input.existingPersonId],
        householdId: null,
      };
    }

    const family = guest.householdMembers.length > 0;
    const household = family
      ? await this.client.upsertBySourceRef('households', `${sourceRef}:hh`, {
          name: `${guest.lastName} household`,
        })
      : null;

    const consent = guest.contactConsent;
    const primary = await this.client.upsertBySourceRef('people', `${sourceRef}:p0`, {
      name: { firstName: guest.firstName, lastName: guest.lastName },
      ...(guest.email ? { emails: { primaryEmail: guest.email } } : {}),
      ...(guest.phone ? { phones: { primaryPhoneNumber: guest.phone } } : {}),
      lifecycleStage: 'NEW_GUEST',
      firstVisitDate: input.visitedOn,
      dedupeStatus: input.dedupeStatus,
      interests: guest.interests,
      consentEmail: consent.byEmail,
      consentPhone: consent.byPhone,
      consentSms: consent.byText,
      consentAt: iso(input.visitedAt),
      isHouseholdPrimaryContact: family,
      ...(household ? { householdId: household.record.id } : {}),
      ...(guest.campusId ? { campusId: guest.campusId } : {}),
    });

    const personIds = [primary.record.id];
    for (const [i, member] of guest.householdMembers.entries()) {
      const child = await this.client.upsertBySourceRef('people', `${sourceRef}:m${i}`, {
        name: { firstName: member.firstName, lastName: member.lastName ?? guest.lastName },
        lifecycleStage: 'NEW_GUEST',
        firstVisitDate: input.visitedOn,
        // Children are parent-managed: flagged as minors, never contacted directly, never given a portal account.
        isMinor: member.isChild,
        doNotContact: member.isChild,
        ...(member.isChild ? { guardianId: primary.record.id } : {}),
        householdId: household?.record.id,
        ...(guest.campusId ? { campusId: guest.campusId } : {}),
      });
      personIds.push(child.record.id);
    }
    return {
      primaryPersonId: primary.record.id,
      personIds,
      householdId: household?.record.id ?? null,
    };
  }

  async createFollowUp(sourceRef: string, f: FollowUpJob['followUp']) {
    const { record, created } = await this.client.upsertBySourceRef('followUps', sourceRef, {
      name: f.title,
      kind: f.kind,
      status: 'OPEN',
      dueAt: iso(f.dueAt),
      subjectId: f.subjectPersonId,
      ...(f.ownerPersonId ? { ownerId: f.ownerPersonId } : {}),
      ...(f.contextSummary ? { contextSummary: f.contextSummary } : {}),
    });
    return { id: record.id, created };
  }

  async createCareRequest(sourceRef: string, c: CareRequestJob['careRequest'], openedAt: number) {
    const { record, created } = await this.client.upsertBySourceRef('careRequests', sourceRef, {
      // Non-sensitive on purpose: the reference is an opaque id, never words from the person.
      name: `Care ${c.communityRef.slice(0, 8)}`,
      status: 'OPEN',
      priority: c.priority,
      category: c.category,
      communityRef: c.communityRef,
      openedAt: iso(openedAt),
      personId: c.personId,
      ...(c.ownerPersonId ? { ownerId: c.ownerPersonId } : {}),
    });
    return { id: record.id, created };
  }

  async recordAttendance(sourceRef: string, a: AttendanceJob['attendance']) {
    const { record, created } = await this.client.upsertBySourceRef('attendances', sourceRef, {
      name: `${a.kind} ${a.date}`,
      date: a.date,
      kind: a.kind,
      source: a.source,
      ...(a.ref ? { ref: a.ref } : {}),
      personId: a.personId,
    });
    return { id: record.id, created };
  }

  async upsertMembership(m: MembershipJob['membership'], today: string) {
    const fields = {
      status: m.status,
      groupRole: m.role,
    };
    // Looked up by the pair every time, so a create whose response was lost is found and updated on retry.
    const existing = await this.client.findOneByIds('groupMemberships', {
      groupId: m.groupId,
      personId: m.personId,
    });
    if (existing) {
      const updated = await this.client.updateRecord('groupMemberships', existing.id, {
        ...fields,
        ...(m.status === 'ACTIVE' && !existing['joinedAt'] ? { joinedAt: today } : {}),
      });
      return { id: updated.id, created: false, updatedAt: stringOrNull(updated['updatedAt']) };
    }
    const created = await this.client.createRecord('groupMemberships', {
      name: 'From the member portal',
      groupId: m.groupId,
      personId: m.personId,
      ...fields,
      ...(m.status === 'ACTIVE' ? { joinedAt: today } : {}),
    });
    return { id: created.id, created: true, updatedAt: stringOrNull(created['updatedAt']) };
  }
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
