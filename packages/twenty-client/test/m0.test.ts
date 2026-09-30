// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MANUAL_CHECKS,
  readMetadata,
  renderReport,
  runM0,
  TokenBucket,
  TwentyClient,
  type CheckResult,
  escapeTableCell,
} from '../src/index.js';
import { FAKE_MODEL, FakeTwenty, type FakeQuirks } from '../src/testing/fakeTwenty.js';

async function run(quirks: FakeQuirks = {}, env: Record<string, string | undefined> = {}) {
  const server = new FakeTwenty(quirks);
  const bucket = new TokenBucket({
    capacity: 10_000,
    refillPerSecond: 10_000,
    backgroundReserve: 0,
    now: Date.now,
  });
  const client = new TwentyClient({
    baseUrl: 'https://twenty.test',
    apiKey: 'k',
    fetch: server.fetch,
    bucket,
    retry: { sleep: () => Promise.resolve(), random: () => 0 },
  });
  const results = await runM0({
    client,
    baseUrl: 'https://twenty.test',
    apiKey: 'k',
    fetch: server.fetch,
    model: FAKE_MODEL,
    env,
    runId: 'test1234',
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r])) as Record<string, CheckResult>;
  return { server, results, byId };
}

describe('M0 harness', () => {
  it('passes every automated check against a Twenty that behaves as assumed, and cleans up after itself', async () => {
    const { byId, server } = await run();
    for (const id of [
      'health',
      'auth-and-rest',
      'app-installed',
      'sourceref-idempotent',
      'select-defaults',
      'person-shapes',
      'batch-limit-and-paging',
    ]) {
      expect(byId[id], id).toMatchObject({ status: 'PASS' });
    }
    expect(byId['batch-61']?.status).toBe('INFO');
    expect(byId['rate-limit']?.status).toBe('SKIP');
    expect(byId['webhook-signature']?.status).toBe('SKIP');
    for (const plural of ['followUps', 'people', 'attendances'])
      expect(server.rows(plural), `left over in ${plural}`).toEqual([]);
  });

  it('always lists the manual checks with concrete steps', async () => {
    const { results } = await run();
    const manual = results.filter((r) => r.status === 'MANUAL');
    expect(manual.map((m) => m.id)).toEqual(MANUAL_CHECKS.map((m) => m.id));
    for (const m of manual) expect(m.detail.length, m.id).toBeGreaterThan(60);
    expect(manual.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        'care-permissions',
        'workflow-bypass',
        'multi-workspace',
        'no-enterprise-key',
      ]),
    );
  });

  describe('it can actually fail (a harness that cannot fail proves nothing)', () => {
    it('detects a server that ignores the sourceRef filter: retries would duplicate records', async () => {
      const { byId } = await run({ ignoreFilters: true });
      expect(byId['sourceref-idempotent']?.status).toBe('FAIL');
      expect(byId['sourceref-idempotent']?.detail).toMatch(/filter/i);
    });

    it('detects SELECT defaults stored with their quotes', async () => {
      const { byId } = await run({ quotedDefaults: true });
      expect(byId['select-defaults']?.status).toBe('FAIL');
      expect(byId['select-defaults']?.detail).toMatch(/quotes|"OPEN"/);
    });

    it('detects a server that drops relation ids or composite fields on Person', async () => {
      const server = new FakeTwenty();
      const strip: typeof fetch = (input, init) => {
        if (
          typeof init?.body === 'string' &&
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes('/rest/people')
        ) {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          delete body['householdId'];
          delete body['guardianId'];
          return server.fetch(input, { ...init, body: JSON.stringify(body) });
        }
        return server.fetch(input, init);
      };
      const bucket = new TokenBucket({
        capacity: 10_000,
        refillPerSecond: 10_000,
        backgroundReserve: 0,
        now: Date.now,
      });
      const client = new TwentyClient({
        baseUrl: 'https://twenty.test',
        apiKey: 'k',
        fetch: strip,
        bucket,
        retry: { sleep: () => Promise.resolve(), random: () => 0 },
      });
      const results = await runM0({
        client,
        baseUrl: 'https://twenty.test',
        apiKey: 'k',
        fetch: strip,
        model: FAKE_MODEL,
        env: {},
        runId: 'strip',
      });
      const shapes = results.find((r) => r.id === 'person-shapes');
      expect(shapes?.status).toBe('FAIL');
      expect(shapes?.detail).toMatch(/householdId|guardianId/);
    });

    it('detects an install where Person’s extension fields are missing', async () => {
      const { byId } = await run({ missingPersonFields: true });
      expect(byId['app-installed']?.status).toBe('FAIL');
    });

    it('detects a missing custom object and names it', async () => {
      const { byId } = await run({ missingObject: 'careRequest' });
      expect(byId['app-installed']?.status).toBe('FAIL');
      expect(byId['app-installed']?.detail).toContain('careRequest');
    });

    it('reports a server that rejects batches over its limit as information, not failure', async () => {
      const { byId } = await run({ maxBatch: 60 });
      expect(byId['batch-61']?.status).toBe('INFO');
      expect(byId['batch-61']?.detail).toMatch(/rejected/);
    });

    it('a check that throws becomes a FAIL with the reason, and the run continues', async () => {
      const server = new FakeTwenty();
      const bad: typeof fetch = () => Promise.reject(new TypeError('connection refused'));
      const client = new TwentyClient({
        baseUrl: 'https://twenty.test',
        apiKey: 'k',
        fetch: bad,
        retry: { sleep: () => Promise.resolve(), maxAttempts: 1 },
      });
      const results = await runM0({
        client,
        baseUrl: 'https://twenty.test',
        apiKey: 'k',
        fetch: bad,
        model: FAKE_MODEL,
        env: {},
        runId: 'x',
      });
      expect(results.filter((r) => r.status === 'FAIL').length).toBeGreaterThan(3);
      expect(results.find((r) => r.id === 'health')?.detail).toMatch(/connection refused/);
      expect(results.filter((r) => r.status === 'MANUAL').length).toBe(MANUAL_CHECKS.length);
      expect(server.calls).toHaveLength(0);
    });
  });

  it('reads object and field names out of differently shaped metadata responses', () => {
    const shapeA = {
      data: {
        objects: [
          { nameSingular: 'person', fields: [{ name: 'a' }, { name: 'b' }] },
          { nameSingular: 'x' },
        ],
      },
    };
    const shapeB = {
      data: { objects: { edges: [{ node: { nameSingular: 'person', fields: [{ name: 'c' }] } }] } },
    };
    expect([...readMetadata(shapeA).personFields]).toEqual(['a', 'b']);
    expect([...readMetadata(shapeA).objects].sort()).toEqual(['person', 'x']);
    expect([...readMetadata(shapeB).personFields]).toEqual(['c']);
    expect(readMetadata(undefined).objects.size).toBe(0);
  });

  it('renders a report that can be pasted into the ledger', async () => {
    const { results } = await run();
    const md = renderReport(results, {
      date: '2026-09-30',
      twentyVersion: 'v2.43.0',
      baseUrl: 'https://twenty.test',
    });
    expect(md).toContain('### M0 run — 2026-09-30 — Twenty v2.43.0');
    expect(md).toMatch(/\| PASS \| `health`/);
    expect(md).toMatch(/\| MANUAL \| `care-permissions`/);
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBe(results.length + 2);
  });
});

describe('escapeTableCell (CodeQL alert: incomplete string escaping)', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a|b', 'a\\|b'],
    ['a\\b', 'a\\\\b'],
    // The case CodeQL flagged: a backslash before a pipe. Escaping only the pipe would give `\\|`, where the
    // first backslash escapes the second and the pipe is live again.
    ['a\\|b', 'a\\\\\\|b'],
    ['a\\\\|b', 'a\\\\\\\\\\|b'],
    ['line one\nline two', 'line one line two'],
    ['line one\r\nline two', 'line one line two'],
    ['line one\rline two', 'line one line two'],
  ])('%j', (input, expected) => {
    expect(escapeTableCell(input)).toBe(expected);
  });

  /** What a markdown renderer does to a cell: `\\` and `\|` lose their backslash. */
  const unescape = (cell: string) => cell.replace(/\\([\\|])/g, '$1');

  it('property: every pipe is escaped, no newline survives, and unescaping restores the original text', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', ' ', '|', '\\', '\n', '\r', '`', 'x') }),
        (text) => {
          const cell = escapeTableCell(text);
          expect(cell).not.toMatch(/[\r\n]/);
          for (const m of cell.matchAll(/\|/g)) {
            const before = cell.slice(0, m.index).match(/\\*$/)?.[0].length ?? 0;
            expect(before % 2, `pipe at ${m.index} in ${JSON.stringify(cell)}`).toBe(1);
          }
          expect(unescape(cell)).toBe(text.replace(/\r\n|\r|\n/g, ' '));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a hostile detail cannot add a column to the report', async () => {
    const { results } = await run();
    const hostile = results.map((r) => ({
      ...r,
      detail: 'evil \\| extra | cells \\\\| more\nnew row',
    }));
    const md = renderReport(hostile, {
      date: '2026-09-30',
      twentyVersion: 'v2.43.0',
      baseUrl: 'https://twenty.test',
    });
    for (const line of md
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Status') && !l.startsWith('|---'))) {
      // Count only unescaped pipes: a row is exactly 4 cells wide (5 separators).
      const separators = [...line.matchAll(/\|/g)].filter(
        (m) => (line.slice(0, m.index).match(/\\*$/)?.[0].length ?? 0) % 2 === 0,
      );
      expect(separators, line).toHaveLength(5);
    }
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBe(hostile.length + 2);
  });
});
