/**
 * @flowcache/benchmark — workloads/UniformRandomWorkload.ts
 *
 * Every key in the keyspace is equally likely to be accessed on any
 * given operation — the baseline workload with no exploitable locality
 * at all. Useful as a control: a cache's hit ratio here is bounded by
 * `min(1, cacheCapacity / keyspaceSize)` regardless of eviction policy,
 * since there's no "hot set" for any policy to protect.
 */

import type { BenchmarkOperation } from '@flowcache/worker-pool';
import { WorkloadType } from '../types.js';
import type { WorkloadGenerator } from './WorkloadGenerator.js';
import { syntheticValue } from './util.js';

export class UniformRandomWorkload implements WorkloadGenerator {
  readonly type: WorkloadType;

  constructor(
    private readonly keyspaceSize: number,
    private readonly readRatio: number = 0.8,
    private readonly keyPrefix: string = 'key',
    // Lets WorkloadFactory reuse this class for presets (e.g. WRITE_HEAVY)
    // that are uniform-random under the hood but should still report
    // their own requested type, not UNIFORM_RANDOM.
    type: WorkloadType = WorkloadType.UNIFORM_RANDOM,
  ) {
    this.type = type;
  }

  nextBatch(count: number): BenchmarkOperation[] {
    const ops: BenchmarkOperation[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const index = Math.floor(Math.random() * this.keyspaceSize);
      const key = `${this.keyPrefix}:${index}`;
      ops[i] =
        Math.random() < this.readRatio
          ? { op: 'GET', key }
          : { op: 'PUT', key, value: syntheticValue(index) };
    }
    return ops;
  }
}