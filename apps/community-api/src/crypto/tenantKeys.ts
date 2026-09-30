// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PoolClient } from 'pg';
import { generateDataKey, unwrapKey, wrapKey } from './envelope.js';

export interface DataKey {
  dek: Buffer;
  version: number;
}

const SECRET_NAME = 'data_key';
const wrapAad = (tenantId: string, version: number) =>
  `${tenantId}|tenant_secret|${SECRET_NAME}|${version}`;

async function currentTenantId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>('SELECT fold_current_tenant() AS id');
  const id = rows[0]?.id;
  if (!id) throw new Error('No tenant context: run inside withTenant');
  return id;
}

/**
 * The tenant's current data key, creating version 1 on first use. Old versions stay readable so
 * rotation is "add a version, re-encrypt lazily". Must run inside `withTenant`.
 */
export async function getCurrentDataKey(client: PoolClient, kek: Buffer): Promise<DataKey> {
  const tenantId = await currentTenantId(client);
  const latest = await client.query<{ key_version: number; wrapped: Buffer }>(
    `SELECT key_version, wrapped FROM tenant_secret WHERE name = $1 ORDER BY key_version DESC LIMIT 1`,
    [SECRET_NAME],
  );
  const row = latest.rows[0];
  if (row)
    return {
      version: row.key_version,
      dek: unwrapKey(row.wrapped, kek, wrapAad(tenantId, row.key_version)),
    };

  const dek = generateDataKey();
  const inserted = await client.query<{ key_version: number }>(
    `INSERT INTO tenant_secret (tenant_id, name, key_version, wrapped) VALUES (fold_current_tenant(), $1, 1, $2)
     ON CONFLICT DO NOTHING RETURNING key_version`,
    [SECRET_NAME, wrapKey(dek, kek, wrapAad(tenantId, 1))],
  );
  if (inserted.rowCount === 1) return { version: 1, dek };
  // Lost a race with another writer: use theirs.
  return getCurrentDataKey(client, kek);
}

export async function getDataKeyVersion(
  client: PoolClient,
  kek: Buffer,
  version: number,
): Promise<Buffer> {
  const tenantId = await currentTenantId(client);
  const { rows } = await client.query<{ wrapped: Buffer }>(
    `SELECT wrapped FROM tenant_secret WHERE name = $1 AND key_version = $2`,
    [SECRET_NAME, version],
  );
  const row = rows[0];
  if (!row) throw new Error(`No data key version ${version} for this tenant`);
  return unwrapKey(row.wrapped, kek, wrapAad(tenantId, version));
}
