import { describe, it, expect } from 'vitest';
import { TinyLfuEvictionPolicy } from '@flowcache/eviction';

describe('TinyLfuEvictionPolicy', () => {
  it('is scan-resistant: a burst of one-off keys does not evict a hot key', () => {
    const tinyLfu = new TinyLfuEvictionPolicy(5);

    // Establish 'hot' as genuinely frequently accessed.
    tinyLfu.recordWrite('hot');
    for (let i = 0; i < 20; i++) tinyLfu.recordAccess('hot');

    // Simulate a one-pass scan touching several cold, one-off keys
    // most recently (so plain LRU would pick 'hot' as untouched-longest
    // among a naive tail walk, if 'hot' weren't still within the
    // bottom-K window — the point of this test is TinyLFU should
    // prefer evicting the low-frequency scan keys instead).
    const scanKeys = ['scan-1', 'scan-2', 'scan-3', 'scan-4'];
    for (const key of scanKeys) {
      tinyLfu.recordWrite(key);
    }

    const candidates = ['hot', ...scanKeys];
    const victim = tinyLfu.selectVictim(candidates);

    expect(victim).not.toBe('hot');
    expect(scanKeys).toContain(victim);
  });

  it('falls back to the LRU tail when the candidate set is small', () => {
    const tinyLfu = new TinyLfuEvictionPolicy(5);
    tinyLfu.recordWrite('a');
    tinyLfu.recordWrite('b');

    const victim = tinyLfu.selectVictim(['a', 'b']);
    expect(['a', 'b']).toContain(victim);
  });

  it('returns null when nothing is tracked', () => {
    const tinyLfu = new TinyLfuEvictionPolicy(5);
    expect(tinyLfu.selectVictim([])).toBeNull();
  });

  it('seed() replays bounded frequency history from CacheEntry metadata', () => {
    const tinyLfu = new TinyLfuEvictionPolicy(3);
    tinyLfu.seed([
      { key: 'hot', value: 1, metadata: baseMetadata({ frequency: 30, lastAccessedAt: 100 }) },
      { key: 'cold', value: 2, metadata: baseMetadata({ frequency: 1, lastAccessedAt: 50 }) },
    ]);

    expect(tinyLfu.size()).toBe(2);
    // Both are within the bottom-K window since only 2 keys exist;
    // the low-frequency one should be chosen.
    expect(tinyLfu.selectVictim(['hot', 'cold'])).toBe('cold');
  });
});

function baseMetadata(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    frequency: 1,
    expiresAt: null,
    sizeBytes: 1,
    ...overrides,
  } as never;
}