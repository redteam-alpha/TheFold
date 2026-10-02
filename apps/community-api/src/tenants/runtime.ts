// SPDX-License-Identifier: AGPL-3.0-or-later
import { TwentyClient } from '@thefold/twenty-client';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import { RestTwentyGateway, type TwentyGateway } from '../twenty/gateway.js';
import { readTenantSecretVersion } from './secrets.js';

export interface TenantInfo {
  id: string;
  slug: string;
  subdomain: string;
  timezone: string;
  twentyBaseUrl: string;
}

/** The current tenant's row (row-level security shows exactly one). Must run inside `withTenant`. */
export async function loadTenantInfo(client: PoolClient): Promise<TenantInfo> {
  const { rows } = await client.query<{
    id: string;
    slug: string;
    subdomain: string;
    timezone: string;
    twenty_base_url: string;
  }>('SELECT id, slug, subdomain, timezone, twenty_base_url FROM tenant');
  const r = rows[0];
  if (!r) throw new Error('No tenant context: run inside withTenant');
  return {
    id: r.id,
    slug: r.slug,
    subdomain: r.subdomain,
    timezone: r.timezone,
    twentyBaseUrl: r.twenty_base_url,
  };
}

/** The church exists but has no Twenty API key yet: its jobs wait (they are not failed or dropped). */
export class TenantNotConfiguredError extends Error {
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} has no Twenty API key; run setup with FOLD_TWENTY_API_KEY`);
    this.name = 'TenantNotConfiguredError';
  }
}

export type TwentyClientFactory = (opts: { baseUrl: string; apiKey: string }) => TwentyClient;

interface Cached {
  client: TwentyClient;
  baseUrl: string;
  keyVersion: number;
  checkedAt: number;
}

/**
 * One TwentyClient per church, reused across worker ticks so its rate-limit bucket carries over (a fresh
 * client per tick would forget how much of Twenty's budget it just spent). The key and base URL are re-read
 * every `ttlMs`, so a rotated key or a moved Twenty is picked up without a restart.
 */
export class TwentyConnections {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly pool: Pool,
    private readonly kek: Buffer,
    private readonly factory: TwentyClientFactory = (o) => new TwentyClient(o),
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async clientFor(tenantId: string): Promise<TwentyClient> {
    const hit = this.cache.get(tenantId);
    if (hit && this.now() - hit.checkedAt < this.ttlMs) return hit.client;

    const { info, key } = await withTenant(this.pool, tenantId, async (c) => ({
      info: await loadTenantInfo(c),
      key: await readTenantSecretVersion(c, this.kek, 'twenty_api_key'),
    }));
    if (!key) throw new TenantNotConfiguredError(tenantId);
    if (hit && hit.baseUrl === info.twentyBaseUrl && hit.keyVersion === key.version) {
      hit.checkedAt = this.now();
      return hit.client;
    }
    const client = this.factory({ baseUrl: info.twentyBaseUrl, apiKey: key.value });
    this.cache.set(tenantId, {
      client,
      baseUrl: info.twentyBaseUrl,
      keyVersion: key.version,
      checkedAt: this.now(),
    });
    return client;
  }

  async gatewayFor(tenantId: string): Promise<TwentyGateway> {
    return new RestTwentyGateway(await this.clientFor(tenantId));
  }
}
