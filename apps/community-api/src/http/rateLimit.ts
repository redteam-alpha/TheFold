// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LimitVerdict {
  ok: boolean;
  /** Seconds until the window resets; only meaningful when `ok` is false. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter per key (here: church + client IP), in memory. Enough for one API instance; with
 * several instances each enforces its own window, so the effective limit is `limit × instances`. That is an
 * accepted trade-off for a public form: it bounds abuse without adding Redis.
 *
 * Memory is bounded: expired windows are dropped, and past `maxKeys` the oldest windows go first.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): LimitVerdict {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      if (w) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evict(t);
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.limit
      ? { ok: true, retryAfterSeconds: 0 }
      : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
  }

  private evict(t: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
    // Map iteration is insertion order: what is left first is the oldest window.
    for (const k of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(k);
    }
  }
}
