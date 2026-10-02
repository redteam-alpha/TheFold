// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  collect,
  TokenBucket,
  TwentyAuthError,
  TwentyClient,
  TwentyHttpError,
  TwentyNetworkError,
  unwrapRecords,
} from '../src/index.js';
import { FakeTwenty } from '../src/testing/fakeTwenty.js';

const API_KEY = 'sk_live_super_secret_key';

function setup(
  over: {
    bucket?: { capacity: number; refillPerSecond: number; backgroundReserve: number };
    timeoutMs?: number;
  } = {},
) {
  const server = new FakeTwenty();
  const clock = { t: Date.parse('2026-09-30T12:00:00Z') };
  const slept: number[] = [];
  const sleep = (ms: number) => {
    slept.push(ms);
    clock.t += ms;
    return Promise.resolve();
  };
  const bucket = new TokenBucket({
    capacity: 1000,
    refillPerSecond: 1000,
    backgroundReserve: 0,
    ...over.bucket,
    now: () => clock.t,
  });
  const client = new TwentyClient({
    baseUrl: 'https://first-church.example.org',
    apiKey: API_KEY,
    fetch: server.fetch,
    bucket,
    retry: { sleep, random: () => 0.5, maxAttempts: 4, baseMs: 100, capMs: 1000 },
    now: () => clock.t,
    ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
  });
  return { server, client, slept, clock };
}

describe('TwentyClient construction and request safety', () => {
  const ok = { apiKey: 'k', fetch: new FakeTwenty().fetch };
  it('accepts only an http(s) origin with no path', () => {
    expect(() => new TwentyClient({ ...ok, baseUrl: 'https://a.example.org' })).not.toThrow();
    for (const bad of [
      'ftp://a.example.org',
      'https://a.example.org/twenty',
      'https://a.example.org/?x=1',
      'not a url',
    ]) {
      expect(() => new TwentyClient({ ...ok, baseUrl: bad }), bad).toThrow();
    }
    expect(() => new TwentyClient({ ...ok, apiKey: '', baseUrl: 'https://a.example.org' })).toThrow(
      /apiKey/,
    );
  });

  it('cannot be steered to another host through the path', async () => {
    const { client, server } = setup();
    for (const path of ['//evil.example.com/x', 'https://evil.example.com/x', 'rest/people']) {
      await expect(client.request('GET', path), path).rejects.toThrow(TypeError);
    }
    expect(server.calls).toHaveLength(0);
  });

  it('rejects object names and record ids that could alter the URL', async () => {
    const { client, server } = setup();
    await expect(client.findBySourceRef('people/../admin', 'ok')).rejects.toThrow(
      /invalid object name/,
    );
    await expect(client.updateRecord('people', '../x', {})).rejects.toThrow(/invalid record id/);
    expect(server.calls).toHaveLength(0);
  });

  it('rejects source references that could break out of a filter', async () => {
    const { client, server } = setup();
    for (const ref of ['a"]:"b', 'a b', '', 'x'.repeat(201), 'a[eq]']) {
      await expect(client.findBySourceRef('people', ref), ref).rejects.toThrow(/invalid sourceRef/);
    }
    expect(server.calls).toHaveLength(0);
  });
});

describe('transport behaviour', () => {
  it('sends the API key as a bearer token and JSON bodies with a content type', async () => {
    const { client, server } = setup();
    await client.createRecord('followUps', { name: 'x' });
    expect(server.calls[0]).toMatchObject({
      method: 'POST',
      path: '/rest/followUps',
      authorization: `Bearer ${API_KEY}`,
      body: { name: 'x' },
    });
  });

  it('never leaks the API key into errors', async () => {
    const { client, server } = setup();
    server.inject({ kind: 'status', status: 400, body: 'bad request' });
    const httpErr = await client.createRecord('followUps', {}).catch((e: unknown) => e);
    expect(httpErr).toBeInstanceOf(TwentyHttpError);
    server.inject({ kind: 'network-error' });
    const netErr = await client.createRecord('followUps', {}).catch((e: unknown) => e);
    expect(netErr).toBeInstanceOf(TwentyNetworkError);
    for (const e of [httpErr, netErr] as Error[]) {
      expect(String(e.message)).not.toContain(API_KEY);
      expect(JSON.stringify(e)).not.toContain(API_KEY);
    }
  });

  it('does not retry an authentication failure', async () => {
    const { client, server, slept } = setup();
    server.inject({ kind: 'status', status: 401 });
    await expect(client.findBySourceRef('people', 'x')).rejects.toBeInstanceOf(TwentyAuthError);
    expect(server.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('retries a GET after 429, waiting at least as long as Retry-After says', async () => {
    const { client, server, slept } = setup();
    server.inject({ kind: 'status', status: 429, headers: { 'retry-after': '2' } });
    await expect(client.findBySourceRef('people', 'x')).resolves.toBeNull();
    expect(server.calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  it('understands an HTTP-date Retry-After', async () => {
    const { client, server, slept, clock } = setup();
    server.inject({
      kind: 'status',
      status: 503,
      headers: { 'retry-after': new Date(clock.t + 5000).toUTCString() },
    });
    await client.findBySourceRef('people', 'x');
    expect(slept[0]).toBeGreaterThanOrEqual(4000);
    expect(slept[0]).toBeLessThanOrEqual(5000);
  });

  it('never blindly retries a POST: a lost response could mean the write was applied', async () => {
    const { client, server } = setup();
    server.inject({ kind: 'network-error' });
    await expect(client.createRecord('followUps', { name: 'x' })).rejects.toBeInstanceOf(
      TwentyNetworkError,
    );
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('times out a hung request instead of waiting forever', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new TwentyClient({
      baseUrl: 'https://a.example.org',
      apiKey: 'k',
      fetch: hang,
      timeoutMs: 20,
      retry: { sleep: () => Promise.resolve() },
    });
    await expect(client.createRecord('followUps', {})).rejects.toBeInstanceOf(TwentyNetworkError);
  });

  it('waits for the rate limiter rather than failing, and never exceeds the allowed rate', async () => {
    const { client, server, slept, clock } = setup({
      bucket: { capacity: 3, refillPerSecond: 1, backgroundReserve: 0 },
    });
    const start = clock.t;
    for (let i = 0; i < 10; i++) await client.findBySourceRef('people', `ref${i}`);
    expect(server.calls).toHaveLength(10);
    expect(slept.length).toBeGreaterThan(0);
    const elapsedSeconds = (clock.t - start) / 1000;
    expect(10).toBeLessThanOrEqual(3 + elapsedSeconds + 1e-6); // capacity + rate × time
  });
});

describe('upsertBySourceRef (idempotent creates)', () => {
  it('creates once and then finds the existing record', async () => {
    const { client, server } = setup();
    const first = await client.upsertBySourceRef('followUps', 'welcome:abc', {
      name: 'Welcome Sam',
    });
    const second = await client.upsertBySourceRef('followUps', 'welcome:abc', {
      name: 'Welcome Sam',
    });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, record: { id: first.record.id } });
    expect(server.rows('followUps')).toHaveLength(1);
    expect(server.rows('followUps')[0]).toMatchObject({
      name: 'Welcome Sam',
      sourceRef: 'welcome:abc',
    });
  });

  it('does not create a duplicate when the server applied the write but the response was lost', async () => {
    const { client, server } = setup();
    // Call 1: find (empty). Call 2: create -> the server applies it, then the connection drops.
    server.inject(
      { kind: 'status', status: 200, body: '{"data":{"followUps":[]}}' },
      { kind: 'drop-response' },
    );
    const result = await client.upsertBySourceRef('followUps', 'welcome:lost', { name: 'x' });
    expect(server.rows('followUps')).toHaveLength(1); // applied exactly once
    expect(result.created).toBe(false); // the retry found it
    expect(server.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('survives a transient failure while looking for the record', async () => {
    const { client, server } = setup();
    server.inject({ kind: 'status', status: 503 });
    await expect(
      client.upsertBySourceRef('followUps', 'welcome:x', { name: 'x' }),
    ).resolves.toMatchObject({ created: true });
    expect(server.rows('followUps')).toHaveLength(1);
  });

  it('gives up cleanly after repeated failures without creating anything', async () => {
    const { client, server } = setup();
    server.inject(...Array.from({ length: 4 }, () => ({ kind: 'status', status: 503 }) as const));
    await expect(
      client.upsertBySourceRef('followUps', 'welcome:y', { name: 'x' }),
    ).rejects.toBeInstanceOf(TwentyHttpError);
    expect(server.rows('followUps')).toHaveLength(0);
    // Exactly maxAttempts (4) requests: retries do not multiply across nested layers.
    expect(server.calls).toHaveLength(4);
  });
});

describe('batching and reconcile paging', () => {
  it('splits big batches into requests of at most 60 and uses background priority', async () => {
    const { client, server } = setup();
    const records = Array.from({ length: 130 }, (_, i) => ({ name: `r${i}` }));
    const created = await client.batchCreate('attendances', records);
    expect(created).toHaveLength(130);
    const posts = server.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => (c.body as unknown[]).length)).toEqual([60, 60, 10]);
    expect(posts.every((c) => c.path === '/rest/batch/attendances')).toBe(true);
  });

  it('pages through records updated since a timestamp, oldest first', async () => {
    const { client, server } = setup();
    await client.batchCreate(
      'people',
      Array.from({ length: 150 }, (_, i) => ({ name: `p${i}` })),
    );
    const pages: number[] = [];
    const seen: string[] = [];
    for await (const page of client.listUpdatedSince('people', '2020-01-01T00:00:00Z')) {
      pages.push(page.length);
      seen.push(...page.map((r) => String(r.id)));
    }
    expect(pages).toEqual([60, 60, 30]);
    expect(new Set(seen).size).toBe(150);
    const gets = server.calls.filter((c) => c.method === 'GET');
    expect(gets[0]?.query['starting_after']).toBeUndefined();
    expect(gets[1]?.query['starting_after']).toBeDefined();
    expect(gets[0]?.query['filter']).toBe('updatedAt[gt]:"2020-01-01T00:00:00.000Z"');
  });

  it('collects nothing when nothing changed', async () => {
    const { client } = setup();
    expect(await collect(client.listUpdatedSince('people', '2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('rejects a nonsense timestamp before making a request', () => {
    const { client, server } = setup();
    expect(() => client.listUpdatedSince('people', 'yesterday')).toThrow(TypeError);
    expect(server.calls).toHaveLength(0);
  });

  it('updates a record by id', async () => {
    const { client } = setup();
    const created = await client.createRecord('people', { name: 'a' });
    const updated = await client.updateRecord('people', created.id, { name: 'b' });
    expect(updated).toMatchObject({ id: created.id, name: 'b' });
  });

  it('reads one record by id, and answers null (not an error) once it is gone', async () => {
    const { client } = setup();
    const created = await client.createRecord('people', { name: 'a' });
    expect(await client.getRecord('people', created.id)).toMatchObject({
      id: created.id,
      name: 'a',
    });
    await client.deleteRecord('people', created.id);
    expect(await client.getRecord('people', created.id)).toBeNull();
    await expect(client.getRecord('people', 'not-an-id')).rejects.toThrow(TypeError);
  });

  it('pages by hand from a saved cursor, the way a resumed reconcile does', async () => {
    const { client } = setup();
    await client.batchCreate(
      'people',
      Array.from({ length: 5 }, (_, i) => ({ name: `p${i}` })),
    );
    const since = '2020-01-01T00:00:00Z';
    const first = await client.listUpdatedSincePage('people', since, { pageSize: 2 });
    expect(first.items.map((r) => r['name'])).toEqual(['p0', 'p1']);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.listUpdatedSincePage('people', since, {
      pageSize: 2,
      after: first.nextCursor,
    });
    expect(second.items.map((r) => r['name'])).toEqual(['p2', 'p3']);
    const last = await client.listUpdatedSincePage('people', since, {
      pageSize: 2,
      after: second.nextCursor,
    });
    expect(last.items.map((r) => r['name'])).toEqual(['p4']);
    expect(last.nextCursor).toBeNull();
  });
});

describe('unwrapRecords', () => {
  it('accepts the response shapes Twenty is reported to use', () => {
    const rec = { id: '1', a: 1 };
    expect(unwrapRecords({ data: { people: [rec, rec] } })).toHaveLength(2);
    expect(unwrapRecords({ data: { createPerson: rec } })).toEqual([rec]);
    expect(unwrapRecords({ data: [rec] })).toEqual([rec]);
    expect(unwrapRecords({ data: {} })).toEqual([]);
    expect(unwrapRecords(undefined)).toEqual([]);
    expect(unwrapRecords({ error: 'x' })).toEqual([]);
  });
});
