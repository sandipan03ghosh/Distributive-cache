/**
 * @flowcache/storage-engine — types.ts
 *
 * The storage engine owns the hashmap, TTL, and metadata. It has zero
 * knowledge of *which* eviction policy is active — that decision is
 * delegated through the `EvictionHook` seam so `packages/eviction` can
 * plug in LRU / LFU / TinyLFU / Adaptive without the storage engine
 * depending on any of them (avoids a circular package dependency).
 */

import type { CacheKey, CacheEntry, CacheMetadata, StorageStats } from '@flowcache/shared';

/**
 * Implemented by whatever eviction policy is currently active (see
 * `packages/eviction`). The storage engine calls these hooks on every
 * read/write/removal so the policy can maintain its own bookkeeping
 * (recency lists, frequency sketches, etc.), and calls `selectVictim`
 * only when capacity has actually been exceeded.
 */
export interface EvictionHook {
  recordAccess(key: CacheKey): void;
  recordWrite(key: CacheKey): void;
  recordRemoval(key: CacheKey): void;
  /** Given the full set of currently-held keys, return the key that
   *  should be evicted next, or null if no sensible victim exists
   *  (e.g. store is empty). */
  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null;
}

export interface StorageEngineOptions {
  /** Hard cap on number of entries. Use Infinity to disable. */
  maxEntries: number;
  /** Hard cap on total approximate size in bytes. Use Infinity to disable. */
  maxSizeBytes: number;
  /** Default TTL applied to writes that don't specify their own, or
   *  null for "no expiration by default". */
  defaultTtlMs: number | null;
  /** Optional eviction policy hook. If omitted, the engine falls back
   *  to naive FIFO (oldest insertion order) eviction so it still works
   *  standalone / in unit tests without the eviction package wired in. */
  evictionHook?: EvictionHook;
  /** How often to actively sweep for expired keys, in ms. Lazy
   *  expiration (checked on read) always happens regardless; this sweep
   *  additionally reclaims memory for keys nobody has read since they
   *  expired. Set to 0 to disable the background sweep entirely. */
  activeSweepIntervalMs: number;
}

export const DEFAULT_STORAGE_ENGINE_OPTIONS: StorageEngineOptions = {
  maxEntries: Infinity,
  maxSizeBytes: Infinity,
  defaultTtlMs: null,
  activeSweepIntervalMs: 30_000,
};

export interface SetOptions {
  ttlMs?: number | null;
}

/**
 * Repository-style interface over the storage engine. `services/cache-node`
 * depends on this abstraction (not the concrete class) so it can be
 * swapped or mocked in tests.
 */
export interface IStorageEngine<V = unknown> {
  set(key: CacheKey, value: V, options?: SetOptions): CacheEntry<V>;
  get(key: CacheKey): CacheEntry<V> | undefined;
  peek(key: CacheKey): CacheEntry<V> | undefined;
  has(key: CacheKey): boolean;
  delete(key: CacheKey): boolean;
  clear(): void;
  keys(): IterableIterator<CacheKey>;
  entries(): IterableIterator<CacheEntry<V>>;
  size(): number;
  sizeBytes(): number;
  getMetadata(key: CacheKey): CacheMetadata | undefined;
  getStats(): StorageStats;
  dispose(): void;
}