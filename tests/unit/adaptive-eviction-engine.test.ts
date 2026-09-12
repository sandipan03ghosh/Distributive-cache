import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AdaptiveEvictionEngine } from '@flowcache/eviction';
import { EvictionPolicyType } from '@flowcache/shared';

describe('AdaptiveEvictionEngine', () => {
  it('starts on the configured initial policy', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LFU, evaluationIntervalMs: 0 });
    expect(engine.getCurrentPolicy()).toBe(EvictionPolicyType.LFU);
    engine.dispose();
  });

  it('delegates EvictionHook calls to the active policy', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    engine.recordWrite('a');
    engine.recordWrite('b');
    engine.recordAccess('a');

    // Under LRU, 'b' (untouched since write) should be the victim.
    expect(engine.selectVictim(['a', 'b'])).toBe('b');
    engine.dispose();
  });

  it('forceSwitch() immediately swaps the active policy and emits policySwitch', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    const events: string[] = [];
    engine.on('policySwitch', (event) => events.push(`${event.fromPolicy}->${event.toPolicy}`));

    engine.forceSwitch(EvictionPolicyType.LFU, 'test override');

    expect(engine.getCurrentPolicy()).toBe(EvictionPolicyType.LFU);
    expect(events).toEqual(['LRU->LFU']);
    engine.dispose();
  });

  it('forceSwitch() to the currently active policy is a no-op (no event)', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    const events: unknown[] = [];
    engine.on('policySwitch', (e) => events.push(e));

    engine.forceSwitch(EvictionPolicyType.LRU);
    expect(events).toHaveLength(0);
    engine.dispose();
  });

  it('pauseAutoSwitch() prevents the evaluation loop from changing policy', () => {
    vi.useFakeTimers();
    const engine = new AdaptiveEvictionEngine({
      initialPolicy: EvictionPolicyType.LRU,
      evaluationIntervalMs: 100,
      minSamplesBeforeSwitch: 1,
      cooldownMs: 0,
    });

    // Seed a memory-usage getter that would normally force TINY_LFU.
    engine.attachStorage(
      new EventEmitter(),
      () => 0.95,
      () => [],
    );

    engine.pauseAutoSwitch();
    engine.recordWrite('a'); // generate at least one sample

    vi.advanceTimersByTime(500);
    expect(engine.getCurrentPolicy()).toBe(EvictionPolicyType.LRU);

    engine.dispose();
    vi.useRealTimers();
  });

  it('resumeAutoSwitch() re-enables automatic switching', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    engine.pauseAutoSwitch();
    expect(engine.isAutoSwitchEnabled()).toBe(false);

    engine.resumeAutoSwitch();
    expect(engine.isAutoSwitchEnabled()).toBe(true);

    engine.dispose();
  });

  it('getSwitchHistory() records every forced switch', () => {
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    engine.forceSwitch(EvictionPolicyType.LFU);
    engine.forceSwitch(EvictionPolicyType.TINY_LFU);

    const history = engine.getSwitchHistory();
    expect(history).toHaveLength(2);
    expect(history[0].toPolicy).toBe(EvictionPolicyType.LFU);
    expect(history[1].toPolicy).toBe(EvictionPolicyType.TINY_LFU);

    engine.dispose();
  });
});

describe('AdaptiveEvictionEngine cleanup', () => {
  let engine: AdaptiveEvictionEngine;

  beforeEach(() => {
    engine = new AdaptiveEvictionEngine({ evaluationIntervalMs: 0 });
  });

  afterEach(() => {
    engine.dispose();
  });

  it('dispose() removes all listeners', () => {
    const handler = vi.fn();
    engine.on('policySwitch', handler);
    engine.dispose();
    // After dispose, forceSwitch on a disposed engine still works
    // mechanically (no timers pending) but listeners are gone.
    engine.forceSwitch(EvictionPolicyType.LFU);
    expect(handler).not.toHaveBeenCalled();
  });
});