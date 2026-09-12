/**
 * @flowcache/benchmark — workloads/WorkloadFactory.ts
 *
 * Single place that turns a declarative `WorkloadDefinition` (what
 * `BenchmarkRunner.run()` and the benchmark CLI/config actually take)
 * into a concrete `WorkloadGenerator` instance. READ_HEAVY and
 * WRITE_HEAVY are implemented as pre-tuned presets on top of the two
 * primitive distributions (Zipfian and uniform, respectively) rather
 * than separate classes, since "read-heavy" and "write-heavy" describe
 * a read/write ratio, not a different key-selection strategy.
 */

import { WorkloadType, type WorkloadDefinition } from '../types.js';
import type { WorkloadGenerator } from './WorkloadGenerator.js';
import { UniformRandomWorkload } from './UniformRandomWorkload.js';
import { ZipfianWorkload } from './ZipfianWorkload.js';
import { SequentialScanWorkload } from './SequentialScanWorkload.js';
import { MixedWorkload } from './MixedWorkload.js';

export function createWorkload(definition: WorkloadDefinition): WorkloadGenerator {
  const keyPrefix = definition.keyPrefix ?? 'key';

  switch (definition.type) {
    case WorkloadType.UNIFORM_RANDOM:
      return new UniformRandomWorkload(definition.keyspaceSize, definition.readRatio ?? 0.8, keyPrefix);

    case WorkloadType.ZIPFIAN:
      return new ZipfianWorkload(
        definition.keyspaceSize,
        definition.readRatio ?? 0.8,
        definition.zipfianSkew ?? 1.07,
        keyPrefix,
      );

    case WorkloadType.READ_HEAVY:
      // Read-heavy production traffic is almost always also skewed
      // (a small set of hot objects gets read repeatedly) — modeling
      // it as high-readRatio Zipfian rather than high-readRatio
      // uniform is what actually gives LFU/TinyLFU something to win on.
      return new ZipfianWorkload(
        definition.keyspaceSize,
        definition.readRatio ?? 0.95,
        definition.zipfianSkew ?? 1.2,
        keyPrefix,
        WorkloadType.READ_HEAVY,
      );

    case WorkloadType.WRITE_HEAVY:
      return new UniformRandomWorkload(
        definition.keyspaceSize,
        definition.readRatio ?? 0.1,
        keyPrefix,
        WorkloadType.WRITE_HEAVY,
      );

    case WorkloadType.SEQUENTIAL_SCAN:
      return new SequentialScanWorkload(definition.keyspaceSize, keyPrefix, 'GET');

    case WorkloadType.MIXED:
      return new MixedWorkload([
        { generator: new UniformRandomWorkload(definition.keyspaceSize, 0.8, keyPrefix), weight: 1 },
        { generator: new ZipfianWorkload(definition.keyspaceSize, 0.9, 1.1, keyPrefix), weight: 1 },
        { generator: new SequentialScanWorkload(definition.keyspaceSize, keyPrefix, 'GET'), weight: 0.5 },
      ]);

    default: {
      const exhaustiveCheck: never = definition.type;
      throw new Error(`Unknown workload type: ${String(exhaustiveCheck)}`);
    }
  }
}