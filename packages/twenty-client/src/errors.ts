// SPDX-License-Identifier: AGPL-3.0-or-later

/** The server answered with an error status. The message never includes credentials. */
export class TwentyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodySnippet: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Twenty ${method} ${path} failed with ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'TwentyHttpError';
  }
}

/** We never got a usable response (connection reset, timeout, DNS). The request may or may not have been applied. */
export class TwentyNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`Twenty ${method} ${path} did not complete`, { cause });
    this.name = 'TwentyNetworkError';
  }
}

/** The API key was rejected. Never retried: retrying only hammers the server. */
export class TwentyAuthError extends TwentyHttpError {
  constructor(status: number, method: string, path: string) {
    super(status, method, path, 'authentication failed');
    this.name = 'TwentyAuthError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Everything The Fold sends is idempotent (source-ref upserts), so transient failures are safe to retry. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TwentyNetworkError) return true;
  if (error instanceof TwentyAuthError) return false;
  return error instanceof TwentyHttpError && RETRYABLE_STATUS.has(error.status);
}
