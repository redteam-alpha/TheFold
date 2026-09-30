// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUuid } from '@thefold/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * Runs `fn` in a transaction scoped to one tenant. `set_config(..., true)` is transaction-local, so
 * the tenant can never leak to the next user of a pooled connection: when the transaction ends the
 * setting is gone and row-level security denies everything again.
 *
 * This is the ONLY way application code reaches tenant tables.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) throw new TypeError('withTenant requires a tenant UUID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below discards it.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Workers loop over these and call `withTenant` for each. Nothing runs with a role that bypasses RLS. */
export async function listActiveTenantIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT fold_list_active_tenant_ids() AS id');
  return rows.map((r) => r.id);
}

/** Resolves a request's subdomain before any tenant context exists. */
export async function tenantIdForSubdomain(pool: Pool, subdomain: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    'SELECT fold_tenant_id_for_subdomain($1) AS id',
    [subdomain],
  );
  return rows[0]?.id ?? null;
}
