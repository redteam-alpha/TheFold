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
export class FakeTwenty {
  readonly calls: Call[] = [];
  readonly tables = new Map<string, Record<string, unknown>[]>();
  private faults: Fault[] = [];
  private tick = 0;

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

  private handle(call: Call): Response {
    const batch = /^\/rest\/batch\/([A-Za-z0-9]+)$/.exec(call.path);
    const one = /^\/rest\/([A-Za-z0-9]+)\/([0-9a-f-]{36})$/.exec(call.path);
    const many = /^\/rest\/([A-Za-z0-9]+)$/.exec(call.path);

    if (batch && call.method === 'POST') {
      const list = call.body as Record<string, unknown>[];
      if (list.length > 60) return this.json({ error: 'batch too large' }, 400);
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
      const filter = call.query['filter'] ?? '';
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
    return new Date(Date.UTC(2026, 8, 1) + ++this.tick * 1000).toISOString();
  }

  private insert(plural: string, data: Record<string, unknown>): Record<string, unknown> {
    const row = { ...data, id: randomUUID(), createdAt: this.now(), updatedAt: this.now() };
    this.rows(plural).push(row);
    return row;
  }
}
