// SPDX-License-Identifier: AGPL-3.0-or-later

export type Priority = 'interactive' | 'background';

export interface BucketOptions {
  /** Maximum burst. */
  capacity: number;
  refillPerSecond: number;
  /** Tokens that background work may never use, so a person clicking "Save" is never stuck behind a bulk import. */
  backgroundReserve: number;
  now: () => number;
}

/**
 * Cloud Twenty documents ~100 requests/minute; the self-host limit is UNVERIFIED (docs/verification-status.md).
 * Keep one bucket per tenant so one busy church cannot starve another. Defaults stay under 100/min.
 */
export const DEFAULT_BUCKET = { capacity: 20, refillPerSecond: 1.4, backgroundReserve: 6 } as const;

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly opts: BucketOptions) {
    if (!(opts.capacity >= 1)) throw new RangeError('capacity must be >= 1');
    if (!(opts.refillPerSecond > 0)) throw new RangeError('refillPerSecond must be > 0');
    if (!(opts.backgroundReserve >= 0 && opts.backgroundReserve < opts.capacity)) {
      throw new RangeError('backgroundReserve must be >= 0 and < capacity');
    }
    this.tokens = opts.capacity;
    this.last = opts.now();
  }

  private refill(): void {
    const t = this.opts.now();
    const seconds = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.opts.capacity, this.tokens + seconds * this.opts.refillPerSecond);
    this.last = t;
  }

  /** Takes one token and returns 0, or returns how many milliseconds to wait before asking again. */
  take(priority: Priority = 'interactive'): number {
    this.refill();
    const floor = priority === 'background' ? this.opts.backgroundReserve : 0;
    if (this.tokens - 1 >= floor - 1e-9) {
      this.tokens -= 1;
      return 0;
    }
    const missing = floor + 1 - this.tokens;
    return Math.max(1, Math.ceil((missing / this.opts.refillPerSecond) * 1000));
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
