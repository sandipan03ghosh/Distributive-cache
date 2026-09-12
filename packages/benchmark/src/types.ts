/**
 * @flowcache/benchmark — types.ts
 */

import type { EvictionPolicyType, LatencyPercentiles } from '@flowcache/shared';

export enum WorkloadType {
  UNIFORM_RANDOM = 'UNIFORM_RANDOM',
  ZIPFIAN = 'ZIPFIAN',
  READ_HEAVY = 'READ_HEAVY',
  WRITE_HEAVY = 'WRITE_HEAVY',
  MIXED = 'MIXED',
  SEQUENTIAL_SCAN = 'SEQUENTIAL_SCAN',
}

export interface WorkloadDefinition {
  type: WorkloadType;
  /** Number of distinct keys the workload draws from. */
  keyspaceSize: number;
  /** Fraction of operations that are reads (GET) vs writes (PUT).
   *  Ignored by SEQUENTIAL_SCAN (always reads) and MIXED (each
   *  component generator has its own ratio). */
  readRatio?: number;
  /** Zipfian skew parameter (theta). Higher = more concentrated on a
   *  small "hot" key set. Only used by ZIPFIAN and READ_HEAVY. */
  zipfianSkew?: number;
  keyPrefix?: string;
}

export interface BenchmarkRunResult {
  name: string;
  workloadType: WorkloadType;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalOperations: number;
  opCounts: { GET: number; PUT: number; DELETE: number };
  errors: number;
  throughputOpsPerSec: number;
  latency: LatencyPercentiles;
  /** Whatever the caller's `captureMetrics` callback returned before
   *  and after the run — left as a loose record rather than the
   *  concrete `MetricsSnapshot`/`ClusterMetricsSummary` type so this
   *  package has no compile-time dependency on exactly which endpoint
   *  supplied it. */
  metricsBefore: Record<string, unknown> | null;
  metricsAfter: Record<string, unknown> | null;
}

export interface PolicyComparisonReport {
  generatedAt: number;
  workloadType: WorkloadType;
  results: BenchmarkRunResult[];
  bestThroughput: string;
  bestP99Latency: string;
  bestHitRatio: string | null;
}

export type PolicyLabel = EvictionPolicyType | 'ADAPTIVE';