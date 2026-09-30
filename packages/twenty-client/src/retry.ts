// SPDX-License-Identifier: AGPL-3.0-or-later
import { isRetryable, TwentyHttpError } from './errors.js';

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Uniform in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_RETRY = { maxAttempts: 5, baseMs: 500, capMs: 30_000 } as const;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Retries transient failures with exponential backoff and full jitter. A `Retry-After` from the server
 * is honoured (up to five minutes) and never shortened by jitter.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: RetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= o.maxAttempts || !isRetryable(error)) throw error;
      const jittered = o.random() * Math.min(o.capMs, o.baseMs * 2 ** (attempt - 1));
      const told = error instanceof TwentyHttpError ? error.retryAfterMs : undefined;
      await o.sleep(
        told !== undefined ? Math.min(MAX_RETRY_AFTER_MS, Math.max(told, jittered)) : jittered,
      );
    }
  }
}
