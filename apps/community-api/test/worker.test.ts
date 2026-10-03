// SPDX-License-Identifier: AGPL-3.0-or-later
import { TokenBucket, TwentyClient, type TwentyClientOptions } from '@thefold/twenty-client';
import { FakeTwenty } from '@thefold/twenty-client/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { recordWebhookHint } from '../src/db/webhookInbox.js';
import { submitConnectionCard } from '../src/intake/connectionCard.js';
import { reconcileObject } from '../src/sync/reconcile.js';
import { createLogger, silentLogger } from '../src/log.js';
import { storeTenantSecret } from '../src/tenants/secrets.js';
import { TenantNotConfiguredError, TwentyConnections } from '../src/tenants/runtime.js';
import { Worker, type TwentyAccess } from '../src/workers/loop.js';
import {
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';
import { MemoryGateway } from './helpers/memoryGateway.js';

const NOW = new Date('2026-09-27T15:00:00Z');
const KEK = Buffer.alloc(32, 5);
const WELCOMER = '00000000-0000-4000-8000-0000000000a1';

const fastClient = (server: FakeTwenty, over: Partial<TwentyClientOptions> = {}) =>
  new TwentyClient({
    baseUrl: 'https://twenty.test',
    apiKey: 'service-key',
    fetch: server.fetch,
    bucket: new TokenBucket({
      capacity: 1e4,
      refillPerSecond: 1e4,
      backgroundReserve: 0,
      now: Date.now,
    }),
    retry: { sleep: () => Promise.resolve(), random: () => 0 },
    ...over,
  });

describe.skipIf(!dbAvailable)('worker', () => {
  let db: TestDb;
  let n = 0;
  let t: SeededTenant;
  let server: FakeTwenty;
  let gw: MemoryGateway;
  let access: TwentyAccess;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    t = await seedTenant(db, `worker-${++n}`);
    server = new FakeTwenty();
    gw = new MemoryGateway();
    const client = fastClient(server);
    access = { clientFor: () => Promise.resolve(client), gatewayFor: () => Promise.resolve(gw) };
  });

  const inT = <R>(fn: Parameters<typeof withTenant<R>>[2]) => withTenant(db.appPool, t.id, fn);
  const worker = (over: Partial<ConstructorParameters<typeof Worker>[0]> = {}) =>
    new Worker({
      pool: db.appPool,
      twenty: access,
      log: silentLogger,
      reconcileEveryMs: 3_600_000,
      now: () => NOW,
      ...over,
    });
  const people = () =>
    inT((c) =>
      c.query<{ twenty_person_id: string; first_name: string; deleted_at: Date | null }>(
        `SELECT twenty_person_id, first_name, deleted_at FROM person_read ORDER BY first_name`,
      ),
    ).then((r) => r.rows);
  const hint = (recordId: string, deliveryId: string, objectType = 'person') =>
    inT((c) =>
      recordWebhookHint(c, {
        tenantId: t.id,
        objectType,
        recordId,
        action: 'updated',
        deliveryId,
        receivedAt: NOW.getTime(),
      }),
    );
  const twentyPerson = (firstName: string) =>
    fastClient(server).createRecord('people', {
      name: { firstName, lastName: 'Test' },
      emails: { primaryEmail: `${firstName.toLowerCase()}@example.com` },
      lifecycleStage: 'CONNECTED',
    });

  it('sends a submitted card to Twenty and queues the welcome, in one tick', async () => {
    await inT((c) =>
      c.query(
        `INSERT INTO welcomer_load (tenant_id, twenty_person_id) VALUES (fold_current_tenant(), $1)`,
        [WELCOMER],
      ),
    );
    await inT((c) =>
      submitConnectionCard(
        c,
        {
          firstName: 'Sam',
          lastName: 'Rivera',
          email: 'sam@example.com',
          contactConsent: { byEmail: true, byPhone: false, byText: false },
        },
        NOW,
      ),
    );
    const r = await worker().tickTenant(t.id);
    expect(r.errors).toBe(0);
    expect(r.outbox.dead).toBe(0);
    expect(gw.guests.size).toBe(1);
    expect([...gw.followUps.values()].map((f) => f.followUp.ownerPersonId)).toContain(WELCOMER);
    const pending = await inT((c) => c.query(`SELECT 1 FROM outbox WHERE status <> 'DONE'`));
    expect(pending.rowCount).toBe(0);
  });

  it('applies a webhook hint by refetching the record, and marks a vanished record deleted', async () => {
    const sam = await twentyPerson('Sam');
    await hint(sam.id, 'd1');
    await worker({ reconcileEveryMs: 1e12 }).tickTenant(t.id);
    // The first tick also reconciles; check the refetch on its own with a fresh record below.
    const fresh = await twentyPerson('Ana');
    await hint(fresh.id, 'd2');
    const r = await worker().tickTenant(t.id);
    expect(r.refetched).toBe(1);
    expect((await people()).map((p) => p.first_name)).toEqual(['Ana', 'Sam']);

    await fastClient(server).deleteRecord('people', fresh.id);
    await hint(fresh.id, 'd3');
    await worker().tickTenant(t.id);
    const ana = (await people()).find((p) => p.first_name === 'Ana');
    expect(ana?.deleted_at).toBeInstanceOf(Date);
  });

  it('ignores hints for objects it does not mirror', async () => {
    await hint('00000000-0000-4000-8000-0000000000c1', 'x1', 'company');
    const r = await worker().tickTenant(t.id);
    expect(r.errors).toBe(0);
    expect(await people()).toEqual([]);
  });

  it('reconciles on schedule, resumes from its cursor, and does not run twice within the interval', async () => {
    await twentyPerson('Ana');
    await twentyPerson('Ben');
    const first = await worker().tickTenant(t.id);
    expect(first.reconciled['person']).toBe(2);

    await twentyPerson('Cy');
    const second = await worker().tickTenant(t.id);
    expect(second.reconciled['person']).toBeUndefined(); // not due yet
    expect((await people()).map((p) => p.first_name)).toEqual(['Ana', 'Ben']);

    // An hour later (the due check uses the database clock, so move the last run back instead).
    await inT((c) => c.query(`UPDATE sync_cursor SET last_run_at = now() - interval '2 hours'`));
    const third = await worker().tickTenant(t.id);
    expect(third.reconciled['person']).toBe(1); // only what changed since the cursor
    expect((await people()).map((p) => p.first_name)).toEqual(['Ana', 'Ben', 'Cy']);
  });

  it('reads a long first sync in capped slices, continuing on the next tick instead of an hour later', async () => {
    for (const name of ['A1', 'A2', 'A3', 'A4', 'A5']) await twentyPerson(name);
    const client = fastClient(server);
    const slice = (maxPages: number) =>
      reconcileObject(db.appPool, t.id, client, 'person', {
        everyMs: 3_600_000,
        maxPages,
        pageSize: 2,
        log: silentLogger,
      });
    expect(await slice(1)).toMatchObject({ ran: true, more: true, applied: 2 });
    expect(await slice(1)).toMatchObject({ ran: true, more: true, applied: 2 });
    expect(await slice(5)).toMatchObject({ ran: true, more: false, applied: 1 });
    expect(await slice(5)).toMatchObject({ ran: false }); // caught up: now it waits for the interval
    expect((await people()).map((p) => p.first_name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('marks a person deleted in Twenty at the next reconcile, without any webhook', async () => {
    // Twenty's lists leave soft-deleted records out, so the changes pass alone never sees a delete (VM run,
    // 2026-10-02): this person would stay visible in the portal for good.
    await twentyPerson('Ana');
    const ben = await twentyPerson('Ben');
    const first = await worker().tickTenant(t.id);
    expect(first.reconciled).toMatchObject({ person: 2, 'person:deleted': 0 });

    await fastClient(server).deleteRecord('people', ben.id);
    await inT((c) => c.query(`UPDATE sync_cursor SET last_run_at = now() - interval '2 hours'`));
    const second = await worker().tickTenant(t.id);
    expect(second.reconciled).toMatchObject({ person: 0, 'person:deleted': 1 });
    const after = await people();
    expect(after.find((p) => p.first_name === 'Ben')?.deleted_at).toBeInstanceOf(Date);
    expect(after.find((p) => p.first_name === 'Ana')?.deleted_at).toBeNull();

    // The next run re-reads from just before its cursor: the same delete is not counted again.
    await inT((c) => c.query(`UPDATE sync_cursor SET last_run_at = now() - interval '2 hours'`));
    const third = await worker().tickTenant(t.id);
    expect(third.reconciled['person:deleted']).toBe(0);

    const cursors = await inT((c) =>
      c.query<{ object_type: string }>(`SELECT object_type FROM sync_cursor ORDER BY object_type`),
    );
    expect(cursors.rows.map((r) => r.object_type)).toEqual([
      'churchGroup',
      'churchGroup:deleted',
      'groupMembership',
      'groupMembership:deleted',
      'person',
      'person:deleted',
    ]);
  });

  it('copies groups from Twenty, and marks one deleted there as gone', async () => {
    const client = fastClient(server);
    const g = await client.createRecord('churchGroups', {
      name: 'Tuesday Supper',
      openness: 'SECRET',
      schedule: 'Tuesdays 7pm',
      capacity: 10,
    });
    const r = await worker().tickTenant(t.id);
    expect(r.reconciled['churchGroup']).toBe(1);
    const groups = () =>
      inT((c) =>
        c.query<{
          name: string;
          openness: string;
          schedule: string;
          capacity: number;
          deleted_at: Date | null;
        }>(`SELECT name, openness, schedule, capacity, deleted_at FROM group_read`),
      ).then((x) => x.rows);
    expect(await groups()).toEqual([
      {
        name: 'Tuesday Supper',
        openness: 'SECRET',
        schedule: 'Tuesdays 7pm',
        capacity: 10,
        deleted_at: null,
      },
    ]);

    await client.deleteRecord('churchGroups', g.id);
    await inT((c) => c.query(`UPDATE sync_cursor SET last_run_at = now() - interval '2 hours'`));
    expect((await worker().tickTenant(t.id)).reconciled['churchGroup:deleted']).toBe(1);
    expect((await groups())[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it('reads many deletions in capped slices, like changes', async () => {
    const client = fastClient(server);
    const made = [];
    for (const name of ['D1', 'D2', 'D3']) made.push(await twentyPerson(name));
    await reconcileObject(db.appPool, t.id, client, 'person', {
      everyMs: 3_600_000,
      log: silentLogger,
    });
    for (const p of made) await client.deleteRecord('people', p.id);
    const slice = (maxPages: number) =>
      reconcileObject(db.appPool, t.id, client, 'person', {
        everyMs: 3_600_000,
        maxPages,
        pageSize: 2,
        pass: 'deletes',
        log: silentLogger,
      });
    expect(await slice(1)).toMatchObject({ ran: true, more: true, applied: 2 });
    expect(await slice(5)).toMatchObject({ ran: true, more: false, applied: 1 });
    expect(await slice(5)).toMatchObject({ ran: false });
    expect((await people()).every((p) => p.deleted_at instanceof Date)).toBe(true);
  });

  it('keeps a church’s jobs waiting, not failed, until its Twenty key is set; housekeeping still runs', async () => {
    await inT((c) =>
      submitConnectionCard(
        c,
        {
          firstName: 'Sam',
          lastName: 'Rivera',
          email: 'sam@example.com',
          contactConsent: { byEmail: true, byPhone: false, byText: false },
        },
        NOW,
      ),
    );
    const unconfigured: TwentyAccess = {
      clientFor: (id) => Promise.reject(new TenantNotConfiguredError(id)),
      gatewayFor: (id) => Promise.reject(new TenantNotConfiguredError(id)),
    };
    const lines: string[] = [];
    const r = await worker({
      twenty: unconfigured,
      log: createLogger('info', (l) => lines.push(l)),
    }).tickTenant(t.id);
    expect(r).toMatchObject({ configured: false, errors: 0, housekeeping: true });
    const statuses = await inT((c) =>
      c.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM outbox`),
    );
    expect(statuses.rows).toEqual([{ status: 'PENDING', attempts: 0 }]);
    expect(lines.some((l) => l.includes('worker.tenant_not_configured'))).toBe(true);
  });

  it('isolates failures: an outage in one step does not stop the others', async () => {
    gw.failing('upsertGuest', 1);
    await inT((c) =>
      submitConnectionCard(
        c,
        {
          firstName: 'Sam',
          lastName: 'Rivera',
          email: 'sam@example.com',
          contactConsent: { byEmail: true, byPhone: false, byText: false },
        },
        NOW,
      ),
    );
    await twentyPerson('Ana');
    const r = await worker().tickTenant(t.id);
    expect(r.outbox.retried).toBe(1);
    expect(r.reconciled['person']).toBe(1);
  });

  it('never logs a name, an email or a key', async () => {
    const lines: string[] = [];
    await twentyPerson('Secretname');
    await inT((c) =>
      submitConnectionCard(
        c,
        {
          firstName: 'Privatefirst',
          lastName: 'Privatelast',
          email: 'private@example.com',
          contactConsent: { byEmail: true, byPhone: false, byText: false },
        },
        NOW,
      ),
    );
    gw.failing('upsertGuest', 1);
    await worker({ log: createLogger('debug', (l) => lines.push(l)) }).tickTenant(t.id);
    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const s of [
      'Secretname',
      'Privatefirst',
      'Privatelast',
      'private@example.com',
      'service-key',
    ])
      expect(all, s).not.toContain(s);
  });

  it('visits every active church in one tick', async () => {
    const other = await seedTenant(db, `worker-other-${n}`);
    const paused = await seedTenant(db, `worker-paused-${n}`, { status: 'SUSPENDED' });
    const ids = (await worker().tick()).map((r) => r.tenantId);
    expect(ids).toEqual(expect.arrayContaining([t.id, other.id]));
    expect(ids).not.toContain(paused.id);
  });
});

describe.skipIf(!dbAvailable)(
  'TwentyConnections: one client per church, from its stored key',
  () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db.drop();
    });

    it('refuses a church without a key, then builds, caches and rotates its client', async () => {
      const t = await seedTenant(db, 'conn-1');
      let clock = 0;
      const made: { baseUrl: string; apiKey: string }[] = [];
      const conns = new TwentyConnections(
        db.appPool,
        KEK,
        (o) => {
          made.push(o);
          return new TwentyClient({ ...o, fetch: new FakeTwenty().fetch });
        },
        60_000,
        () => clock,
      );
      await expect(conns.clientFor(t.id)).rejects.toBeInstanceOf(TenantNotConfiguredError);

      await withTenant(db.appPool, t.id, (c) =>
        storeTenantSecret(c, KEK, 'twenty_api_key', 'first-key-aaaaaaaaaaaa'),
      );
      const a = await conns.clientFor(t.id);
      const b = await conns.clientFor(t.id);
      expect(a).toBe(b);
      expect(made).toEqual([
        { baseUrl: 'https://conn-1.twenty.test', apiKey: 'first-key-aaaaaaaaaaaa' },
      ]);

      await withTenant(db.appPool, t.id, (c) =>
        storeTenantSecret(c, KEK, 'twenty_api_key', 'second-key-bbbbbbbbbbbb'),
      );
      expect(await conns.clientFor(t.id)).toBe(a); // still cached
      clock = 61_000;
      const rotated = await conns.clientFor(t.id);
      expect(rotated).not.toBe(a);
      expect(made.at(-1)?.apiKey).toBe('second-key-bbbbbbbbbbbb');

      clock = 200_000; // re-checked, unchanged: same client
      expect(await conns.clientFor(t.id)).toBe(rotated);
    });

    it('cannot read another church’s key, even with the same KEK', async () => {
      const a = await seedTenant(db, 'conn-a');
      const b = await seedTenant(db, 'conn-b');
      await withTenant(db.appPool, a.id, (c) =>
        storeTenantSecret(c, KEK, 'twenty_api_key', 'church-a-key-aaaaaaaaaaaa'),
      );
      const conns = new TwentyConnections(db.appPool, KEK);
      await expect(conns.clientFor(b.id)).rejects.toBeInstanceOf(TenantNotConfiguredError);
    });
  },
);
