/**
 * @flowcache/benchmark — workloads/SequentialScanWorkload.ts
 *
 * Walks the keyspace in strictly increasing order, wrapping around at
 * the end — simulating a full table/range scan (e.g. a batch export
 * job or analytics query). This is deliberately the exact pattern
 * `WorkloadMonitor`'s sequential-access detector (in
 * `packages/eviction`) is designed to catch: trailing numeric key
 * suffixes incrementing by exactly 1 between consecutive accesses.
 * Running this workload against a live FlowCache cluster is the most
 * direct way to demonstrate the AdaptiveEvictionEngine switching to
 * LRU in response.
 */

import type { BenchmarkOperation } from '@flowcache/worker-pool';
import { WorkloadType } from '../types.js';
import type { WorkloadGenerator } from './WorkloadGenerator.js';
import { syntheticValue } from './util.js';

export class SequentialScanWorkload implements WorkloadGenerator {
  readonly type = WorkloadType.SEQUENTIAL_SCAN;

  private cursor = 0;

  constructor(
    private readonly keyspaceSize: number,
    private readonly keyPrefix: string = 'key',
    private readonly op: 'GET' | 'PUT' = 'GET',
  ) {}

  nextBatch(count: number): BenchmarkOperation[] {
    const ops: BenchmarkOperation[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const key = `${this.keyPrefix}:${this.cursor}`;
      ops[i] = this.op === 'GET' ? { op: 'GET', key } : { op: 'PUT', key, value: syntheticValue(this.cursor) };
      this.cursor = (this.cursor + 1) % this.keyspaceSize;
    }
    return ops;
  }
}