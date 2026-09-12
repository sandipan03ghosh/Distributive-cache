/**
 * @flowcache/benchmark — workloads/MixedWorkload.ts
 *
 * Combines several sub-generators behind weighted random selection —
 * on each operation, one component generator is chosen proportional to
 * its weight and asked for a single op. This simulates realistic,
 * heterogeneous production traffic (some uniform noise, a skewed hot
 * set, occasional scans) in one workload, which is exactly the
 * situation the AdaptiveEvictionEngine's "no signal dominates ->
 * default to TinyLFU" tie-break rule is meant for.
 */

import type { BenchmarkOperation } from '@flowcache/worker-pool';
import { WorkloadType } from '../types.js';
import type { WorkloadGenerator } from './WorkloadGenerator.js';

export interface WeightedComponent {
  generator: WorkloadGenerator;
  weight: number;
}

export class MixedWorkload implements WorkloadGenerator {
  readonly type = WorkloadType.MIXED;

  private readonly components: WeightedComponent[];
  private readonly totalWeight: number;

  constructor(components: WeightedComponent[]) {
    if (components.length === 0) {
      throw new Error('MixedWorkload requires at least one component generator');
    }
    this.components = components;
    this.totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  }

  nextBatch(count: number): BenchmarkOperation[] {
    const ops: BenchmarkOperation[] = new Array(count);
    for (let i = 0; i < count; i++) {
      ops[i] = this.pickComponent().nextBatch(1)[0];
    }
    return ops;
  }

  private pickComponent(): WorkloadGenerator {
    let r = Math.random() * this.totalWeight;
    for (const component of this.components) {
      if (r < component.weight) return component.generator;
      r -= component.weight;
    }
    // Floating point edge case: fall back to the last component.
    return this.components[this.components.length - 1].generator;
  }
}