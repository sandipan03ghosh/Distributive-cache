/**
 * @flowcache/storage-engine — StorageEngine.ts
 *
 * A from-scratch in-memory key/value store providing:
 *   - O(1) get/set/delete via a native Map (used purely as a hashmap;
 *     no external cache library is used anywhere in this file)
 *   - Per-entry TTL / expiration (lazy on read + optional active sweep)
 *   - Rich per-entry metadata: version, created/updated/accessed
 *     timestamps, access frequency, approximate size
 *   - Global statistics: hits, misses, expirations, evictions, writes,
 *     deletes
 *   - A pluggable eviction seam (`EvictionHook`) so `packages/eviction`
 *     can drive which key gets evicted under memory/entry-count
 *     pressure, without this file importing any eviction policy.
 *
 * Concurrency note: Node.js is single-threaded per event-loop tick, so
 * this Map-based engine does not need internal locking for correctness
 * within one process. Cache nodes shard state across worker threads by
 * giving each worker its own StorageEngine instance and partitioning
 * keys — there is no shared-memory mutation across threads.
 */

import { EventEmitter } from 'node:events';
import {
  type CacheEntry,
  type CacheKey,
  type CacheMetadata,
  type StorageStats,
  ValidationError,
  approximateSizeBytes,
  nowMs,
} from '@flowcache/shared';
import type { EvictionHook, IStorageEngine, SetOptions, StorageEngineOptions } from './types.js';
import { DEFAULT_STORAGE_ENGINE_OPTIONS } from './types.js';

export type StorageEngineEvent = 'hit' | 'miss' | 'write' | 'delete' | 'expire' | 'evict';

/**
 * Default eviction hook used when no policy from `packages/eviction` is
 * injected. Falls back to naive FIFO using Map insertion order, so the
 * engine is fully functional standalone (e.g. in unit tests).
 */
class FifoEvictionHook implements EvictionHook {
  recordAccess(): void {
    /* no-op: FIFO doesn't care about access recency */
  }
  recordWrite(): void {
    /* no-op: Map already tracks insertion order */
  }
  recordRemoval(): void {
    /* no-op */
  }
  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null {
    return candidateKeys.length > 0 ? candidateKeys[0] : null;
  }
}

export class StorageEngine<V = unknown> extends EventEmitter implements IStorageEngine<V> {
  private readonly store = new Map<CacheKey, CacheEntry<V>>();
  private readonly options: StorageEngineOptions;
  private readonly evictionHook: EvictionHook;
  private sweepTimer: NodeJS.Timeout | null = null;
  private totalSizeBytes = 0;

  private stats: StorageStats = {
    entryCount: 0,
    totalSizeBytes: 0,
    hits: 0,
    misses: 0,
    expirations: 0,
    evictions: 0,
    writes: 0,
    deletes: 0,
  };

  constructor(options: Partial<StorageEngineOptions> = {}) {
    super();
    this.options = { ...DEFAULT_STORAGE_ENGINE_OPTIONS, ...options };
    this.evictionHook = this.options.evictionHook ?? new FifoEvictionHook();

    if (this.options.activeSweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), this.options.activeSweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  set(key: CacheKey, value: V, options: SetOptions = {}): CacheEntry<V> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new ValidationError('Cache key must be a non-empty string');
    }

    const now = nowMs();
    const sizeBytes = approximateSizeBytes(value);
    const ttlMs = options.ttlMs !== undefined ? options.ttlMs : this.options.defaultTtlMs;
    const expiresAt = ttlMs !== null && ttlMs !== undefined ? now + ttlMs : null;

    const existing = this.store.get(key);
    const metadata: CacheMetadata = existing
      ? {
          ...existing.metadata,
          version: existing.metadata.version + 1,
          updatedAt: now,
          expiresAt,
          sizeBytes,
        }
      : {
          version: 1,
          createdAt: now,
          updatedAt: now,
          lastAccessedAt: now,
          frequency: 0,
          expiresAt,
          sizeBytes,
        };

    if (existing) {
      this.totalSizeBytes -= existing.metadata.sizeBytes;
    }

    const entry: CacheEntry<V> = { key, value, metadata };
    this.store.set(key, entry);
    this.totalSizeBytes += sizeBytes;

    this.evictionHook.recordWrite(key);
    this.stats.writes += 1;
    this.emit('write', key);

    this.enforceCapacity(key);

    return entry;
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  /** Standard read: updates recency/frequency metadata and counts
   *  towards hit/miss stats. This is what request handling should use. */
  get(key: CacheKey): CacheEntry<V> | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses += 1;
      this.emit('miss', key);
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.removeInternal(key, 'expire');
      this.stats.misses += 1;
      this.emit('miss', key);
      return undefined;
    }

    entry.metadata.lastAccessedAt = nowMs();
    entry.metadata.frequency += 1;
    this.evictionHook.recordAccess(key);

    this.stats.hits += 1;
    this.emit('hit', key);
    return entry;
  }

  /** Read without side effects (no recency/frequency bump, no hit/miss
   *  counting). Used by the snapshot manager and benchmark inspector so
   *  observing the cache doesn't itself change eviction behavior. */
  peek(key: CacheKey): CacheEntry<V> | undefined {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) return undefined;
    return entry;
  }

  has(key: CacheKey): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.removeInternal(key, 'expire');
      return false;
    }
    return true;
  }

  getMetadata(key: CacheKey): CacheMetadata | undefined {
    return this.peek(key)?.metadata;
  }

  // -------------------------------------------------------------------
  // Deletes
  // -------------------------------------------------------------------

  delete(key: CacheKey): boolean {
    const existed = this.store.has(key);
    if (existed) {
      this.removeInternal(key, 'delete');
      this.stats.deletes += 1;
    }
    return existed;
  }

  clear(): void {
    this.store.clear();
    this.totalSizeBytes = 0;
  }

  // -------------------------------------------------------------------
  // Enumeration
  // -------------------------------------------------------------------

  keys(): IterableIterator<CacheKey> {
    return this.store.keys();
  }

  entries(): IterableIterator<CacheEntry<V>> {
    return this.store.values();
  }

  size(): number {
    return this.store.size;
  }

  sizeBytes(): number {
    return this.totalSizeBytes;
  }

  // -------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------

  getStats(): StorageStats {
    return {
      ...this.stats,
      entryCount: this.store.size,
      totalSizeBytes: this.totalSizeBytes,
    };
  }

  // -------------------------------------------------------------------
  // TTL / expiration
  // -------------------------------------------------------------------

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.metadata.expiresAt !== null && entry.metadata.expiresAt <= nowMs();
  }

  /** Actively scans for and removes expired entries. Runs on an interval
   *  timer (see constructor) in addition to lazy expiration-on-read, so
   *  memory used by cold, expired keys is reclaimed even if nobody reads
   *  them again. */
  sweepExpired(): number {
    const now = nowMs();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.metadata.expiresAt !== null && entry.metadata.expiresAt <= now) {
        this.removeInternal(key, 'expire');
        removed += 1;
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------
  // Capacity enforcement / eviction
  // -------------------------------------------------------------------

  private enforceCapacity(justWrittenKey: CacheKey): void {
    let guard = 0;
    while (
      (this.store.size > this.options.maxEntries || this.totalSizeBytes > this.options.maxSizeBytes) &&
      guard < this.store.size + 1
    ) {
      guard += 1;
      const candidates = [...this.store.keys()].filter((k) => k !== justWrittenKey || this.store.size === 1);
      const victim = this.evictionHook.selectVictim(candidates);
      if (victim === null || victim === undefined) break;
      this.removeInternal(victim, 'evict');
      this.stats.evictions += 1;
    }
  }

  private removeInternal(key: CacheKey, reason: 'delete' | 'expire' | 'evict'): void {
    const entry = this.store.get(key);
    if (!entry) return;
    this.store.delete(key);
    this.totalSizeBytes -= entry.metadata.sizeBytes;
    this.evictionHook.recordRemoval(key);
    if (reason === 'expire') {
      this.stats.expirations += 1;
      this.emit('expire', key);
    } else if (reason === 'evict') {
      this.emit('evict', key);
    } else {
      this.emit('delete', key);
    }
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.removeAllListeners();
    this.clear();
  }
}