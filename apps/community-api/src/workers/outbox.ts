// SPDX-License-Identifier: AGPL-3.0-or-later
import { toLocalDate } from '@thefold/core';
import type { Pool, PoolClient } from 'pg';
import { upsertPersonRead } from '../db/readModels.js';
import { assignWelcome } from '../intake/assignment.js';
import { claimOutbox, completeOutbox, failOutbox, type ClaimedJob } from '../db/outbox.js';
import { withTenant } from '../db/tenant.js';
import type { GuestUpsertResult, TwentyGateway } from '../twenty/gateway.js';

export interface ProcessOptions {
  limit?: number;
  leaseSeconds?: number;
  now?: Date;
}

export interface ProcessReport {
  done: number;
  retried: number;
  dead: number;
}

/**
 * Sends one tenant's due outbox jobs to Twenty.
 *
 * The shape matters more than the details:
 *   1. claim jobs in a short transaction (a lease, so a dead worker's jobs come back);
 *   2. call Twenty OUTSIDE any database transaction (a slow API never holds row locks);
 *   3. record the result in a second short transaction, together with any follow-on work, so the
 *      follow-on rows and "job done" commit atomically.
 * If the worker dies between 2 and 3 the lease expires and the job runs again; every gateway call is
 * idempotent on its source reference, so running again changes nothing.
 */
export async function processOutbox(
  pool: Pool,
  tenantId: string,
  gateway: TwentyGateway,
  opts: ProcessOptions = {},
): Promise<ProcessReport> {
  const now = opts.now ?? new Date();
  const jobs = await withTenant(pool, tenantId, (c) =>
    claimOutbox(c, { limit: opts.limit ?? 25, leaseSeconds: opts.leaseSeconds ?? 120 }),
  );
  const report: ProcessReport = { done: 0, retried: 0, dead: 0 };

  for (const claimed of jobs) {
    try {
      await runJob(pool, tenantId, gateway, claimed, now);
      report.done++;
    } catch (error) {
      const outcome = await withTenant(pool, tenantId, (c) =>
        failOutbox(c, claimed.id, error instanceof Error ? error.message : String(error)),
      );
      if (outcome?.status === 'DEAD') report.dead++;
      else report.retried++;
    }
  }
  return report;
}

async function runJob(
  pool: Pool,
  tenantId: string,
  gateway: TwentyGateway,
  claimed: ClaimedJob,
  now: Date,
): Promise<void> {
  const { job } = claimed;
  switch (job.kind) {
    case 'twenty.createFollowUp': {
      await gateway.createFollowUp(claimed.idempotencyKey, job.followUp);
      break;
    }
    case 'twenty.createCareRequest': {
      await gateway.createCareRequest(claimed.idempotencyKey, job.careRequest, now.getTime());
      break;
    }
    case 'twenty.recordAttendance': {
      await gateway.recordAttendance(claimed.idempotencyKey, job.attendance);
      break;
    }
    case 'twenty.upsertGuest': {
      const tz = await withTenant(
        pool,
        tenantId,
        async (c) =>
          (await c.query<{ timezone: string }>('SELECT timezone FROM tenant')).rows[0]?.timezone ??
          'UTC',
      );
      const visitedOn = job.guest.visitedOn ?? toLocalDate(job.visitedAt, tz);
      const result = await gateway.upsertGuest({
        sourceRef: claimed.idempotencyKey,
        guest: job.guest,
        visitedOn,
        visitedAt: job.visitedAt,
        existingPersonId: job.existingPersonId,
        dedupeStatus: job.dedupe.status,
      });
      // Follow-on rows and "done" commit together (see the function comment above).
      await withTenant(pool, tenantId, async (c) => {
        if (!job.existingPersonId) await writeThroughGuests(c, job.guest, result);
        await assignWelcome(c, {
          guest: job.guest,
          visitedAt: job.visitedAt,
          visitedOn,
          existingPersonId: job.existingPersonId,
          result,
          tenantId,
          timezone: tz,
          now,
        });
        await completeOutbox(c, claimed.id);
      });
      return;
    }
  }
  await withTenant(pool, tenantId, (c) => completeOutbox(c, claimed.id));
}

/**
 * Puts the people we just created into the read model straight away, so a guest who comes back two days
 * later is recognised even if Twenty's webhook has not arrived. The placeholder timestamp is the epoch, so
 * ANY real record from Twenty (webhook or hourly reconcile) supersedes it.
 */
async function writeThroughGuests(
  c: PoolClient,
  guest: Extract<ClaimedJob['job'], { kind: 'twenty.upsertGuest' }>['guest'],
  result: GuestUpsertResult,
): Promise<void> {
  const people = [
    {
      id: result.personIds[0],
      first: guest.firstName,
      last: guest.lastName,
      minor: false,
      primary: true,
    },
    ...guest.householdMembers.map((m, i) => ({
      id: result.personIds[i + 1],
      first: m.firstName,
      last: m.lastName ?? guest.lastName,
      minor: m.isChild,
      primary: false,
    })),
  ];
  for (const p of people) {
    if (!p.id) continue;
    await upsertPersonRead(c, {
      twentyPersonId: p.id,
      twentyUpdatedAt: new Date(1),
      firstName: p.first,
      lastName: p.last,
      emails: p.primary && guest.email ? [guest.email] : [],
      phones: p.primary && guest.phone ? [guest.phone] : [],
      isMinor: p.minor,
      sharedEmail: false,
      householdId: result.householdId,
      lifecycleStage: 'NEW_GUEST',
      doNotContact: p.minor,
      awayUntil: null,
      deletedAt: null,
    });
  }
}
