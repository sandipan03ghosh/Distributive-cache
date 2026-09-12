/**
 * @flowcache/eviction — EvictionPolicy.ts
 *
 * The common interface every eviction policy implements. It extends
 * `EvictionHook` (defined in @flowcache/storage-engine) so any policy
 * here can be handed directly to `new StorageEngine({ evictionHook })`.
 *
 *          EvictionPolicy
 *                |
 *      ----------+-----------
 *      |         |          |
 *     LRU       LFU      TinyLFU
 *
 * `AdaptiveEvictionEngine` also implements this interface, wrapping
 * whichever concrete policy is currently active and transparently
 * swapping it out at runtime.
 */

import type { CacheEntry, CacheKey, EvictionPolicyType } from '@flowcache/shared';
import type { EvictionHook } from '@flowcache/storage-engine';

export interface EvictionPolicy extends EvictionHook {
  readonly type: EvictionPolicyType;

  /** Clears all internal bookkeeping (recency lists, frequency tables,
   *  sketches, etc.) without touching the storage engine itself. */
  reset(): void;

  /** Seeds internal bookkeeping from a full snapshot of current cache
   *  entries. Called whenever a policy is freshly instantiated to take
   *  over from a different active policy, so it starts with a
   *  reasonable approximation of recency/frequency instead of a blank
   *  slate (which would otherwise evict essentially at random for a
   *  while after every switch). */
  seed(entries: readonly CacheEntry[]): void;

  /** Number of keys this policy is currently tracking. Exposed mainly
   *  for tests and diagnostics. */
  size(): number;
}

export type { CacheKey };