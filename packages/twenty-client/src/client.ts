// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_BUCKET, TokenBucket, type Priority } from './bucket.js';
import { TwentyAuthError, TwentyHttpError, TwentyNetworkError } from './errors.js';
import { chunk, paginate, type Page } from './paging.js';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from './retry.js';

export interface TwentyClientOptions {
  /** e.g. `https://first-church.example.org` (no path). */
  baseUrl: string;
  /** A scoped Twenty API key. Sent only as a bearer token and never included in errors or logs. */
  apiKey: string;
  fetch?: typeof fetch;
  bucket?: TokenBucket;
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  now?: () => number;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  priority?: Priority;
  /** Safe to repeat blindly. GET/PUT/PATCH/DELETE default to true; POST defaults to false. */
  idempotent?: boolean;
  /**
   * Retry inside this call. Defaults to `idempotent`. Composite operations (upsert) turn it off and own the
   * retry policy themselves, otherwise retries multiply: 4 inner × 4 outer = 16 requests during an outage.
   */
  retry?: boolean;
}

/** Source references are ours (`welcome:<id>`, `drift:<unit>:<week>`); keep them boring so they can never break out of a filter. */
const SOURCE_REF = /^[A-Za-z0-9:_.-]{1,200}$/;
const OBJECT_PLURAL = /^[a-z][A-Za-z0-9]{1,63}$/;
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TwentyRecord = Record<string, unknown> & { id: string };

/**
 * A small, defensive HTTP client for Twenty's REST API.
 *
 * Everything that depends on the SHAPE of Twenty's REST responses (paths, filter syntax, pagination
 * fields) is in the "REST adapter" section at the bottom and is UNVERIFIED against a live server; the
 * M0 harness (scripts/m0) exercises each call. The transport above it -- rate limiting, retries,
 * timeouts, error mapping -- does not depend on those shapes.
 */
export class TwentyClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket;
  private readonly retry: RetryOptions;
  private readonly timeoutMs: number;

  constructor(private readonly opts: TwentyClientOptions) {
    const base = new URL(opts.baseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:')
      throw new TypeError('baseUrl must be http(s)');
    if (base.pathname !== '/' || base.search || base.hash)
      throw new TypeError('baseUrl must be an origin without a path');
    if (!opts.apiKey) throw new TypeError('apiKey is required');
    this.base = base;
    this.fetchImpl = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    this.bucket = opts.bucket ?? new TokenBucket({ ...DEFAULT_BUCKET, now });
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retry = {
      ...DEFAULT_RETRY,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      ...opts.retry,
    };
  }

  // ---- transport ---------------------------------------------------------------------------

  async request<T = unknown>(
    method: string,
    path: string,
    o: RequestOptions = {},
  ): Promise<T | undefined> {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new TypeError('path must be absolute-path-relative, e.g. /rest/people');
    const idempotent = o.idempotent ?? method !== 'POST';
    const attemptOnce = () => this.once<T>(method, path, o);
    return (o.retry ?? idempotent) ? withRetry(() => attemptOnce(), this.retry) : attemptOnce();
  }

  private async once<T>(method: string, path: string, o: RequestOptions): Promise<T | undefined> {
    for (;;) {
      const wait = this.bucket.take(o.priority ?? 'interactive');
      if (wait === 0) break;
      await this.retry.sleep(wait);
    }
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(o.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    if (url.origin !== this.base.origin)
      throw new TypeError('request escaped the configured Twenty origin');

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          accept: 'application/json',
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new TwentyNetworkError(method, path, cause);
    }

    if (res.status === 401 || res.status === 403)
      throw new TwentyAuthError(res.status, method, path);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new TwentyHttpError(
        res.status,
        method,
        path,
        text.slice(0, 300),
        parseRetryAfter(res.headers.get('retry-after'), this.opts.now ?? Date.now),
      );
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  }

  // ---- REST adapter (shapes UNVERIFIED; see M0) ---------------------------------------------

  /** `GET /rest/<plural>?filter=sourceRef[eq]:"<ref>"&limit=1`. Null when nothing matches. */
  async findBySourceRef(
    plural: string,
    sourceRef: string,
    priority?: Priority,
    opts: { retry?: boolean } = {},
  ): Promise<TwentyRecord | null> {
    assertPlural(plural);
    if (!SOURCE_REF.test(sourceRef)) throw new TypeError('invalid sourceRef');
    const json = await this.request('GET', `/rest/${plural}`, {
      query: { filter: `sourceRef[eq]:"${sourceRef}"`, limit: 1 },
      priority,
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    });
    return unwrapRecords(json)[0] ?? null;
  }

  async createRecord(
    plural: string,
    data: Record<string, unknown>,
    priority?: Priority,
  ): Promise<TwentyRecord> {
    assertPlural(plural);
    const json = await this.request('POST', `/rest/${plural}`, {
      body: data,
      priority,
      idempotent: false,
    });
    const created = unwrapRecords(json)[0];
    if (!created) throw new Error(`Twenty returned no record from POST /rest/${plural}`);
    return created;
  }

  async updateRecord(
    plural: string,
    id: string,
    data: Record<string, unknown>,
    priority?: Priority,
  ): Promise<TwentyRecord> {
    assertPlural(plural);
    if (!RECORD_ID.test(id)) throw new TypeError('invalid record id');
    const json = await this.request('PATCH', `/rest/${plural}/${id}`, { body: data, priority });
    const updated = unwrapRecords(json)[0];
    if (!updated) throw new Error(`Twenty returned no record from PATCH /rest/${plural}/${id}`);
    return updated;
  }

  /** `DELETE /rest/<plural>/<id>` (Twenty soft-deletes). Safe to repeat. */
  async deleteRecord(plural: string, id: string, priority?: Priority): Promise<void> {
    assertPlural(plural);
    if (!RECORD_ID.test(id)) throw new TypeError('invalid record id');
    try {
      await this.request('DELETE', `/rest/${plural}/${id}`, { priority });
    } catch (error) {
      if (error instanceof TwentyHttpError && error.status === 404) return; // already gone
      throw error;
    }
  }

  /**
   * Creates a record exactly once for a given `sourceRef`, even when responses are lost.
   *
   * Every attempt starts by looking for the record, so if an earlier POST was applied but its response
   * never arrived (the classic duplicate-on-retry bug), the next attempt finds it instead of creating a
   * second one. `sourceRef` must be stored on the record by `data`.
   */
  async upsertBySourceRef(
    plural: string,
    sourceRef: string,
    data: Record<string, unknown>,
    priority?: Priority,
  ): Promise<{ record: TwentyRecord; created: boolean }> {
    return withRetry(async () => {
      const existing = await this.findBySourceRef(plural, sourceRef, priority, { retry: false });
      if (existing) return { record: existing, created: false };
      const record = await this.createRecord(plural, { ...data, sourceRef }, priority);
      return { record, created: true };
    }, this.retry);
  }

  /**
   * `POST /rest/batch/<plural>` in chunks of 60. NOT idempotent: pre-filter records that already exist
   * (e.g. imports keyed by sourceRef) before calling.
   */
  async batchCreate(
    plural: string,
    records: readonly Record<string, unknown>[],
    priority: Priority = 'background',
  ): Promise<TwentyRecord[]> {
    assertPlural(plural);
    const out: TwentyRecord[] = [];
    for (const group of chunk(records)) {
      const json = await this.request('POST', `/rest/batch/${plural}`, {
        body: group,
        priority,
        idempotent: false,
      });
      out.push(...unwrapRecords(json));
    }
    return out;
  }

  /** Pages of records with `updatedAt` after `sinceIso`, oldest first. Backs the hourly reconcile. */
  listUpdatedSince(
    plural: string,
    sinceIso: string,
    priority: Priority = 'background',
    pageSize = 60,
  ): AsyncGenerator<TwentyRecord[], void, void> {
    assertPlural(plural);
    if (Number.isNaN(Date.parse(sinceIso)))
      throw new TypeError('sinceIso must be an ISO timestamp');
    const since = new Date(sinceIso).toISOString();
    return paginate<TwentyRecord>(async (cursor): Promise<Page<TwentyRecord>> => {
      const json = await this.request('GET', `/rest/${plural}`, {
        query: {
          filter: `updatedAt[gt]:"${since}"`,
          order_by: 'updatedAt[AscNullsFirst]',
          limit: pageSize,
          starting_after: cursor ?? undefined,
        },
        priority,
      });
      return { items: unwrapRecords(json), nextCursor: nextCursorOf(json) };
    });
  }
}

function assertPlural(plural: string): void {
  if (!OBJECT_PLURAL.test(plural)) throw new TypeError(`invalid object name: ${plural}`);
}

function parseRetryAfter(header: string | null, now: () => number): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now());
}

/** Tolerant: accepts `{data: {people: [...]}}`, `{data: {createPerson: {...}}}` or `{data: [...]}`. */
export function unwrapRecords(json: unknown): TwentyRecord[] {
  const data = (json as { data?: unknown } | undefined)?.data;
  const asRecords = (v: unknown): TwentyRecord[] =>
    Array.isArray(v)
      ? (v as TwentyRecord[])
      : v && typeof v === 'object' && 'id' in v
        ? [v as TwentyRecord]
        : [];
  if (Array.isArray(data)) return asRecords(data);
  if (data && typeof data === 'object') {
    return Object.values(data).flatMap(asRecords);
  }
  return [];
}

function nextCursorOf(json: unknown): string | null {
  const info = (
    json as { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined
  )?.pageInfo;
  return info?.hasNextPage ? (info.endCursor ?? null) : null;
}
