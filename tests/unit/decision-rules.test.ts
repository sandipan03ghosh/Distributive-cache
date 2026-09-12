import { describe, it, expect } from 'vitest';
import { decidePolicy } from '@flowcache/eviction';
import { EvictionPolicyType, type WorkloadSignals } from '@flowcache/shared';

function signals(overrides: Partial<WorkloadSignals>): WorkloadSignals {
  return {
    hitRate: 0.5,
    missRate: 0.5,
    memoryUsageRatio: 0.3,
    writeRatio: 0.3,
    readRatio: 0.7,
    frequencySkew: 0.2,
    sequentialAccessScore: 0,
    workingSetSizeRatio: 0.5,
    windowSampleCount: 1000,
    ...overrides,
  };
}

describe('decidePolicy', () => {
  it('picks TINY_LFU under high memory pressure regardless of other signals', () => {
    const decision = decidePolicy(signals({ memoryUsageRatio: 0.9, sequentialAccessScore: 0.9 }));
    expect(decision.policy).toBe(EvictionPolicyType.TINY_LFU);
  });

  it('picks LRU when a sequential scan is detected', () => {
    const decision = decidePolicy(signals({ sequentialAccessScore: 0.75 }));
    expect(decision.policy).toBe(EvictionPolicyType.LRU);
  });

  it('picks LFU for read-heavy, skewed-popularity workloads', () => {
    const decision = decidePolicy(signals({ readRatio: 0.9, frequencySkew: 0.6 }));
    expect(decision.policy).toBe(EvictionPolicyType.LFU);
  });

  it('picks LRU for write-heavy workloads', () => {
    const decision = decidePolicy(signals({ writeRatio: 0.8, readRatio: 0.2, frequencySkew: 0.1 }));
    expect(decision.policy).toBe(EvictionPolicyType.LRU);
  });

  it('defaults to TINY_LFU when no signal dominates', () => {
    const decision = decidePolicy(
      signals({ memoryUsageRatio: 0.2, sequentialAccessScore: 0, readRatio: 0.5, writeRatio: 0.5, frequencySkew: 0.1 }),
    );
    expect(decision.policy).toBe(EvictionPolicyType.TINY_LFU);
  });

  it('always includes a human-readable reason', () => {
    const decision = decidePolicy(signals({}));
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});