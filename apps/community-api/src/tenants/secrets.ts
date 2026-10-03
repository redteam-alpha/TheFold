// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PoolClient } from 'pg';
import { decryptText, encryptText } from '../crypto/envelope.js';

/**
 * Per-church credentials for Twenty, stored in `tenant_secret` only as ciphertext wrapped by the KEK (which
 * lives outside the database), exactly like the data keys in tenantKeys.ts. A database dump alone reveals
 * no church's API key.
 *
 * Rotation is "store a new version": readers always take the latest; older versions stay until removed by a
 * privileged job, so a rotation never has a window in which no key is readable.
 */
export const TENANT_SECRETS = ['twenty_api_key', 'twenty_webhook_secret'] as const;
export type TenantSecretName = (typeof TENANT_SECRETS)[number];

const aad = (tenantId: string, name: TenantSecretName, version: number) =>
  `${tenantId}|tenant_secret|${name}|${version}`;

async function tenantIdOf(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>('SELECT fold_current_tenant() AS id');
  const id = rows[0]?.id;
  if (!id) throw new Error('No tenant context: run inside withTenant');
  return id;
}

/** Stores `value` as the next version of `name`. Must run in a tenant context; returns the new version. */
export async function storeTenantSecret(
  client: PoolClient,
  kek: Buffer,
  name: TenantSecretName,
  value: string,
): Promise<number> {
  if (!value) throw new TypeError(`${name} must not be empty`);
  const tenantId = await tenantIdOf(client);
  const latest = await readTenantSecretVersion(client, kek, name);
  if (latest && latest.value === value) return latest.version; // unchanged: re-running setup is a no-op
  const version = (latest?.version ?? 0) + 1;
  await client.query(
    `INSERT INTO tenant_secret (tenant_id, name, key_version, wrapped) VALUES (fold_current_tenant(), $1, $2, $3)`,
    [name, version, encryptText(kek, value, aad(tenantId, name, version))],
  );
  return version;
}

/** The latest version of `name`, or null if it was never stored. */
export async function readTenantSecretVersion(
  client: PoolClient,
  kek: Buffer,
  name: TenantSecretName,
): Promise<{ value: string; version: number } | null> {
  const tenantId = await tenantIdOf(client);
  const { rows } = await client.query<{ key_version: number; wrapped: Buffer }>(
    `SELECT key_version, wrapped FROM tenant_secret WHERE name = $1 ORDER BY key_version DESC LIMIT 1`,
    [name],
  );
  const row = rows[0];
  if (!row) return null;
  const value = decryptText(kek, row.wrapped, aad(tenantId, name, row.key_version));
  return { value, version: row.key_version };
}

export async function readTenantSecret(
  client: PoolClient,
  kek: Buffer,
  name: TenantSecretName,
): Promise<string | null> {
  return (await readTenantSecretVersion(client, kek, name))?.value ?? null;
}
