/**
 * @flowcache/eviction — DecisionRules.ts
 *
 * The deterministic, rule-based heuristics that decide which eviction
 * policy best fits the currently observed workload. Deliberately NOT
 * machine learning — every rule is a simple, explainable threshold so
 * behavior is predictable and easy to benchmark / reason about.
 *
 * Rules are evaluated in priority order (first match wins):
 *   1. Memory pressure is a safety concern above all else -> TinyLFU
 *      (scan-resistant AND frequency-aware, the safest general choice
 *      when the cache is nearly full and every eviction decision
 *      matters).
 *   2. A detected sequential scan -> LRU (keeps the scan's own working
 *      set coherent by recency rather than fragmenting decisions
 *      across a frequency table that a one-pass scan will never
 *      revisit).
 *   3. Read-heavy traffic with a skewed (non-uniform) popularity
 *      distribution -> LFU (a small number of genuinely hot keys
 *      benefit from being protected purely by long-run frequency).
 *   4. Write-heavy traffic -> LRU (recency is the best proxy for "will
 *      be read again soon" when the workload is dominated by churn).
 *   5. No signal clearly dominates -> TinyLFU as the general-purpose
 *      default (this is FlowCache's own tie-break choice, not part of
 *      the four example mappings above).
 *
 * Kept as pure functions (no class, no state) so it's trivial to unit
 * test and to reuse from the benchmark engine to score how well the
 * adaptive engine's choices line up with a workload's known shape.
 */

import { EvictionPolicyType, type WorkloadSignals } from '@flowcache/shared';

export interface PolicyDecision {
  policy: EvictionPolicyType;
  reason: string;
}

const MEMORY_PRESSURE_THRESHOLD = 0.85;
const SEQUENTIAL_SCORE_THRESHOLD = 0.5;
const READ_HEAVY_THRESHOLD = 0.7;
const FREQUENCY_SKEW_THRESHOLD = 0.4;
const WRITE_HEAVY_THRESHOLD = 0.6;

export function decidePolicy(signals: WorkloadSignals): PolicyDecision {
  if (signals.memoryUsageRatio >= MEMORY_PRESSURE_THRESHOLD) {
    return {
      policy: EvictionPolicyType.TINY_LFU,
      reason: `memory usage ${(signals.memoryUsageRatio * 100).toFixed(1)}% >= ${(
        MEMORY_PRESSURE_THRESHOLD * 100
      ).toFixed(0)}% threshold — switching to TinyLFU for scan-resistant, frequency-aware eviction under pressure`,
    };
  }

  if (signals.sequentialAccessScore >= SEQUENTIAL_SCORE_THRESHOLD) {
    return {
      policy: EvictionPolicyType.LRU,
      reason: `sequential access score ${(signals.sequentialAccessScore * 100).toFixed(
        1,
      )}% indicates a scan pattern — switching to LRU`,
    };
  }

  if (signals.readRatio >= READ_HEAVY_THRESHOLD && signals.frequencySkew >= FREQUENCY_SKEW_THRESHOLD) {
    return {
      policy: EvictionPolicyType.LFU,
      reason: `read-heavy workload (${(signals.readRatio * 100).toFixed(1)}% reads) with skewed key popularity (Gini ${signals.frequencySkew.toFixed(
        2,
      )}) — switching to LFU to protect hot keys`,
    };
  }

  if (signals.writeRatio >= WRITE_HEAVY_THRESHOLD) {
    return {
      policy: EvictionPolicyType.LRU,
      reason: `write-heavy workload (${(signals.writeRatio * 100).toFixed(
        1,
      )}% writes) — switching to LRU to prioritize recency over historical frequency`,
    };
  }

  return {
    policy: EvictionPolicyType.TINY_LFU,
    reason: 'no single workload signal dominates — defaulting to TinyLFU as a balanced, scan-resistant policy',
  };
}