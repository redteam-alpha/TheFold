// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import type { SetupConfig, TenantProvisioning } from '../config.js';
import { migrate, type MigrationReport } from '../db/migrate.js';
import type { Logger } from '../log.js';
import { storeTenantSecret } from '../tenants/secrets.js';

export const ROLES_SQL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../db/roles.sql');

/**
 * Prepares a database for The Fold, as a superuser, idempotently:
 *   - creates the two roles (db/roles.sql) and sets their passwords;
 *   - hands the database to `fold_migrator`, so the schema is owned by the migrator and not by a superuser.
 * The running service never connects as a superuser; this is the only step that does, and it is optional
 * (a managed database where the roles already exist skips it).
 */
export async function bootstrapDatabase(
  superuserUrl: string,
  passwords: { app: string; migrator: string },
): Promise<{ database: string }> {
  const c = new Client({ connectionString: superuserUrl });
  await c.connect();
  try {
    await c.query(readFileSync(ROLES_SQL_PATH, 'utf8'));
    // ALTER ROLE takes no bind parameters: build it with format(%I, %L) so the password is quoted by Postgres.
    for (const [role, password] of [
      ['fold_app', passwords.app],
      ['fold_migrator', passwords.migrator],
    ] as const) {
      const { rows } = await c.query<{ sql: string }>(
        `SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`,
        [role, password],
      );
      await c.query((rows[0] as { sql: string }).sql);
    }
    const { rows } = await c.query<{ db: string; sql: string }>(
      `SELECT current_database() AS db, format('ALTER DATABASE %I OWNER TO fold_migrator', current_database()) AS sql`,
    );
    const row = rows[0] as { db: string; sql: string };
    await c.query(row.sql);
    return { database: row.db };
  } finally {
    await c.end();
  }
}

export async function migrateDatabase(migratorUrl: string): Promise<MigrationReport> {
  const c = new Client({ connectionString: migratorUrl });
  await c.connect();
  try {
    return await migrate(c);
  } finally {
    await c.end();
  }
}

/**
 * Creates or updates a church and stores its Twenty credentials, as the schema owner (`fold_app` may never
 * create tenants). Re-running with the same values changes nothing; a new API key is stored as a new version.
 */
export async function provisionTenant(
  migratorUrl: string,
  kek: Buffer,
  t: TenantProvisioning,
): Promise<{ tenantId: string; apiKeyVersion: number; webhookSecretVersion: number | null }> {
  const pool = new Pool({ connectionString: migratorUrl, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tenant (slug, subdomain, name, timezone, twenty_base_url, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       ON CONFLICT (slug) DO UPDATE SET subdomain = EXCLUDED.subdomain, name = EXCLUDED.name,
         timezone = EXCLUDED.timezone, twenty_base_url = EXCLUDED.twenty_base_url, status = 'ACTIVE'
       RETURNING id`,
      [t.slug, t.subdomain, t.name, t.timezone, t.twentyBaseUrl],
    );
    const tenantId = (rows[0] as { id: string }).id;
    // tenant_secret has FORCE row-level security: even the owner writes it only inside the tenant's context.
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const apiKeyVersion = await storeTenantSecret(c, kek, 'twenty_api_key', t.twentyApiKey);
    const webhookSecretVersion = t.twentyWebhookSecret
      ? await storeTenantSecret(c, kek, 'twenty_webhook_secret', t.twentyWebhookSecret)
      : null;
    await c.query('COMMIT');
    return { tenantId, apiKeyVersion, webhookSecretVersion };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}

/** `setup`: bootstrap (if a superuser URL is given) → migrate → provision (if a church is configured). */
export async function runSetup(cfg: SetupConfig, log: Logger): Promise<void> {
  if (cfg.superuserUrl && cfg.rolePasswords) {
    const { database } = await bootstrapDatabase(cfg.superuserUrl, cfg.rolePasswords);
    log.info('setup.bootstrapped', { database });
  } else {
    log.info('setup.bootstrap_skipped', { reason: 'FOLD_DB_SUPERUSER_URL not set' });
  }
  const m = await migrateDatabase(cfg.migratorUrl);
  log.info('setup.migrated', {
    applied: m.applied.join(',') || 'none',
    alreadyApplied: m.alreadyApplied.length,
  });
  if (cfg.tenant && cfg.kek) {
    const p = await provisionTenant(cfg.migratorUrl, cfg.kek, cfg.tenant);
    log.info('setup.tenant_ready', {
      tenantId: p.tenantId,
      slug: cfg.tenant.slug,
      subdomain: cfg.tenant.subdomain,
      apiKeyVersion: p.apiKeyVersion,
      webhookSecretVersion: p.webhookSecretVersion,
    });
  } else {
    log.info('setup.tenant_skipped', { reason: 'FOLD_TENANT_SLUG not set' });
  }
}
