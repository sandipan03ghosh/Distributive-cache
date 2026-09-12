import { describe, it, expect } from 'vitest';
import { StorageEngine } from '@flowcache/storage-engine';
import { AdaptiveEvictionEngine } from '@flowcache/eviction';
import { EvictionPolicyType } from '@flowcache/shared';

describe('storage + eviction stress', () => {
  it('stays within maxSizeBytes under sustained high-volume writes', () => {
    const maxSizeBytes = 200_000;
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    const storage = new StorageEngine({ maxSizeBytes, evictionHook: engine, activeSweepIntervalMs: 0 });
    engine.attachStorage(
      storage,
      () => storage.sizeBytes() / maxSizeBytes,
      () => [...storage.entries()],
    );

    const TOTAL_WRITES = 20_000;
    for (let i = 0; i < TOTAL_WRITES; i++) {
      storage.set(`key:${i}`, { payload: 'x'.repeat(20), i });
    }

    expect(storage.sizeBytes()).toBeLessThanOrEqual(maxSizeBytes);
    expect(storage.getStats().evictions).toBeGreaterThan(0);
    // Sanity: we didn't evict literally everything — some working set survives.
    expect(storage.size()).toBeGreaterThan(0);

    storage.dispose();
    engine.dispose();
  });

  it('survives rapid forced policy switches mid-write-storm without throwing', () => {
    const maxSizeBytes = 100_000;
    const engine = new AdaptiveEvictionEngine({ initialPolicy: EvictionPolicyType.LRU, evaluationIntervalMs: 0 });
    const storage = new StorageEngine({ maxSizeBytes, evictionHook: engine, activeSweepIntervalMs: 0 });
    engine.attachStorage(
      storage,
      () => storage.sizeBytes() / maxSizeBytes,
      () => [...storage.entries()],
    );

    const policies = [EvictionPolicyType.LRU, EvictionPolicyType.LFU, EvictionPolicyType.TINY_LFU];

    expect(() => {
      for (let i = 0; i < 10_000; i++) {
        storage.set(`key:${i % 500}`, { i });
        if (i % 200 === 0) {
          engine.forceSwitch(policies[(i / 200) % policies.length]);
        }
        if (i % 50 === 0) {
          storage.get(`key:${i % 500}`);
        }
      }
    }).not.toThrow();

    expect(storage.sizeBytes()).toBeLessThanOrEqual(maxSizeBytes);

    storage.dispose();
    engine.dispose();
  });

  it('a mix of TTL-expiring and permanent keys under load never leaves storage in an inconsistent state', () => {
    const storage = new StorageEngine({ maxEntries: 5000, activeSweepIntervalMs: 0 });

    for (let i = 0; i < 15_000; i++) {
      const ttlMs = i % 3 === 0 ? 1 : undefined; // roughly a third expire almost immediately
      storage.set(`key:${i}`, i, { ttlMs });
    }

    const swept = storage.sweepExpired();
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(storage.size()).toBeLessThanOrEqual(5000);
    expect(storage.getStats().entryCount).toBe(storage.size());

    storage.dispose();
  });
});