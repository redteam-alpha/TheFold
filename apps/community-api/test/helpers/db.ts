// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool, type PoolClient } from 'pg';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate.js';

export const ADMIN_URL = process.env['FOLD_TEST_ADMIN_URL'];

/**
 * Database tests need a PostgreSQL 16 superuser URL (scripts/dev-pg.sh prints one). Without it they
 * are skipped locally; CI sets FOLD_REQUIRE_DB=1 so a missing database is a failure, never a silent pass.
 */
export const dbAvailable = Boolean(ADMIN_URL);
if (!ADMIN_URL && process.env['FOLD_REQUIRE_DB']) {
  throw new Error('FOLD_REQUIRE_DB is set but FOLD_TEST_ADMIN_URL is not');
}

const ROLES_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../db/roles.sql'),
  'utf8',
);

function urlFor(base: string, user: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDb {
  name: string;
  /** Connects as `fold_app`: what the running service uses. Subject to row-level security. */
  appPool: Pool;
  /** Connects as `fold_migrator`, the schema owner. Used to seed tenants (provisioning is privileged). */
  ownerPool: Pool;
  ownerUrl: string;
  appUrl: string;
  drop(): Promise<void>;
}

async function waitForNoBackends(admin: Client, database: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    if (Number(rows[0]?.n ?? 0) === 0 || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  if (!ADMIN_URL) throw new Error('FOLD_TEST_ADMIN_URL is not set');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    try {
      await admin.query(ROLES_SQL);
    } catch (error) {
      // Test files run in parallel and roles are cluster-wide: losing the create race is fine.
      const code = (error as { code?: string }).code;
      if (code !== '42710' && code !== '23505') throw error;
    }
    const name = `fold_test_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await admin.query(`CREATE DATABASE ${name} OWNER fold_migrator`);

    const ownerUrl = urlFor(ADMIN_URL, 'fold_migrator', name);
    const appUrl = urlFor(ADMIN_URL, 'fold_app', name);
    if (opts.migrate !== false) {
      const c = new Client({ connectionString: ownerUrl });
      await c.connect();
      try {
        await migrate(c, MIGRATIONS_DIR);
      } finally {
        await c.end();
      }
    }
    const appPool = new Pool({ connectionString: appUrl, max: 4 });
    const ownerPool = new Pool({ connectionString: ownerUrl, max: 2 });
    return {
      name,
      appPool,
      ownerPool,
      ownerUrl,
      appUrl,
      async drop() {
        await appPool.end();
        await ownerPool.end();
        const a = new Client({ connectionString: ADMIN_URL });
        await a.connect();
        try {
          // pool.end() sends Terminate but does not wait for the server to process it. Dropping with FORCE right
          // away can kill a backend whose client is already ending; that client has no error listener left, so the
          // 57P01 surfaces as an unhandled error and fails an otherwise green run. Wait for our own backends to
          // exit first; FORCE stays as the backstop for a genuinely stuck connection.
          await waitForNoBackends(a, name);
          await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        } finally {
          await a.end();
        }
      },
    };
  } finally {
    await admin.end();
  }
}

export interface SeededTenant {
  id: string;
  slug: string;
}

/** Provisioning is a privileged operation, done as the schema owner (fold_app cannot insert tenants). */
export async function seedTenant(
  db: TestDb,
  slug: string,
  over: { status?: string; subdomain?: string; timezone?: string } = {},
): Promise<SeededTenant> {
  const { rows } = await db.ownerPool.query<{ id: string }>(
    `INSERT INTO tenant (slug, subdomain, name, twenty_base_url, status, timezone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      slug,
      over.subdomain ?? slug,
      `Church ${slug}`,
      `https://${slug}.twenty.test`,
      over.status ?? 'ACTIVE',
      over.timezone ?? 'UTC',
    ],
  );
  return { id: (rows[0] as { id: string }).id, slug };
}

export { MIGRATIONS_DIR };

/**
 * Runs `fn` as the schema owner with the tenant context set (FORCE ROW LEVEL SECURITY applies to the
 * owner too). For test setup that the application role is deliberately not allowed to do, such as
 * back-dating a row.
 */
export async function asOwnerInTenant<T>(
  db: TestDb,
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.ownerPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
