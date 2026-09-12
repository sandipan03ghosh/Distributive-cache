/**
 * @flowcache/benchmark — workloads/WorkloadGenerator.ts
 *
 * The common interface every workload implements. `BenchmarkRunner`
 * calls `nextBatch(n)` repeatedly on the main thread (cheap — just key
 * selection, no I/O) to produce operation lists, which are then handed
 * off to `@flowcache/worker-pool`'s BENCHMARK_EXECUTE_OPS task for
 * actual concurrent HTTP execution.
 */

import type { BenchmarkOperation } from '@flowcache/worker-pool';
import type { WorkloadType } from '../types.js';

export interface WorkloadGenerator {
  readonly type: WorkloadType;
  nextBatch(count: number): BenchmarkOperation[];
}