// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_LOCK_KEY = 'thefold-community-migrate';

/**
 * Applies `*.sql` files in name order, each in its own transaction, once. Run it as `fold_migrator`
 * (the schema owner), never as the application role. Editing a migration that has already been
 * applied is an error: write a new one.
 */
export async function migrate(
  client: Client,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationReport> {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );

    const report: MigrationReport = { applied: [], alreadyApplied: [] };
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was edited after it was applied. Add a new migration instead.`,
          );
        }
        report.alreadyApplied.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        );
      }
      report.applied.push(file);
    }
    return report;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
  }
}
