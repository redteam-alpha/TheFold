// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { TwentyClient } from '@thefold/twenty-client';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SetupConfig, TenantProvisioning } from '../src/config.js';
import { tenantIdForSubdomain } from '../src/db/tenant.js';
import { createLogger } from '../src/log.js';
import { runSetup } from '../src/setup/setup.js';
import { TwentyConnections } from '../src/tenants/runtime.js';
import { ADMIN_URL, dbAvailable } from './helpers/db.js';

const KEK = Buffer.alloc(32, 3);

const urlAs = (user: string | null, database: string): string => {
  const u = new URL(ADMIN_URL as string);
  if (user) {
    u.username = user;
    u.password = '';
  }
  u.pathname = `/${database}`;
  return u.toString();
};

/**
 * The compose stack's path: a database created by the Postgres image (owned by the superuser, no roles, no
 * schema) is turned into a working community database by one `setup` run, and running it again is a no-op.
 */
describe.skipIf(!dbAvailable)('setup on a brand-new database', () => {
  const name = `fold_setup_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let appPool: Pool;

  const tenant: TenantProvisioning = {
    slug: 'grace',
    name: 'Grace Fellowship (test)',
    subdomain: 'grace',
    timezone: 'America/Chicago',
    twentyBaseUrl: 'http://twenty-server:3000',
    twentyApiKey: 'service-key-aaaaaaaaaaaa',
    twentyWebhookSecret: 'webhook-bbbbbbbbbbbb',
  };
  const cfg = (over: Partial<SetupConfig> = {}): SetupConfig => ({
    superuserUrl: urlAs(null, name),
    migratorUrl: urlAs('fold_migrator', name),
    rolePasswords: { app: 'app-aaaaaaaaaaaa', migrator: 'migrator-aaaaaaaaaaaa' },
    tenant,
    kek: KEK,
    ...over,
  });

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    appPool = new Pool({ connectionString: urlAs('fold_app', name), max: 2 });
  });
  afterAll(async () => {
    await appPool.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('bootstraps, migrates and provisions; secrets never reach the log', async () => {
    const lines: string[] = [];
    await runSetup(
      cfg(),
      createLogger('info', (l) => lines.push(l)),
    );

    const owner = await appPool.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`,
    );
    expect(owner.rows[0]?.owner).toBe('fold_migrator');
    const migrations = await appPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables WHERE tablename IN ('tenant', 'outbox', 'post', 'prayer_request')`,
    );
    expect(migrations.rows[0]?.n).toBe('4');

    const id = await tenantIdForSubdomain(appPool, 'grace');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const made: { baseUrl: string; apiKey: string }[] = [];
    const conns = new TwentyConnections(appPool, KEK, (o) => {
      made.push(o);
      return new TwentyClient(o);
    });
    await conns.clientFor(id as string);
    expect(made).toEqual([
      { baseUrl: 'http://twenty-server:3000', apiKey: 'service-key-aaaaaaaaaaaa' },
    ]);

    const log = lines.join('\n');
    expect(log).toContain('setup.tenant_ready');
    for (const secret of ['service-key-aaaaaaaaaaaa', 'webhook-bbbbbbbbbbbb', 'app-aaaaaaaaaaaa'])
      expect(log).not.toContain(secret);
  });

  it('is idempotent, and stores a changed key as a new version', async () => {
    await runSetup(
      cfg(),
      createLogger('error', () => undefined),
    );
    const versions = async () => {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        const id = await tenantIdForSubdomain(appPool, 'grace');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        const r = await c.query<{ name: string; v: number }>(
          `SELECT name, max(key_version) AS v FROM tenant_secret GROUP BY name ORDER BY name`,
        );
        await c.query('COMMIT');
        return r.rows;
      } finally {
        c.release();
      }
    };
    expect(await versions()).toEqual([
      { name: 'twenty_api_key', v: 1 },
      { name: 'twenty_webhook_secret', v: 1 },
    ]);

    await runSetup(
      cfg({
        superuserUrl: null,
        rolePasswords: null,
        tenant: { ...tenant, twentyApiKey: 'rotated-key-cccccccccccc' },
      }),
      createLogger('error', () => undefined),
    );
    expect(await versions()).toEqual([
      { name: 'twenty_api_key', v: 2 },
      { name: 'twenty_webhook_secret', v: 1 },
    ]);
  });

  it('the application role still cannot create a church or bypass row-level security', async () => {
    await expect(
      appPool.query(
        `INSERT INTO tenant (slug, subdomain, name, twenty_base_url) VALUES ('x-x', 'x-x', 'x', 'http://x')`,
      ),
    ).rejects.toThrow(/permission denied/);
    const visible = await appPool.query('SELECT * FROM tenant_secret');
    expect(visible.rowCount).toBe(0);
  });
});
