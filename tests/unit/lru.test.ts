import { describe, it, expect } from 'vitest';
import { LruEvictionPolicy } from '@flowcache/eviction';

describe('LruEvictionPolicy', () => {
  it('evicts the least recently used key first', () => {
    const lru = new LruEvictionPolicy();
    lru.recordWrite('a');
    lru.recordWrite('b');
    lru.recordWrite('c');

    // Touch 'a' so it's no longer the least recently used.
    lru.recordAccess('a');

    const victim = lru.selectVictim(['a', 'b', 'c']);
    expect(victim).toBe('b');
  });

  it('only considers keys present in the candidate set', () => {
    const lru = new LruEvictionPolicy();
    lru.recordWrite('a');
    lru.recordWrite('b');
    lru.recordWrite('c');

    // 'a' is the actual LRU tail, but it's not a valid candidate here.
    const victim = lru.selectVictim(['b', 'c']);
    expect(victim).toBe('b');
  });

  it('returns null when there are no tracked keys', () => {
    const lru = new LruEvictionPolicy();
    expect(lru.selectVictim(['x'])).toBeNull();
  });

  it('recordRemoval() stops tracking a key', () => {
    const lru = new LruEvictionPolicy();
    lru.recordWrite('a');
    lru.recordWrite('b');
    lru.recordRemoval('a');

    expect(lru.size()).toBe(1);
    expect(lru.selectVictim(['a', 'b'])).toBe('b');
  });

  it('seed() orders entries by lastAccessedAt ascending (oldest first)', () => {
    const lru = new LruEvictionPolicy();
    lru.seed([
      { key: 'old', value: 1, metadata: baseMetadata({ lastAccessedAt: 100 }) },
      { key: 'new', value: 2, metadata: baseMetadata({ lastAccessedAt: 200 }) },
    ]);

    expect(lru.selectVictim(['old', 'new'])).toBe('old');
  });

  it('leastRecentlyUsedCandidates() returns multiple keys in LRU-to-MRU order', () => {
    const lru = new LruEvictionPolicy();
    lru.recordWrite('a');
    lru.recordWrite('b');
    lru.recordWrite('c');

    expect(lru.leastRecentlyUsedCandidates(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
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