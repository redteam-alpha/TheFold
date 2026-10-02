// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TwentyClient } from '@thefold/twenty-client';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { expirePrayerRequests } from '../care/prayer.js';
import { listActiveTenantIds, withTenant } from '../db/tenant.js';
import { pruneWebhookDeliveries } from '../db/webhookInbox.js';
import { errorFields, type Logger } from '../log.js';
import { processRefetches } from '../sync/refetch.js';
import { reconcileObject } from '../sync/reconcile.js';
import { SYNCED_OBJECTS } from '../sync/apply.js';
import { TenantNotConfiguredError } from '../tenants/runtime.js';
import type { TwentyGateway } from '../twenty/gateway.js';
import { processOutbox } from './outbox.js';

/** Where the worker gets each church's Twenty connection (TwentyConnections in production, fakes in tests). */
export interface TwentyAccess {
  clientFor(tenantId: string): Promise<TwentyClient>;
  gatewayFor(tenantId: string): Promise<TwentyGateway>;
}

export interface WorkerOptions {
  pool: Pool;
  twenty: TwentyAccess;
  log: Logger;
  reconcileEveryMs: number;
  housekeepingEveryMs?: number;
  /** Outbox batches per church per tick, so one busy church cannot starve the others. */
  maxOutboxRounds?: number;
  now?: () => Date;
}

export interface TenantTickReport {
  tenantId: string;
  configured: boolean;
  outbox: { done: number; retried: number; dead: number };
  refetched: number;
  reconciled: Record<string, number>;
  housekeeping: boolean;
  errors: number;
}

const WEBHOOK_DELIVERY_RETENTION_DAYS = 14;

/**
 * The background worker: everything slow or failure-prone that the API queued. One tick visits every active
 * church in turn and, for each, sends queued writes to Twenty, applies webhook hints, reconciles on schedule,
 * and does daily housekeeping.
 *
 * Each step is isolated: a failure is logged and the next step, and the next church, still run. Nothing here
 * contacts a congregant (CLAUDE.md rule 6): the worker creates tasks for people, it never messages anyone.
 *
 * Several workers can run at once: the outbox and the inbox are claimed with SKIP LOCKED, and a reconcile is
 * claimed by stamping its start time.
 */
export class Worker {
  private readonly lastHousekeeping = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly o: WorkerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  async tick(): Promise<TenantTickReport[]> {
    const reports: TenantTickReport[] = [];
    for (const tenantId of await listActiveTenantIds(this.o.pool))
      reports.push(await this.tickTenant(tenantId));
    return reports;
  }

  async tickTenant(tenantId: string): Promise<TenantTickReport> {
    const r: TenantTickReport = {
      tenantId,
      configured: true,
      outbox: { done: 0, retried: 0, dead: 0 },
      refetched: 0,
      reconciled: {},
      housekeeping: false,
      errors: 0,
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        r.errors++;
        this.o.log.error('worker.step_failed', { tenantId, step: name, ...errorFields(error) });
      }
    };

    let twenty: TwentyClient | null = null;
    let gateway: TwentyGateway | null = null;
    try {
      twenty = await this.o.twenty.clientFor(tenantId);
      gateway = await this.o.twenty.gatewayFor(tenantId);
    } catch (error) {
      r.configured = false;
      // Jobs stay PENDING (not failed, not dropped) until the church's key is set.
      if (error instanceof TenantNotConfiguredError)
        this.o.log.warn('worker.tenant_not_configured', { tenantId });
      else {
        r.errors++;
        this.o.log.error('worker.twenty_unavailable', { tenantId, ...errorFields(error) });
      }
    }

    if (gateway) {
      const gw = gateway;
      await step('outbox', async () => {
        for (let round = 0; round < (this.o.maxOutboxRounds ?? 10); round++) {
          const b = await processOutbox(this.o.pool, tenantId, gw, { now: this.now() });
          r.outbox.done += b.done;
          r.outbox.retried += b.retried;
          r.outbox.dead += b.dead;
          if (b.done + b.retried + b.dead === 0) break;
        }
        if (r.outbox.dead > 0)
          this.o.log.error('worker.outbox_dead', { tenantId, dead: r.outbox.dead });
      });
    }
    if (twenty) {
      const client = twenty;
      await step('refetch', async () => {
        const f = await processRefetches(this.o.pool, tenantId, client, { log: this.o.log });
        r.refetched = f.applied + f.stale + f.gone;
      });
      for (const objectType of Object.keys(SYNCED_OBJECTS))
        await step(`reconcile:${objectType}`, async () => {
          const rec = await reconcileObject(this.o.pool, tenantId, client, objectType, {
            everyMs: this.o.reconcileEveryMs,
            log: this.o.log,
          });
          if (rec.ran) r.reconciled[objectType] = rec.applied;
        });
    }

    const every = this.o.housekeepingEveryMs ?? 24 * 3_600_000;
    const last = this.lastHousekeeping.get(tenantId) ?? 0;
    if (this.now().getTime() - last >= every)
      await step('housekeeping', async () => {
        const at = this.now();
        await withTenant(this.o.pool, tenantId, async (c) => {
          await expirePrayerRequests(c, at);
          await pruneWebhookDeliveries(c, WEBHOOK_DELIVERY_RETENTION_DAYS);
        });
        this.lastHousekeeping.set(tenantId, at.getTime());
        r.housekeeping = true;
      });

    const busy =
      r.outbox.done + r.outbox.retried + r.outbox.dead + r.refetched > 0 ||
      Object.keys(r.reconciled).length > 0;
    if (busy || r.errors > 0)
      this.o.log.info('worker.tick', {
        tenantId,
        outboxDone: r.outbox.done,
        outboxRetried: r.outbox.retried,
        outboxDead: r.outbox.dead,
        refetched: r.refetched,
        reconciledPeople: r.reconciled['person'],
        reconciledMemberships: r.reconciled['groupMembership'],
        errors: r.errors,
      });
    return r;
  }

  /** Ticks every `pollMs` until `signal` aborts. A tick in progress always finishes: no half-sent batch. */
  async run(pollMs: number, signal: AbortSignal): Promise<void> {
    this.o.log.info('worker.started', { pollMs });
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        // Listing tenants failed (the database is down): log, wait, try again.
        this.o.log.error('worker.tick_failed', errorFields(error));
      }
      await delay(pollMs, undefined, { signal }).catch(() => undefined);
    }
    this.o.log.info('worker.stopped');
  }
}
