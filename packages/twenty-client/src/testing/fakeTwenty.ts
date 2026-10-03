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
  /** People who can sign in through `POST /metadata`; their `role` decides what their token may see. */
  users?: readonly { email: string; password: string; role: 'staff' | 'care' }[];
  /** Surfaces that wrongly hand care requests to the `staff` role, to prove the privacy check can fail. */
  leaks?: Partial<
    Record<
      'restList' | 'restById' | 'restCreate' | 'personRelation' | 'graphql' | 'search' | 'timeline',
      boolean
    >
  >;
  /** A server whose global search does not exist. */
  noSearch?: boolean;
  /** A server that records no timeline entry for a new care request. */
  noTimeline?: boolean;
  /** A misconfigured care team role that cannot read care requests. */
  careCannotRead?: boolean;
  /**
   * The staff user's care-request probes are rejected as malformed (a validation 400 on REST, a validation error
   * on GraphQL) instead of refused, to prove such answers are never read as "denied".
   */
  rejectsProbesAsMalformed?: boolean;
  /** A login error that echoes the password back, to prove the harness scrubs it. */
  echoPasswordInLoginErrors?: boolean;
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

  /** Soft-deleted records, by plural. Kept apart so `rows()` stays "what Twenty still lists". */
  readonly trash = new Map<string, Record<string, unknown>[]>();

  /** The live records: what Twenty's lists and GET-by-id return. */
  rows(plural: string): Record<string, unknown>[] {
    let t = this.tables.get(plural);
    if (!t) this.tables.set(plural, (t = []));
    return t;
  }

  deleted(plural: string): Record<string, unknown>[] {
    let t = this.trash.get(plural);
    if (!t) this.trash.set(plural, (t = []));
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

  /** `staff` and `care` are signed-in users (see `users`); anything else is an API key with full access. */
  private roleOf(call: Call): 'staff' | 'care' | 'full' {
    const m = /^Bearer user:(staff|care):/.exec(call.authorization ?? '');
    return (m?.[1] as 'staff' | 'care' | undefined) ?? 'full';
  }

  private login(call: Call): Response {
    const { query = '', variables = {} } = (call.body ?? {}) as {
      query?: string;
      variables?: Record<string, string>;
    };
    if (query.includes('getLoginTokenFromCredentials')) {
      const user = this.quirks.users?.find(
        (u) => u.email === variables['email'] && u.password === variables['password'],
      );
      if (!user)
        return this.json({
          data: null,
          errors: [
            {
              message: this.quirks.echoPasswordInLoginErrors
                ? `Wrong password: ${variables['password']}`
                : 'Wrong password',
            },
          ],
        });
      return this.json({
        data: {
          getLoginTokenFromCredentials: {
            loginToken: { token: `login:${user.role}:${randomUUID()}` },
          },
        },
      });
    }
    if (query.includes('getAuthTokensFromLoginToken')) {
      const m = /^login:(staff|care):/.exec(variables['loginToken'] ?? '');
      if (!m) return this.json({ data: null, errors: [{ message: 'Invalid login token' }] });
      return this.json({
        data: {
          getAuthTokensFromLoginToken: {
            tokens: { accessOrWorkspaceAgnosticToken: { token: `user:${m[1]}:${randomUUID()}` } },
          },
        },
      });
    }
    return this.json({ data: null, errors: [{ message: 'unhandled' }] });
  }

  private graphql(call: Call): Response {
    const role = this.roleOf(call);
    const { query = '', variables = {} } = (call.body ?? {}) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const leaks = this.quirks.leaks ?? {};
    const denied = this.json({
      data: null,
      errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
    });
    const mayReadCare = (leak: boolean | undefined) =>
      role === 'full' ||
      (role === 'care' && !this.quirks.careCannotRead) ||
      (role === 'staff' && !!leak);
    if (query.includes('search(')) {
      if (this.quirks.noSearch)
        return this.json({ errors: [{ message: 'Cannot query field "search" on type "Query"' }] });
      // As seen on v2.43.0 (2026-10-01): a search is refused outright when it reaches an object the role may
      // not read. With no `includedObjectNameSingulars` that is every object, so both test roles are refused
      // and only a key with full access gets an answer; scoped to care requests, only the care team is served.
      const scope = Array.isArray(variables['objects'])
        ? (variables['objects'] as unknown[])
        : null;
      const searchesCare = scope === null || scope.includes('careRequest');
      const searchesPeople = scope === null || scope.includes('person');
      if (searchesCare && !mayReadCare(leaks.search)) return denied;
      if (scope === null && role === 'care') return denied;
      const q = (typeof variables['q'] === 'string' ? variables['q'] : '').toLowerCase();
      const hit = (name: unknown) => typeof name === 'string' && name.toLowerCase().includes(q);
      const nodes = [
        ...(searchesPeople
          ? this.rows('people')
              .filter((r) => hit(r['name']))
              .map((r) => ({ recordId: r['id'], objectNameSingular: 'person', label: 'person' }))
          : []),
        ...(searchesCare
          ? this.rows('careRequests')
              .filter((r) => hit(r['name']))
              .map((r) => ({
                recordId: r['id'],
                objectNameSingular: 'careRequest',
                label: r['name'],
              }))
          : []),
      ];
      return this.json({ data: { search: { edges: nodes.map((node) => ({ node })) } } });
    }
    if (query.includes('careRequests')) {
      if (!mayReadCare(leaks.graphql))
        return this.quirks.rejectsProbesAsMalformed
          ? this.json({
              errors: [
                {
                  message: 'Cannot query field "careRequests" on type "Query"',
                  extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
                },
              ],
            })
          : denied;
      const edges = this.rows('careRequests').map((r) => ({
        node: { id: r['id'], name: r['name'] },
      }));
      return this.json({ data: { careRequests: { edges } } });
    }
    return this.json({ errors: [{ message: 'unhandled query' }] });
  }

  /** Care-request permissions over REST: a response when this role may not do this, `undefined` when it may. */
  private guardCareRequests(call: Call): Response | undefined {
    const role = this.roleOf(call);
    if (role === 'full') return undefined;
    const care = /^\/rest\/careRequests(\/[0-9a-f-]{36})?$/.exec(call.path);
    if (!care) return undefined;
    // A v2.43.0 refusal, as seen on 2026-10-01: HTTP 400 carrying the code PERMISSION_DENIED (not a 403).
    const forbidden = this.quirks.rejectsProbesAsMalformed
      ? this.json({ statusCode: 400, messages: ["'filter' parameter invalid"] }, 400)
      : this.json({ statusCode: 400, code: 'PERMISSION_DENIED' }, 400);
    if (role === 'care') return this.quirks.careCannotRead ? forbidden : undefined;
    const leaks = this.quirks.leaks ?? {};
    if (call.method === 'GET')
      return (care[1] ? leaks.restById : leaks.restList) ? undefined : forbidden;
    if (call.method === 'POST') return leaks.restCreate ? undefined : forbidden;
    return forbidden;
  }

  private handle(call: Call): Response {
    if (call.path === '/healthz') return this.json({ status: 'ok' });
    if (call.path === '/metadata' && call.method === 'POST') return this.login(call);
    if (call.path === '/graphql' && call.method === 'POST') return this.graphql(call);
    const careGuard = this.guardCareRequests(call);
    if (careGuard) return careGuard;
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
      // A soft delete, like v2.43.0's REST DELETE: the record leaves lists and GET-by-id (404) and comes back
      // only when a filter names `deletedAt`. Whether Twenty also bumps `updatedAt` is unverified, so this
      // leaves it alone: the reconcile must not depend on it.
      const [gone] = rows.splice(i, 1);
      if (gone) this.deleted(del[1] as string).push({ ...gone, deletedAt: this.now() });
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
    if (one && call.method === 'GET') {
      const row = this.rows(one[1] as string).find((r) => r['id'] === one[2]);
      if (!row) return this.json({ error: 'not found' }, 404);
      const record: Record<string, unknown> = { ...row };
      const depth = call.query['depth'] ?? '0';
      // v2.43.0 expands relations one level and rejects anything deeper (seen 2026-10-01).
      if (depth !== '0' && depth !== '1')
        return this.json(
          {
            statusCode: 400,
            error: 'BadRequestException',
            messages: [`'depth=${depth}' parameter invalid. Allowed values are 0, 1`],
          },
          400,
        );
      if (one[1] === 'people' && depth === '1') {
        const role = this.roleOf(call);
        const mayReadCare =
          role === 'full' ||
          (role === 'care' && !this.quirks.careCannotRead) ||
          (role === 'staff' && !!this.quirks.leaks?.personRelation);
        if (mayReadCare)
          record['careRequests'] = this.rows('careRequests').filter(
            (r) => r['personId'] === row['id'],
          );
      }
      return this.json({ data: { record } });
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
      const filter = this.quirks.ignoreFilters ? '' : (call.query['filter'] ?? '');
      // Soft-deleted records are listed only when the filter names `deletedAt` (seen on v2.43.0).
      let rows = /\bdeletedAt\[/.test(filter)
        ? [...this.rows(many[1] as string), ...this.deleted(many[1] as string)]
        : [...this.rows(many[1] as string)];
      const ref = /^sourceRef\[eq\]:"(.*)"$/.exec(filter);
      if (ref) rows = rows.filter((r) => r['sourceRef'] === ref[1]);
      const eq = /^([A-Za-z]+)\[eq\]:"(.*)"$/.exec(filter);
      if (eq && eq[1] !== 'sourceRef')
        rows = rows.filter((r) => String(r[eq[1] as string]) === eq[2]);
      const all = /^and\((.*)\)$/.exec(filter);
      if (all)
        for (const part of (all[1] ?? '').split(',')) {
          const m = /^([A-Za-z]+)\[eq\]:"(.*)"$/.exec(part);
          if (!m)
            return this.json({ statusCode: 400, messages: ["'filter' parameter invalid"] }, 400);
          rows = rows.filter((r) => String(r[m[1] as string]) === m[2]);
        }
      // Timeline entries about care requests are hidden from staff, unless this server leaks them.
      if (
        many[1] === 'timelineActivities' &&
        this.roleOf(call) === 'staff' &&
        !this.quirks.leaks?.timeline
      )
        rows = rows.filter((r) => r['targetCareRequestId'] == null);
      const since = /^(updatedAt|deletedAt)\[gt\]:"(.*)"$/.exec(filter);
      const by = since?.[1] ?? 'updatedAt';
      // Timestamps are ISO strings here; anything else sorts first, like a null.
      const at = (r: Record<string, unknown>) => (typeof r[by] === 'string' ? r[by] : '');
      if (since) rows = rows.filter((r) => at(r) > (since[2] ?? ''));
      rows.sort((a, b) => at(a).localeCompare(at(b)));
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
    const row: Record<string, unknown> = {
      ...this.defaults(plural),
      ...data,
      id: randomUUID(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.rows(plural).push(row);
    // The shape v2.43.0 writes for "record created" (seen 2026-10-01): the record is the `target<Object>Id`;
    // `linkedRecordId` stays null, and the entry is not attached to the person the care request is about.
    if (plural === 'careRequests' && !this.quirks.noTimeline)
      this.rows('timelineActivities').push({
        id: randomUUID(),
        name: null,
        linkedRecordId: null,
        linkedRecordCachedName: '',
        targetCareRequestId: row.id,
        targetPersonId: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
    return row;
  }
}
