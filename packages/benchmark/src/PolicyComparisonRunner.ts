/**
 * @flowcache/benchmark — PolicyComparisonRunner.ts
 *
 * Runs the exact same workload multiple times against the same
 * cluster, switching the active eviction policy (LRU / LFU / TinyLFU /
 * Adaptive) between runs, and reports throughput / latency / hit-ratio
 * side by side — the core "compare LRU vs LFU vs TinyLFU vs Adaptive"
 * requirement.
 *
 * How the policy actually gets switched is left to an injected
 * `setPolicy` callback rather than hardcoded here: in practice this
 * calls an admin endpoint on the gateway/cache-node
 * (`AdaptiveEvictionEngine.forceSwitch()` under the hood, or a
 * config flag that disables adaptive mode entirely and pins a single
 * policy) — this package has no compile-time dependency on that API.
 */

import { nowMs } from '@flowcache/shared';
import { BenchmarkRunner, type BenchmarkRunOptions } from './BenchmarkRunner.js';
import type { BenchmarkRunResult, PolicyComparisonReport, PolicyLabel } from './types.js';

export interface PolicyComparisonOptions extends Omit<BenchmarkRunOptions, 'name'> {
  policiesToCompare: PolicyLabel[];
  setPolicy: (policy: PolicyLabel) => Promise<void>;
  /** Pause after switching policy, before starting the timed run, so
   *  the freshly-selected (or freshly-adaptive) policy has a moment to
   *  warm up rather than being measured cold. */
  warmupMs?: number;
}

export class PolicyComparisonRunner {
  constructor(private readonly runner: BenchmarkRunner) {}

  async compare(options: PolicyComparisonOptions): Promise<PolicyComparisonReport> {
    const results: BenchmarkRunResult[] = [];

    for (const policy of options.policiesToCompare) {
      await options.setPolicy(policy);
      if (options.warmupMs && options.warmupMs > 0) {
        await sleep(options.warmupMs);
      }

      const result = await this.runner.run({ ...options, name: policy });
      results.push(result);
    }

    return {
      generatedAt: nowMs(),
      workloadType: options.workload.type,
      results,
      bestThroughput: maxBy(results, (r) => r.throughputOpsPerSec)?.name ?? 'n/a',
      bestP99Latency: minBy(results, (r) => r.latency.p99)?.name ?? 'n/a',
      bestHitRatio: bestHitRatioLabel(results),
    };
  }
}

function bestHitRatioLabel(results: BenchmarkRunResult[]): string | null {
  const withHitRatio = results
    .map((r) => ({ name: r.name, hitRatio: extractHitRatio(r.metricsAfter) }))
    .filter((r): r is { name: string; hitRatio: number } => r.hitRatio !== null);

  if (withHitRatio.length === 0) return null;
  return withHitRatio.reduce((best, current) => (current.hitRatio > best.hitRatio ? current : best)).name;
}

function extractHitRatio(metrics: Record<string, unknown> | null): number | null {
  if (!metrics) return null;
  const candidate = metrics.overallHitRatio ?? metrics.hitRatio;
  return typeof candidate === 'number' ? candidate : null;
}

function maxBy<T>(items: readonly T[], selector: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) => (best === undefined || selector(item) > selector(best) ? item : best),
    undefined,
  );
}

function minBy<T>(items: readonly T[], selector: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) => (best === undefined || selector(item) < selector(best) ? item : best),
    undefined,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}