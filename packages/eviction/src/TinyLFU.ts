/**
 * @flowcache/eviction — TinyLFU.ts
 *
 * Simplified TinyLFU. The full W-TinyLFU design (Caffeine/Guava-style)
 * splits the cache into an admission window plus probationary/protected
 * SLRU segments guarded by a Bloom-filter doorkeeper in front of a
 * Count-Min Sketch. That's a lot of moving parts for what is, at its
 * core, one idea: "don't evict based on recency alone — among the
 * least-recently-used keys, prefer to evict the one that's also least
 * *frequently* used, so a single one-off scan doesn't evict something
 * genuinely popular."
 *
 * This implementation captures that core idea directly:
 *   - Recency ordering comes from composing `LruEvictionPolicy` (reused,
 *     not reimplemented).
 *   - Frequency estimation comes from a `CountMinSketch` (bounded
 *     memory, from scratch, with periodic aging).
 *   - `selectVictim` looks at the bottom-K least-recently-used
 *     candidates and evicts whichever of them has the lowest estimated
 *     frequency, rather than blindly evicting the single LRU tail.
 *
 * This makes TinyLFU meaningfully scan-resistant (a burst of one-off
 * keys can't evict a hot key that merely wasn't touched in the last
 * few requests) while staying O(K) per eviction, K small and fixed.
 */

import { EvictionPolicyType, type CacheEntry, type CacheKey } from '@flowcache/shared';
import type { EvictionPolicy } from './EvictionPolicy.js';
import { LruEvictionPolicy } from './LRU.js';
import { CountMinSketch } from './CountMinSketch.js';

const DEFAULT_BOTTOM_K = 5;

export class TinyLfuEvictionPolicy implements EvictionPolicy {
  readonly type = EvictionPolicyType.TINY_LFU;

  private readonly recency = new LruEvictionPolicy();
  private readonly sketch: CountMinSketch;
  private readonly bottomK: number;

  constructor(bottomK: number = DEFAULT_BOTTOM_K, sketch?: CountMinSketch) {
    this.bottomK = bottomK;
    this.sketch = sketch ?? new CountMinSketch();
  }

  recordAccess(key: CacheKey): void {
    this.recency.recordAccess(key);
    this.sketch.increment(key);
  }

  recordWrite(key: CacheKey): void {
    this.recency.recordWrite(key);
    this.sketch.increment(key);
  }

  recordRemoval(key: CacheKey): void {
    this.recency.recordRemoval(key);
    // The sketch intentionally has no decrement: Count-Min Sketch is a
    // one-directional summary structure. Removed keys' counts simply
    // decay away over time via periodic aging in the sketch itself.
  }

  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null {
    const bottomCandidates = this.recency.leastRecentlyUsedCandidates(candidateKeys, this.bottomK);
    if (bottomCandidates.length === 0) {
      // Recency list is empty or out of sync with storage — fall back
      // to whatever the LRU composition itself decides (single tail).
      return this.recency.selectVictim(candidateKeys);
    }

    let victim = bottomCandidates[0];
    let victimFreq = this.sketch.estimate(victim);
    for (let i = 1; i < bottomCandidates.length; i++) {
      const candidate = bottomCandidates[i];
      const freq = this.sketch.estimate(candidate);
      if (freq < victimFreq) {
        victim = candidate;
        victimFreq = freq;
      }
    }
    return victim;
  }

  reset(): void {
    this.recency.reset();
    this.sketch.reset();
  }

  seed(entries: readonly CacheEntry[]): void {
    this.recency.seed(entries);
    this.sketch.reset();
    for (const entry of entries) {
      // Replay a bounded number of increments proportional to observed
      // frequency so the sketch starts with a reasonable approximation
      // rather than all-zero counts (capped to keep seeding O(entries)
      // rather than O(entries * frequency) for very hot keys).
      const replayCount = Math.min(Math.max(1, entry.metadata.frequency), 32);
      for (let i = 0; i < replayCount; i++) {
        this.sketch.increment(entry.key);
      }
    }
  }

  size(): number {
    return this.recency.size();
  }
}