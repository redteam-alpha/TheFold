// SPDX-License-Identifier: AGPL-3.0-or-later
import { deterministicUuid, FOLD_ID_NAMESPACE } from '@thefold/shared';
import type {
  GuestUpsertInput,
  GuestUpsertResult,
  TwentyGateway,
} from '../../src/twenty/gateway.js';

type Method = 'upsertGuest' | 'createFollowUp' | 'createCareRequest' | 'recordAttendance';
type FollowUp = Parameters<TwentyGateway['createFollowUp']>[1];

const uuid = (ref: string) => deterministicUuid(`memory:${ref}`, FOLD_ID_NAMESPACE);

/**
 * A stand-in for Twenty that is idempotent on `sourceRef` exactly like the real gateway must be, and that
 * can fail on demand: before applying (nothing happened), or AFTER applying (the response was lost).
 */
export class MemoryGateway implements TwentyGateway {
  readonly guests = new Map<string, { input: GuestUpsertInput; result: GuestUpsertResult }>();
  readonly followUps = new Map<string, { id: string; followUp: FollowUp }>();
  readonly attendances = new Map<string, unknown>();
  readonly careRequests = new Map<string, unknown>();
  readonly calls: Method[] = [];
  /** How many more calls to `method` should fail before applying. */
  private failBefore: Partial<Record<Method, number>> = {};
  /** How many more calls should apply and THEN fail (a lost response). */
  private failAfter: Partial<Record<Method, number>> = {};

  failing(method: Method, times: number, when: 'before' | 'after' = 'before'): this {
    (when === 'before' ? this.failBefore : this.failAfter)[method] = times;
    return this;
  }

  private gate(method: Method): { after: () => void } {
    this.calls.push(method);
    if ((this.failBefore[method] ?? 0) > 0) {
      this.failBefore[method] = (this.failBefore[method] ?? 0) - 1;
      throw new Error(`simulated Twenty outage in ${method}`);
    }
    return {
      after: () => {
        if ((this.failAfter[method] ?? 0) > 0) {
          this.failAfter[method] = (this.failAfter[method] ?? 0) - 1;
          throw new Error(`simulated lost response after ${method} was applied`);
        }
      },
    };
  }

  upsertGuest(input: GuestUpsertInput): Promise<GuestUpsertResult> {
    const g = this.gate('upsertGuest');
    if (!this.guests.has(input.sourceRef)) {
      const result: GuestUpsertResult = input.existingPersonId
        ? {
            primaryPersonId: input.existingPersonId,
            personIds: [input.existingPersonId],
            householdId: null,
          }
        : {
            primaryPersonId: uuid(`${input.sourceRef}:p0`),
            personIds: [
              uuid(`${input.sourceRef}:p0`),
              ...input.guest.householdMembers.map((_, i) => uuid(`${input.sourceRef}:m${i}`)),
            ],
            householdId:
              input.guest.householdMembers.length > 0 ? uuid(`${input.sourceRef}:hh`) : null,
          };
      this.guests.set(input.sourceRef, { input, result });
    }
    g.after();
    return Promise.resolve(
      (this.guests.get(input.sourceRef) as { result: GuestUpsertResult }).result,
    );
  }

  createFollowUp(sourceRef: string, followUp: FollowUp) {
    const g = this.gate('createFollowUp');
    const existing = this.followUps.get(sourceRef);
    if (!existing) this.followUps.set(sourceRef, { id: uuid(sourceRef), followUp });
    g.after();
    return Promise.resolve({ id: uuid(sourceRef), created: !existing });
  }

  createCareRequest(
    sourceRef: string,
    careRequest: Parameters<TwentyGateway['createCareRequest']>[1],
  ) {
    const g = this.gate('createCareRequest');
    const existing = this.careRequests.has(sourceRef);
    if (!existing) this.careRequests.set(sourceRef, careRequest);
    g.after();
    return Promise.resolve({ id: uuid(sourceRef), created: !existing });
  }

  recordAttendance(
    sourceRef: string,
    attendance: Parameters<TwentyGateway['recordAttendance']>[1],
  ) {
    const g = this.gate('recordAttendance');
    const existing = this.attendances.has(sourceRef);
    if (!existing) this.attendances.set(sourceRef, attendance);
    g.after();
    return Promise.resolve({ id: uuid(sourceRef), created: !existing });
  }

  followUpsOfKind(kind: string): FollowUp[] {
    return [...this.followUps.values()].map((f) => f.followUp).filter((f) => f.kind === kind);
  }
}
