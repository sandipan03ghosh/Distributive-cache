/**
 * @flowcache/benchmark — BenchmarkRunner.ts
 *
 * Drives a single workload run against a live FlowCache
 * gateway/cache-node for a fixed duration, using
 * `@flowcache/worker-pool` to execute batches of operations truly
 * concurrently (separate OS threads, not just interleaved promises on
 * one event loop — important for getting believable throughput numbers
 * out of a Node.js load generator). Measures throughput, latency
 * percentiles, and error count; optionally captures an
 * application-supplied metrics snapshot before and after the run.
 */

import { nowMs } from '@flowcache/shared';
import { WorkerPool, TaskTypes, type BenchmarkExecuteOpsPayload, type BenchmarkExecuteOpsResult } from '@flowcache/worker-pool';
import type { LatencyPercentiles } from '@flowcache/shared';
import { createWorkload } from './workloads/WorkloadFactory.js';
import type { BenchmarkRunResult, WorkloadDefinition } from './types.js';

export interface BenchmarkRunOptions {
  name: string;
  targetBaseUrl: string;
  workload: WorkloadDefinition;
  durationMs: number;
  /** Number of batches to keep in flight concurrently — roughly maps
   *  to "number of virtual clients." Should not exceed the worker
   *  pool's size by much, or batches will just queue behind busy
   *  workers instead of adding real parallelism. */
  concurrency: number;
  opsPerBatch?: number;
  requestTimeoutMs?: number;
  /** Optional hook to capture cluster metrics immediately before and
   *  after the run, for inclusion in the result / report. Left generic
   *  (rather than this package fetching a hardcoded gateway route) so
   *  it has no compile-time dependency on the gateway's API shape. */
  captureMetrics?: () => Promise<Record<string, unknown>>;
}

export interface BenchmarkRunnerOptions {
  /** Reuse an existing pool (e.g. shared across multiple runs in a
   *  PolicyComparisonRunner) instead of creating a dedicated one. */
  pool?: WorkerPool;
  /** Only used if `pool` isn't provided. */
  poolSize?: number;
}

const DEFAULT_OPS_PER_BATCH = 50;
const DEFAULT_POOL_SIZE = 8;

export class BenchmarkRunner {
  private readonly pool: WorkerPool;
  private readonly ownsPool: boolean;

  constructor(options: BenchmarkRunnerOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new WorkerPool({ size: options.poolSize ?? DEFAULT_POOL_SIZE });
      this.ownsPool = true;
    }
  }

  async run(options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
    const generator = createWorkload(options.workload);
    const opsPerBatch = options.opsPerBatch ?? DEFAULT_OPS_PER_BATCH;

    const metricsBefore = options.captureMetrics ? await safeCapture(options.captureMetrics) : null;

    const startedAt = nowMs();
    const deadline = startedAt + options.durationMs;

    const allLatenciesMs: number[] = [];
    const opCounts = { GET: 0, PUT: 0, DELETE: 0 };
    let errors = 0;

    const inFlight = new Set<Promise<void>>();

    const launchBatch = (): void => {
      const batch = generator.nextBatch(opsPerBatch);
      const payload: BenchmarkExecuteOpsPayload = {
        targetBaseUrl: options.targetBaseUrl,
        operations: batch,
        requestTimeoutMs: options.requestTimeoutMs,
      };

      const promise: Promise<void> = this.pool
        .submitTask<BenchmarkExecuteOpsPayload, BenchmarkExecuteOpsResult>(TaskTypes.BENCHMARK_EXECUTE_OPS, payload)
        .then((result) => {
          for (const latency of result.latenciesMs) allLatenciesMs.push(latency);
          errors += result.errors;
          opCounts.GET += result.opCounts.GET;
          opCounts.PUT += result.opCounts.PUT;
          opCounts.DELETE += result.opCounts.DELETE;
        })
        .catch(() => {
          // The whole batch failed to even execute (e.g. worker crash
          // mid-task) — count every op in it as an error rather than
          // silently dropping them from the totals.
          errors += batch.length;
        })
        .finally(() => {
          inFlight.delete(promise);
        });

      inFlight.add(promise);
    };

    while (nowMs() < deadline) {
      while (inFlight.size < options.concurrency && nowMs() < deadline) {
        launchBatch();
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }
    await Promise.all(inFlight);

    const finishedAt = nowMs();
    const metricsAfter = options.captureMetrics ? await safeCapture(options.captureMetrics) : null;

    const totalOperations = opCounts.GET + opCounts.PUT + opCounts.DELETE + errors;
    const actualDurationMs = Math.max(1, finishedAt - startedAt);

    return {
      name: options.name,
      workloadType: options.workload.type,
      startedAt,
      finishedAt,
      durationMs: actualDurationMs,
      totalOperations,
      opCounts,
      errors,
      throughputOpsPerSec: (totalOperations / actualDurationMs) * 1000,
      latency: computeLatencyPercentiles(allLatenciesMs),
      metricsBefore,
      metricsAfter,
    };
  }

  async dispose(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.dispose();
    }
  }
}

async function safeCapture(fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
  try {
    return await fn();
  } catch {
    // Metrics capture is best-effort context for the report, not
    // something that should fail an otherwise-successful benchmark run.
    return null;
  }
}

function computeLatencyPercentiles(samplesMs: number[]): LatencyPercentiles {
  if (samplesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number): number => {
    const rank = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}