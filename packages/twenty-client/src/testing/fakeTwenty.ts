// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

type Fault =
  | { kind: 'status'; status: number; headers?: Record<string, string>; body?: string }
  | { kind: 'drop-response' } // the server APPLIES the request, then the connection dies
  | { kind: 'network-error' }; // the request never reaches the server

/** A tiny in-memory stand-in for Twenty's REST API, with fault injection. Shapes mirror the docs research (UNVERIFIED live). */
export interface FakeQuirks {
  /** A server that ignores the filter parameter (so every sourceRef lookup "finds nothing" or everything). */
  ignoreFilters?: boolean;
  /** A server that stores SELECT defaults literally, quotes and all. */
  quotedDefaults?: boolean;
  /** An install where the app's Person fields are missing. */
  missingPersonFields?: boolean;
  /** An install missing a custom object. */
  missingObject?: string;
  /** Reject batches larger than this. */
  maxBatch?: number;
  /**
   * Models the service-account role: DELETE on `deletePlurals`, and the metadata API when `metadata` is true,
   * need the bearer token `adminKey`; any other key gets 403.
   */
  adminOnly?: { adminKey: string; deletePlurals?: readonly string[]; metadata?: boolean };
}

/** The objects/fields a correct install exposes; the M0 test passes the same lists to the harness. */
export const FAKE_MODEL = {
  objects: ['household', 'attendance', 'followUp', 'careRequest'],
  personFields: ['lifecycleStage', 'isMinor', 'doNotContact'],
};

export class FakeTwenty {
  readonly calls: Call[] = [];
  constructor(readonly quirks: FakeQuirks = {}) {}
  readonly tables = new Map<string, Record<string, unknown>[]>();
  private faults: Fault[] = [];
  private tick = 0;
  private readonly base = Date.now();

  /** Faults are consumed in order, one per request. */
  inject(...faults: Fault[]): this {
    this.faults.push(...faults);
    return this;
  }

  rows(plural: string): Record<string, unknown>[] {
    let t = this.tables.get(plural);
    if (!t) this.tables.set(plural, (t = []));
    return t;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: Call = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get('authorization'),
    };
    this.calls.push(call);

    const fault = this.faults.shift();
    if (fault?.kind === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (fault?.kind === 'status') {
      return Promise.resolve(
        new Response(fault.body ?? 'error', { status: fault.status, headers: fault.headers }),
      );
    }
    const response = this.handle(call);
    if (fault?.kind === 'drop-response') return Promise.reject(new TypeError('socket hang up'));
    return Promise.resolve(response);
  };

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private defaults(plural: string): Record<string, unknown> {
    const q = this.quirks.quotedDefaults;
    if (plural === 'followUps') return { status: q ? "'OPEN'" : 'OPEN' };
    if (plural === 'people')
      return { lifecycleStage: q ? "'NEW_GUEST'" : 'NEW_GUEST', doNotContact: false };
    return {};
  }

  private handle(call: Call): Response {
    if (call.path === '/healthz') return this.json({ status: 'ok' });
    if (call.path === '/rest/metadata/objects' && call.method === 'GET') {
      const restricted = this.quirks.adminOnly;
      if (restricted?.metadata && call.authorization !== `Bearer ${restricted.adminKey}`)
        return this.json({ error: 'authentication failed' }, 403);
      const objects = FAKE_MODEL.objects
        .filter((o) => o !== this.quirks.missingObject)
        .map((nameSingular) => ({ nameSingular, fields: [] as unknown[] }));
      const personFields = this.quirks.missingPersonFields
        ? []
        : FAKE_MODEL.personFields.map((name) => ({ name }));
      return this.json({
        data: { objects: [...objects, { nameSingular: 'person', fields: personFields }] },
      });
    }
    const del = /^\/rest\/([A-Za-z0-9]+)\/([0-9a-f-]{36})$/.exec(call.path);
    if (del && call.method === 'DELETE') {
      const restricted = this.quirks.adminOnly;
      if (
        restricted?.deletePlurals?.includes(del[1] as string) &&
        call.authorization !== `Bearer ${restricted.adminKey}`
      )
        return this.json({ error: 'forbidden' }, 403);
      const rows = this.rows(del[1] as string);
      const i = rows.findIndex((r) => r['id'] === del[2]);
      if (i === -1) return this.json({ error: 'not found' }, 404);
      rows.splice(i, 1);
      return this.json({ data: { deleteOne: { id: del[2] } } });
    }
    const batch = /^\/rest\/batch\/([A-Za-z0-9]+)$/.exec(call.path);
    const one = /^\/rest\/([A-Za-z0-9]+)\/([0-9a-f-]{36})$/.exec(call.path);
    const many = /^\/rest\/([A-Za-z0-9]+)$/.exec(call.path);

    if (batch && call.method === 'POST') {
      const list = call.body as Record<string, unknown>[];
      if (list.length > (this.quirks.maxBatch ?? 60))
        return this.json({ error: 'batch too large' }, 400);
      const created = list.map((r) => this.insert(batch[1] as string, r));
      return this.json({ data: { [`create${batch[1]}`]: created } }, 201);
    }
    if (one && call.method === 'PATCH') {
      const row = this.rows(one[1] as string).find((r) => r['id'] === one[2]);
      if (!row) return this.json({ error: 'not found' }, 404);
      Object.assign(row, call.body, { updatedAt: this.now() });
      return this.json({ data: { updateOne: row } });
    }
    if (many && call.method === 'POST') {
      return this.json(
        {
          data: { createOne: this.insert(many[1] as string, call.body as Record<string, unknown>) },
        },
        201,
      );
    }
    if (many && call.method === 'GET') {
      let rows = [...this.rows(many[1] as string)];
      const filter = this.quirks.ignoreFilters ? '' : (call.query['filter'] ?? '');
      const ref = /^sourceRef\[eq\]:"(.*)"$/.exec(filter);
      if (ref) rows = rows.filter((r) => r['sourceRef'] === ref[1]);
      const since = /^updatedAt\[gt\]:"(.*)"$/.exec(filter);
      if (since) rows = rows.filter((r) => String(r['updatedAt']) > String(since[1]));
      rows.sort((a, b) => String(a['updatedAt']).localeCompare(String(b['updatedAt'])));
      const limit = Number(call.query['limit'] ?? 60);
      const start = call.query['starting_after']
        ? rows.findIndex((r) => r['id'] === call.query['starting_after']) + 1
        : 0;
      const page = rows.slice(start, start + limit);
      const more = start + limit < rows.length;
      return this.json({
        data: { [many[1] as string]: page },
        pageInfo: { hasNextPage: more, endCursor: page.at(-1)?.['id'] ?? null },
        totalCount: rows.length,
      });
    }
    return this.json({ error: 'unhandled' }, 404);
  }

  private now(): string {
    // Anchored to the real clock (like a real server) but strictly increasing, so ordering by updatedAt is stable.
    return new Date(this.base + ++this.tick).toISOString();
  }

  private insert(plural: string, data: Record<string, unknown>): Record<string, unknown> {
    const row = {
      ...this.defaults(plural),
      ...data,
      id: randomUUID(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.rows(plural).push(row);
    return row;
  }
}
