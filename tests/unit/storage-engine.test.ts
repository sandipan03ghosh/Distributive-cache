import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StorageEngine } from '@flowcache/storage-engine';
import type { EvictionHook } from '@flowcache/storage-engine';

describe('StorageEngine', () => {
  it('stores and retrieves a value, bumping version on overwrite', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    const first = store.set('k1', { a: 1 });
    expect(first.metadata.version).toBe(1);

    const second = store.set('k1', { a: 2 });
    expect(second.metadata.version).toBe(2);
    expect(store.get('k1')?.value).toEqual({ a: 2 });

    store.dispose();
  });

  it('returns undefined and counts a miss for a nonexistent key', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    expect(store.get('missing')).toBeUndefined();
    expect(store.getStats().misses).toBe(1);
    store.dispose();
  });

  it('expires entries by TTL on read (lazy expiration)', () => {
    vi.useFakeTimers();
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    store.set('k1', 'v1', { ttlMs: 100 });

    expect(store.get('k1')?.value).toBe('v1');

    vi.advanceTimersByTime(101);
    expect(store.get('k1')).toBeUndefined();
    expect(store.getStats().expirations).toBe(1);

    store.dispose();
    vi.useRealTimers();
  });

  it('sweepExpired() actively reclaims expired entries without a read', () => {
    vi.useFakeTimers();
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    store.set('k1', 'v1', { ttlMs: 50 });
    store.set('k2', 'v2'); // no TTL

    vi.advanceTimersByTime(51);
    const removed = store.sweepExpired();

    expect(removed).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.peek('k2')).toBeDefined();

    store.dispose();
    vi.useRealTimers();
  });

  it('peek() does not affect hit/miss stats or recency/frequency', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    store.set('k1', 'v1');
    const before = store.peek('k1')!.metadata.frequency;
    store.peek('k1');
    const after = store.peek('k1')!.metadata.frequency;

    expect(before).toBe(after);
    expect(store.getStats().hits).toBe(0);
    expect(store.getStats().misses).toBe(0);

    store.dispose();
  });

  it('evicts via the injected EvictionHook once maxEntries is exceeded', () => {
    const selectVictim = vi.fn((keys: readonly string[]) => keys[0] ?? null);
    const hook: EvictionHook = {
      recordAccess: vi.fn(),
      recordWrite: vi.fn(),
      recordRemoval: vi.fn(),
      selectVictim,
    };

    const store = new StorageEngine({ maxEntries: 2, evictionHook: hook, activeSweepIntervalMs: 0 });
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3); // should trigger one eviction

    expect(store.size()).toBe(2);
    expect(store.getStats().evictions).toBe(1);
    expect(selectVictim).toHaveBeenCalled();

    store.dispose();
  });

  it('falls back to FIFO eviction when no hook is provided', () => {
    const store = new StorageEngine({ maxEntries: 2, activeSweepIntervalMs: 0 });
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);

    // 'a' was inserted first and should be the FIFO victim.
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);

    store.dispose();
  });

  it('delete() removes an entry and reports whether it existed', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    store.set('k1', 'v1');

    expect(store.delete('k1')).toBe(true);
    expect(store.delete('k1')).toBe(false);
    expect(store.getStats().deletes).toBe(1);

    store.dispose();
  });

  it('rejects an empty-string key', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 0 });
    expect(() => store.set('', 'v')).toThrow();
    store.dispose();
  });
});

describe('StorageEngine background sweep timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs sweepExpired automatically on the configured interval', () => {
    const store = new StorageEngine({ activeSweepIntervalMs: 1000 });
    store.set('k1', 'v1', { ttlMs: 10 });

    vi.advanceTimersByTime(1001);
    expect(store.peek('k1')).toBeUndefined();

    store.dispose();
  });
});