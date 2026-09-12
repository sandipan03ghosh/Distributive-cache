import { describe, it, expect } from 'vitest';
import { LfuEvictionPolicy } from '@flowcache/eviction';

describe('LfuEvictionPolicy', () => {
  it('evicts the least frequently used key', () => {
    const lfu = new LfuEvictionPolicy();
    lfu.recordWrite('a');
    lfu.recordWrite('b');
    lfu.recordWrite('c');

    // 'a' and 'c' get extra accesses; 'b' stays at frequency 1.
    lfu.recordAccess('a');
    lfu.recordAccess('a');
    lfu.recordAccess('c');

    expect(lfu.selectVictim(['a', 'b', 'c'])).toBe('b');
  });

  it('moves a key to a higher bucket on each access, changing the victim over time', () => {
    const lfu = new LfuEvictionPolicy();
    lfu.recordWrite('a');
    lfu.recordWrite('b');

    expect(['a', 'b']).toContain(lfu.selectVictim(['a', 'b']));

    lfu.recordAccess('a');
    // 'a' now has frequency 2, 'b' still 1 -> 'b' must be the victim.
    expect(lfu.selectVictim(['a', 'b'])).toBe('b');
  });

  it('recordRemoval() updates minFrequency bookkeeping correctly', () => {
    const lfu = new LfuEvictionPolicy();
    lfu.recordWrite('a');
    lfu.recordWrite('b');
    lfu.recordAccess('a'); // a: freq 2, b: freq 1

    lfu.recordRemoval('b');
    // Only 'a' remains, at frequency 2 — selecting among ['a'] must
    // still return 'a' even though minFrequency was previously 1.
    expect(lfu.selectVictim(['a'])).toBe('a');
  });

  it('seed() initializes frequency from CacheEntry.metadata.frequency', () => {
    const lfu = new LfuEvictionPolicy();
    lfu.seed([
      { key: 'hot', value: 1, metadata: baseMetadata({ frequency: 50 }) },
      { key: 'cold', value: 2, metadata: baseMetadata({ frequency: 1 }) },
    ]);

    expect(lfu.selectVictim(['hot', 'cold'])).toBe('cold');
  });

  it('falls back to a candidate key even if none are tracked yet', () => {
    const lfu = new LfuEvictionPolicy();
    expect(lfu.selectVictim(['untracked'])).toBe('untracked');
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