/**
 * @flowcache/benchmark — workloads/ZipfianWorkload.ts
 *
 * Models the classic "80/20" access pattern real caches actually see:
 * a small set of keys is accessed far more often than the rest,
 * following a Zipf distribution (probability of rank `k` being chosen
 * is proportional to `1 / k^skew`). Higher `skew` concentrates access
 * on fewer keys.
 *
 * Implementation: precompute the cumulative distribution function
 * (CDF) over all `keyspaceSize` ranks once at construction time
 * (O(n)), then sample by drawing a uniform random number and binary
 * searching the CDF for its rank (O(log n) per sample) — the standard
 * inverse-CDF sampling technique, simpler than rejection-based
 * "rejection inversion" Zipfian generators while still exact for
 * keyspace sizes benchmarks realistically use (up to a few million).
 */

import type { BenchmarkOperation } from '@flowcache/worker-pool';
import { WorkloadType } from '../types.js';
import type { WorkloadGenerator } from './WorkloadGenerator.js';
import { syntheticValue } from './util.js';

export class ZipfianWorkload implements WorkloadGenerator {
  readonly type: WorkloadType;

  private readonly cdf: Float64Array;

  constructor(
    keyspaceSize: number,
    private readonly readRatio: number = 0.8,
    skew: number = 1.07,
    private readonly keyPrefix: string = 'key',
    // Lets WorkloadFactory reuse this class for presets (e.g. READ_HEAVY)
    // that are Zipfian under the hood but should still report their own
    // requested type, not ZIPFIAN.
    type: WorkloadType = WorkloadType.ZIPFIAN,
  ) {
    this.type = type;
    this.cdf = buildZipfianCdf(keyspaceSize, skew);
  }

  nextBatch(count: number): BenchmarkOperation[] {
    const ops: BenchmarkOperation[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const rank = sampleRank(this.cdf);
      const key = `${this.keyPrefix}:${rank}`;
      ops[i] =
        Math.random() < this.readRatio
          ? { op: 'GET', key }
          : { op: 'PUT', key, value: syntheticValue(rank) };
    }
    return ops;
  }
}

function buildZipfianCdf(n: number, skew: number): Float64Array {
  const weights = new Float64Array(n);
  let totalWeight = 0;
  for (let rank = 1; rank <= n; rank++) {
    const weight = 1 / Math.pow(rank, skew);
    weights[rank - 1] = weight;
    totalWeight += weight;
  }

  const cdf = new Float64Array(n);
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    cumulative += weights[i] / totalWeight;
    cdf[i] = cumulative;
  }
  // Guard against floating point rounding leaving the last entry
  // slightly under 1, which could make the topmost rank unreachable.
  cdf[n - 1] = 1;
  return cdf;
}

function sampleRank(cdf: Float64Array): number {
  const r = Math.random();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < r) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}