/**
 * @flowcache/metrics — RateCounter.ts
 *
 * Tracks a rolling requests-per-second rate using a timestamped ring
 * buffer: each call to `hit()` records `Date.now()`; `rate()` counts
 * how many timestamps fall within the trailing window and divides by
 * the window length in seconds. Memory is bounded by `capacity`
 * regardless of actual traffic volume (older timestamps are simply
 * overwritten), so this is safe to call on every single request even
 * at high QPS.
 */

import { RingBuffer } from '@flowcache/shared';

export class RateCounter {
  private readonly timestamps: RingBuffer<number>;
  private readonly windowMs: number;

  constructor(windowMs = 1000, capacity = 20_000) {
    this.windowMs = windowMs;
    this.timestamps = new RingBuffer<number>(capacity);
  }

  hit(atMs: number = Date.now()): void {
    this.timestamps.push(atMs);
  }

  /** Requests per second, averaged over the trailing `windowMs`. */
  rate(nowMs: number = Date.now()): number {
    const cutoff = nowMs - this.windowMs;
    let count = 0;
    for (const ts of this.timestamps.toArray()) {
      if (ts >= cutoff) count += 1;
    }
    return count / (this.windowMs / 1000);
  }

  reset(): void {
    this.timestamps.clear();
  }
}