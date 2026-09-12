/**
 * @flowcache/eviction — LFU.ts
 *
 * Least-Frequently-Used policy implemented with the classic O(1) LFU
 * bucket structure: a Map<key, frequency> plus a Map<frequency,
 * Set<key>> of buckets, and a running `minFrequency` pointer so both
 * "bump a key's frequency" and "find the current victim" are O(1)
 * amortized (selecting a victim from a bucket is O(1); only
 * re-deriving the sorted bucket list on a rare fallback path is O(b)
 * in the number of distinct frequencies, which is small in practice).
 */

import { EvictionPolicyType, type CacheEntry, type CacheKey } from '@flowcache/shared';
import type { EvictionPolicy } from './EvictionPolicy.js';

export class LfuEvictionPolicy implements EvictionPolicy {
  readonly type = EvictionPolicyType.LFU;

  private readonly frequency = new Map<CacheKey, number>();
  private readonly buckets = new Map<number, Set<CacheKey>>();
  private minFrequency = 0;

  recordAccess(key: CacheKey): void {
    this.bump(key);
  }

  recordWrite(key: CacheKey): void {
    if (this.frequency.has(key)) {
      this.bump(key);
    } else {
      this.initialize(key);
    }
  }

  recordRemoval(key: CacheKey): void {
    const freq = this.frequency.get(key);
    if (freq === undefined) return;
    this.frequency.delete(key);
    const bucket = this.buckets.get(freq);
    bucket?.delete(key);
    if (bucket && bucket.size === 0) {
      this.buckets.delete(freq);
      if (this.minFrequency === freq) {
        this.minFrequency = this.lowestRemainingFrequency();
      }
    }
  }

  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null {
    if (candidateKeys.length === 0) return null;
    const candidateSet = new Set(candidateKeys);

    // Fast path: the minFrequency bucket usually contains a valid
    // candidate since writes/removals keep it in sync.
    const fastBucket = this.buckets.get(this.minFrequency);
    if (fastBucket) {
      for (const key of fastBucket) {
        if (candidateSet.has(key)) return key;
      }
    }

    // Fallback: walk buckets in ascending frequency order. Needed if
    // the candidate set (live storage keys) has drifted slightly from
    // this policy's bookkeeping (e.g. right after a policy switch).
    const sortedFrequencies = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const freq of sortedFrequencies) {
      const bucket = this.buckets.get(freq);
      if (!bucket) continue;
      for (const key of bucket) {
        if (candidateSet.has(key)) return key;
      }
    }

    // Last resort: nothing tracked matches; evict an arbitrary
    // candidate rather than refusing to make room at all.
    return candidateKeys[0];
  }

  reset(): void {
    this.frequency.clear();
    this.buckets.clear();
    this.minFrequency = 0;
  }

  seed(entries: readonly CacheEntry[]): void {
    this.reset();
    for (const entry of entries) {
      const freq = Math.max(1, entry.metadata.frequency || 1);
      this.frequency.set(entry.key, freq);
      this.addToBucket(freq, entry.key);
    }
    this.minFrequency = this.lowestRemainingFrequency();
  }

  size(): number {
    return this.frequency.size;
  }

  // ---------------------------------------------------------------------
  // Internal bucket mechanics
  // ---------------------------------------------------------------------

  private initialize(key: CacheKey): void {
    this.frequency.set(key, 1);
    this.addToBucket(1, key);
    this.minFrequency = 1;
  }

  private bump(key: CacheKey): void {
    const oldFreq = this.frequency.get(key) ?? 0;
    const newFreq = oldFreq + 1;
    this.frequency.set(key, newFreq);

    if (oldFreq > 0) {
      const oldBucket = this.buckets.get(oldFreq);
      oldBucket?.delete(key);
      if (oldBucket && oldBucket.size === 0) {
        this.buckets.delete(oldFreq);
        if (this.minFrequency === oldFreq) {
          this.minFrequency = newFreq;
        }
      }
    } else {
      this.minFrequency = Math.min(this.minFrequency || newFreq, newFreq);
    }

    this.addToBucket(newFreq, key);
  }

  private addToBucket(freq: number, key: CacheKey): void {
    let bucket = this.buckets.get(freq);
    if (!bucket) {
      bucket = new Set<CacheKey>();
      this.buckets.set(freq, bucket);
    }
    bucket.add(key);
  }

  private lowestRemainingFrequency(): number {
    if (this.buckets.size === 0) return 0;
    let min = Infinity;
    for (const freq of this.buckets.keys()) {
      if (freq < min) min = freq;
    }
    return min === Infinity ? 0 : min;
  }
}