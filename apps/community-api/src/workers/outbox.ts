// SPDX-License-Identifier: AGPL-3.0-or-later
import { toLocalDate } from '@thefold/core';
import type { Pool, PoolClient } from 'pg';
import { upsertPersonRead, writeThroughMembership } from '../db/readModels.js';
import { assignWelcome } from '../intake/assignment.js';
import { claimOutbox, completeOutbox, failOutbox, type ClaimedJob } from '../db/outbox.js';
import { withTenant } from '../db/tenant.js';
import type { Mailer } from '../mail/mailer.js';
import { signInEmail } from '../mail/signInEmail.js';
import { prepareSignInLink, SIGN_IN_LINK_TTL_MS } from '../portal/signIn.js';
import type { GuestUpsertResult, TwentyGateway } from '../twenty/gateway.js';

/** How the worker sends member email. Absent: sign-in jobs fail and retry until it is configured. */
export interface MailDeps {
  mailer: Mailer;
  /** The church's public address, e.g. `https://grace.thefold.app` (no trailing slash). */
  publicUrl: (subdomain: string) => string;
}

export interface ProcessOptions {
  limit?: number;
  leaseSeconds?: number;
  now?: Date;
  mail?: MailDeps | null;
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
      await runJob(pool, tenantId, gateway, claimed, now, opts.mail ?? null);
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
  mail: MailDeps | null,
): Promise<void> {
  const { job } = claimed;
  switch (job.kind) {
    case 'mail.signInLink': {
      if (!mail) throw new Error('email is not configured (FOLD_SMTP_HOST)');
      const prepared = await withTenant(pool, tenantId, (c) =>
        prepareSignInLink(c, { email: job.email, ip: job.requestedIp, now }),
      );
      // Sent after the link is committed: a failed send retries the job, which makes a fresh link.
      if (prepared.send)
        await mail.mailer.send(
          signInEmail({
            to: job.email,
            churchName: prepared.churchName,
            link: `${mail.publicUrl(prepared.subdomain)}/sign-in/confirm?token=${prepared.token}`,
            minutes: SIGN_IN_LINK_TTL_MS / 60_000,
          }),
        );
      break;
    }
    case 'twenty.createFollowUp': {
      await gateway.createFollowUp(claimed.idempotencyKey, job.followUp);
      break;
    }
    case 'twenty.createCareRequest': {
      await gateway.createCareRequest(claimed.idempotencyKey, job.careRequest, now.getTime());
      break;
    }
    case 'twenty.upsertMembership': {
      const m = job.membership;
      const tz = await withTenant(
        pool,
        tenantId,
        async (c) =>
          (await c.query<{ timezone: string }>('SELECT timezone FROM tenant')).rows[0]?.timezone ??
          'UTC',
      );
      const r = await gateway.upsertMembership(m, toLocalDate(now.getTime(), tz));
      // Written straight through, so the member and the leader see the change before Twenty's webhook.
      await withTenant(pool, tenantId, async (c) => {
        await writeThroughMembership(c, {
          twentyMembershipId: r.id,
          twentyUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
          groupId: m.groupId,
          personId: m.personId,
          role: m.role,
          status: m.status,
        });
        await completeOutbox(c, claimed.id);
      });
      return;
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
