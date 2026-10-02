// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chunk,
  collect,
  isRetryable,
  MAX_BATCH,
  paginate,
  signWebhook,
  TokenBucket,
  TwentyAuthError,
  TwentyHttpError,
  TwentyNetworkError,
  verifyWebhook,
  withRetry,
  type RetryOptions,
} from '../src/index.js';

describe('TokenBucket', () => {
  const make = (over: Partial<ConstructorParameters<typeof TokenBucket>[0]> = {}) => {
    const clock = { t: 0 };
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerSecond: 2,
      backgroundReserve: 4,
      now: () => clock.t,
      ...over,
    });
    return { clock, bucket };
  };

  it('allows a burst up to capacity, then tells you how long to wait', () => {
    const { bucket } = make();
    for (let i = 0; i < 10; i++) expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(500); // 1 token at 2/s
  });

  it('refills over time but never above capacity', () => {
    const { bucket, clock } = make();
    for (let i = 0; i < 10; i++) bucket.take();
    clock.t += 1000;
    expect(bucket.available).toBeCloseTo(2);
    clock.t += 60_000;
    expect(bucket.available).toBe(10);
  });

  it('keeps a reserve so background bulk work can never starve an interactive request', () => {
    const { bucket } = make();
    let backgroundTaken = 0;
    while (bucket.take('background') === 0) backgroundTaken++;
    expect(backgroundTaken).toBe(6); // 10 capacity - 4 reserve
    expect(bucket.take('interactive')).toBe(0); // the reserve is still there for a person clicking Save
    expect(bucket.available).toBeCloseTo(3);
  });

  it('tells background work to wait until the reserve is respected again', () => {
    const { bucket } = make();
    while (bucket.take('background') === 0);
    const wait = bucket.take('background');
    expect(wait).toBeGreaterThan(0);
  });

  it('property: never grants more than capacity + rate × elapsed time', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 3000 }),
            fc.constantFrom('interactive', 'background' as const),
          ),
          { maxLength: 200 },
        ),
        (steps) => {
          const { bucket, clock } = make();
          let granted = 0;
          for (const [advance, priority] of steps) {
            clock.t += advance;
            if (bucket.take(priority) === 0) granted++;
          }
          expect(granted).toBeLessThanOrEqual(10 + (clock.t / 1000) * 2 + 1e-6);
        },
      ),
    );
  });

  it('validates its options', () => {
    expect(
      () =>
        new TokenBucket({ capacity: 0, refillPerSecond: 1, backgroundReserve: 0, now: () => 0 }),
    ).toThrow(RangeError);
    expect(
      () =>
        new TokenBucket({ capacity: 5, refillPerSecond: 0, backgroundReserve: 0, now: () => 0 }),
    ).toThrow(RangeError);
    expect(
      () =>
        new TokenBucket({ capacity: 5, refillPerSecond: 1, backgroundReserve: 5, now: () => 0 }),
    ).toThrow(RangeError);
  });
});

describe('withRetry', () => {
  const opts = (over: Partial<RetryOptions> = {}) => {
    const slept: number[] = [];
    const o: RetryOptions = {
      maxAttempts: 4,
      baseMs: 100,
      capMs: 1000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
      ...over,
    };
    return { o, slept };
  };
  const http = (status: number, retryAfterMs?: number) =>
    new TwentyHttpError(status, 'GET', '/x', '', retryAfterMs);

  it('returns the first success without sleeping', async () => {
    const { o, slept } = opts();
    expect(await withRetry(() => Promise.resolve('ok'), o)).toBe('ok');
    expect(slept).toEqual([]);
  });

  it('retries transient failures with capped exponential backoff', async () => {
    const { o, slept } = opts({ maxAttempts: 6 });
    let n = 0;
    const result = await withRetry(
      () => (++n < 6 ? Promise.reject(http(503)) : Promise.resolve(n)),
      o,
    );
    expect(result).toBe(6);
    expect(slept).toEqual([100, 200, 400, 800, 1000]); // random() = 1 → the upper bound, capped at 1000
  });

  it('applies full jitter', async () => {
    const { o, slept } = opts({ random: () => 0.25 });
    let n = 0;
    await withRetry(() => (++n < 3 ? Promise.reject(http(500)) : Promise.resolve()), o);
    expect(slept).toEqual([25, 50]);
  });

  it('honours Retry-After and never shortens it with jitter', async () => {
    const { o, slept } = opts({ random: () => 0 });
    let n = 0;
    await withRetry(() => (++n < 2 ? Promise.reject(http(429, 7000)) : Promise.resolve()), o);
    expect(slept).toEqual([7000]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const { o } = opts({ maxAttempts: 3 });
    let n = 0;
    await expect(
      withRetry(
        () =>
          Promise.reject(http(503, undefined)).catch((e: Error) => {
            n++;
            throw e;
          }),
        o,
      ),
    ).rejects.toBeInstanceOf(TwentyHttpError);
    expect(n).toBe(3);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry %i', async (status) => {
    const { o, slept } = opts();
    let n = 0;
    const err =
      status === 401 || status === 403 ? new TwentyAuthError(status, 'GET', '/x') : http(status);
    await expect(
      withRetry(() => {
        n++;
        return Promise.reject(err);
      }, o),
    ).rejects.toBe(err);
    expect(n).toBe(1);
    expect(slept).toEqual([]);
  });

  it('classifies retryable errors', () => {
    expect(isRetryable(new TwentyNetworkError('GET', '/x', new Error('x')))).toBe(true);
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryable(http(s))).toBe(true);
    expect(isRetryable(new Error('bug'))).toBe(false);
    expect(isRetryable(new TwentyAuthError(401, 'GET', '/x'))).toBe(false);
  });
});

describe('paging', () => {
  it('chunks into batches of at most 60', () => {
    expect(chunk([], 60)).toEqual([]);
    expect(chunk(Array.from({ length: 130 }, (_, i) => i)).map((c) => c.length)).toEqual([
      60, 60, 10,
    ]);
    expect(MAX_BATCH).toBe(60);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it('property: chunks preserve order and content and respect the size', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 300 }),
        fc.integer({ min: 1, max: 80 }),
        (items, size) => {
          const chunks = chunk(items, size);
          expect(chunks.flat()).toEqual(items);
          expect(chunks.every((c) => c.length >= 1 && c.length <= size)).toBe(true);
        },
      ),
    );
  });

  it('walks pages until there is no next cursor', async () => {
    const data = [[1, 2], [3, 4], [5]];
    const cursors: (string | null)[] = [];
    const all = await collect(
      paginate<number>((cursor) => {
        cursors.push(cursor);
        const i = cursor === null ? 0 : Number(cursor);
        return Promise.resolve({
          items: data[i] ?? [],
          nextCursor: i + 1 < data.length ? String(i + 1) : null,
        });
      }),
    );
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual([null, '1', '2']);
  });

  it('handles an empty first page', async () => {
    expect(await collect(paginate(() => Promise.resolve({ items: [], nextCursor: null })))).toEqual(
      [],
    );
  });

  it('refuses to loop forever on a repeating cursor', async () => {
    await expect(
      collect(paginate(() => Promise.resolve({ items: [1], nextCursor: 'same' }))),
    ).rejects.toThrow(/cursor repeated/);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'person.updated', record: { id: 'x' } });
  const now = Date.parse('2026-09-30T12:00:00Z');
  const ts = String(Math.floor(now / 1000));
  const good = signWebhook(secret, ts, body);

  it('accepts a correct signature (timestamp in seconds or milliseconds)', () => {
    expect(verifyWebhook({ secret, timestamp: ts, signature: good, rawBody: body, now })).toEqual({
      ok: true,
    });
    const tsMs = String(now);
    expect(
      verifyWebhook({
        secret,
        timestamp: tsMs,
        signature: signWebhook(secret, tsMs, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('matches an independent HMAC-SHA256 computation over "<timestamp>:<body>" (Twenty v2.43.0)', () => {
    expect(good).toBe(createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex'));
  });

  it('rejects a delivery signed over "<timestamp>.<body>", the form the docs implied', () => {
    const tsMs = String(now);
    const dotted = createHmac('sha256', secret).update(`${tsMs}.${body}`).digest('hex');
    expect(
      verifyWebhook({ secret, timestamp: tsMs, signature: dotted, rawBody: body, now }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a wrong secret, a tampered body and a tampered timestamp', () => {
    expect(
      verifyWebhook({ secret: 'other', timestamp: ts, signature: good, rawBody: body, now }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(
      verifyWebhook({ secret, timestamp: ts, signature: good, rawBody: body + ' ', now }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(
      verifyWebhook({
        secret,
        timestamp: String(Number(ts) + 1),
        signature: good,
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects replays: timestamps too old or too far in the future', () => {
    for (const skew of [-301, 301]) {
      const t = String(Number(ts) + skew);
      const verdict = verifyWebhook({
        secret,
        timestamp: t,
        signature: signWebhook(secret, t, body),
        rawBody: body,
        now,
      });
      expect(verdict).toEqual({ ok: false, reason: 'STALE' });
    }
    const edge = String(Number(ts) - 300);
    expect(
      verifyWebhook({
        secret,
        timestamp: edge,
        signature: signWebhook(secret, edge, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['missing timestamp', undefined, good],
    ['missing signature', ts, undefined],
    ['non-numeric timestamp', 'yesterday', good],
    ['non-hex signature', ts, 'zz'],
    ['empty signature', ts, ''],
  ])('treats %s as malformed, never as a crash', (_name, timestamp, signature) => {
    expect(verifyWebhook({ secret, timestamp, signature, rawBody: body, now })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('a truncated or lengthened signature is rejected without throwing', () => {
    expect(
      verifyWebhook({ secret, timestamp: ts, signature: good.slice(0, 20), rawBody: body, now }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(
      verifyWebhook({ secret, timestamp: ts, signature: good + 'ab', rawBody: body, now }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('lets the signed payload format be swapped once M0 confirms the real one', () => {
    const custom = (t: string, b: string) => `v1:${t}:${b}`;
    const sig = signWebhook(secret, ts, body, custom);
    expect(
      verifyWebhook({
        secret,
        timestamp: ts,
        signature: sig,
        rawBody: body,
        now,
        signedPayload: custom,
      }),
    ).toEqual({ ok: true });
    expect(verifyWebhook({ secret, timestamp: ts, signature: sig, rawBody: body, now })).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });
});
