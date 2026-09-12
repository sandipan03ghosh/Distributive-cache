/**
 * @flowcache/metrics — LatencyHistogram.ts
 *
 * Records a bounded window of recent request-latency samples (a ring
 * buffer, so memory stays flat regardless of request volume) and
 * computes P50 / P95 / P99 / max on demand. Sorting on read (rather
 * than maintaining an always-sorted structure on write) is deliberate:
 * writes happen on the hot request path and must be O(1); reads happen
 * only when `/metrics` is polled, so paying O(n log n) there is the
 * right tradeoff.
 */

import { RingBuffer, type LatencyPercentiles } from '@flowcache/shared';

const DEFAULT_CAPACITY = 5000;

export class LatencyHistogram {
  private readonly samples: RingBuffer<number>;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.samples = new RingBuffer<number>(capacity);
  }

  record(latencyMs: number): void {
    this.samples.push(latencyMs);
  }

  percentiles(): LatencyPercentiles {
    const sorted = this.samples.toArray().sort((a, b) => a - b);
    if (sorted.length === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0 };
    }
    return {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
    };
  }

  sampleCount(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples.clear();
  }
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(p * sortedAscending.length) - 1;
  const clampedIndex = Math.min(Math.max(rank, 0), sortedAscending.length - 1);
  return sortedAscending[clampedIndex];
}