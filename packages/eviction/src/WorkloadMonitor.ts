/**
 * @flowcache/eviction — WorkloadMonitor.ts
 *
 * Consumes raw cache traffic (hits, misses, writes) and turns it into
 * the `WorkloadSignals` the AdaptiveEvictionEngine's decision rules act
 * on: hit/miss rate, read/write ratio, frequency skew (how concentrated
 * accesses are on a few hot keys), a sequential-scan score, and working
 * set size relative to the observed window.
 *
 * A sliding window (fixed-capacity ring buffer of recently-seen keys)
 * keeps memory bounded and keeps signals reflecting *current* behavior
 * rather than all-time history, so the engine can react to workload
 * shifts (e.g. a batch job doing a sequential scan) within seconds.
 */

import { Ema, RingBuffer, type CacheKey, type WorkloadSignals } from '@flowcache/shared';

const WINDOW_CAPACITY = 2000;
const EMA_ALPHA = 0.25;

/** Matches a trailing run of digits in a key, e.g. "user:8842" -> 8842,
 *  "scan-key-00123" -> 123. Used purely as a heuristic signal for
 *  sequential-scan detection on benchmark-style monotonic keyspaces;
 *  keys without a trailing number simply don't contribute a sample. */
const TRAILING_NUMBER = /(\d+)(?!.*\d)/;

export class WorkloadMonitor {
  private readonly recentKeys = new RingBuffer<CacheKey>(WINDOW_CAPACITY);

  private readonly hitRateEma = new Ema(EMA_ALPHA);
  private readonly writeRatioEma = new Ema(EMA_ALPHA);

  private hitsInWindow = 0;
  private missesInWindow = 0;
  private writesInWindow = 0;
  private readsInWindow = 0;

  /** Cumulative across the monitor's lifetime (not reset per window) so
   *  the engine can require a minimum amount of *total* observed
   *  traffic before it starts making switching decisions. */
  private totalSamples = 0;

  private lastNumericSuffix: number | null = null;
  private sequentialMatches = 0;
  private sequentialSamples = 0;

  recordHit(key: CacheKey): void {
    this.hitsInWindow += 1;
    this.readsInWindow += 1;
    this.totalSamples += 1;
    this.observeKey(key);
  }

  recordMiss(key: CacheKey): void {
    this.missesInWindow += 1;
    this.readsInWindow += 1;
    this.totalSamples += 1;
    this.observeKey(key);
  }

  recordWrite(key: CacheKey): void {
    this.writesInWindow += 1;
    this.totalSamples += 1;
    this.observeKey(key);
  }

  computeSignals(memoryUsageRatio: number): WorkloadSignals {
    const reads = this.readsInWindow;
    const writes = this.writesInWindow;
    const totalOps = reads + writes;

    const windowHitRate = reads > 0 ? this.hitsInWindow / reads : this.hitRateEma.get();
    const windowWriteRatio = totalOps > 0 ? writes / totalOps : this.writeRatioEma.get();

    const smoothedHitRate = this.hitRateEma.update(windowHitRate);
    const smoothedWriteRatio = this.writeRatioEma.update(windowWriteRatio);

    const keys = this.recentKeys.toArray();
    const frequencyByKey = new Map<CacheKey, number>();
    for (const key of keys) {
      frequencyByKey.set(key, (frequencyByKey.get(key) ?? 0) + 1);
    }

    const signals: WorkloadSignals = {
      hitRate: smoothedHitRate,
      missRate: 1 - smoothedHitRate,
      memoryUsageRatio,
      writeRatio: smoothedWriteRatio,
      readRatio: 1 - smoothedWriteRatio,
      frequencySkew: giniCoefficient([...frequencyByKey.values()]),
      sequentialAccessScore: this.sequentialSamples > 0 ? this.sequentialMatches / this.sequentialSamples : 0,
      workingSetSizeRatio: keys.length > 0 ? frequencyByKey.size / keys.length : 0,
      windowSampleCount: this.totalSamples,
    };

    this.slideWindow();
    return signals;
  }

  reset(): void {
    this.recentKeys.clear();
    this.hitRateEma.reset();
    this.writeRatioEma.reset();
    this.hitsInWindow = 0;
    this.missesInWindow = 0;
    this.writesInWindow = 0;
    this.readsInWindow = 0;
    this.totalSamples = 0;
    this.lastNumericSuffix = null;
    this.sequentialMatches = 0;
    this.sequentialSamples = 0;
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  private observeKey(key: CacheKey): void {
    this.recentKeys.push(key);
    this.updateSequentialDetection(key);
  }

  private updateSequentialDetection(key: CacheKey): void {
    const match = TRAILING_NUMBER.exec(key);
    if (!match) return; // key has no numeric suffix; contributes no sample either way

    const current = Number(match[1]);
    this.sequentialSamples += 1;
    if (this.lastNumericSuffix !== null && Math.abs(current - this.lastNumericSuffix) === 1) {
      this.sequentialMatches += 1;
    }
    this.lastNumericSuffix = current;
  }

  /** Per-window counters reset every time signals are computed (so
   *  hit/miss/write ratios reflect the most recent interval); the ring
   *  buffer and EMAs persist across windows to provide the actual
   *  smoothing and keep working-set/frequency-skew calculations
   *  meaningful even right after a reset. */
  private slideWindow(): void {
    this.hitsInWindow = 0;
    this.missesInWindow = 0;
    this.writesInWindow = 0;
    this.readsInWindow = 0;
    this.sequentialMatches = 0;
    this.sequentialSamples = 0;
  }
}

/**
 * Gini coefficient over a set of frequency counts, normalized to
 * [0, 1]. 0 means perfectly uniform access (every key touched equally
 * often); values approaching 1 mean access is concentrated on very few
 * keys. Used as the "frequencySkew" signal — a proxy for "would LFU
 * actually help here, or is every key equally hot/cold?"
 */
function giniCoefficient(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;

  let weightedCumulative = 0;
  for (let i = 0; i < n; i++) {
    weightedCumulative += (i + 1) * sorted[i];
  }

  const gini = (2 * weightedCumulative) / (n * sum) - (n + 1) / n;
  return Math.max(0, Math.min(1, gini));
}

export { giniCoefficient };