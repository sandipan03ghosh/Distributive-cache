/**
 * @flowcache/metrics — Timer.ts
 *
 * A tiny high-resolution stopwatch built on `process.hrtime.bigint()`
 * (monotonic, immune to system clock adjustments — unlike `Date.now()`
 * deltas, which can go backwards or jump if NTP steps the clock mid
 * request). Used to measure per-request latency for the P50/P95/P99
 * histogram.
 */

export class Timer {
  private readonly startNs: bigint;

  private constructor(startNs: bigint) {
    this.startNs = startNs;
  }

  static start(): Timer {
    return new Timer(process.hrtime.bigint());
  }

  /** Elapsed time in milliseconds since `start()`, as a float
   *  (sub-millisecond precision is preserved). */
  elapsedMs(): number {
    const elapsedNs = process.hrtime.bigint() - this.startNs;
    return Number(elapsedNs) / 1_000_000;
  }
}

/** Convenience wrapper for timing an async operation without manually
 *  juggling a Timer instance at every call site. */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const timer = Timer.start();
  const result = await fn();
  return { result, elapsedMs: timer.elapsedMs() };
}

/** Synchronous counterpart to `timeAsync`. */
export function timeSync<T>(fn: () => T): { result: T; elapsedMs: number } {
  const timer = Timer.start();
  const result = fn();
  return { result, elapsedMs: timer.elapsedMs() };
}