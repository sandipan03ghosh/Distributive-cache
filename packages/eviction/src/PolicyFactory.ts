/**
 * @flowcache/eviction — PolicyFactory.ts
 *
 * Single place that maps `EvictionPolicyType` -> concrete policy
 * instance. Both `services/cache-node` (to construct the initial
 * policy from config) and `AdaptiveEvictionEngine` (to construct a
 * fresh policy on every switch) go through this factory instead of
 * `new`-ing concrete classes directly.
 */

import { EvictionPolicyType } from '@flowcache/shared';
import type { EvictionPolicy } from './EvictionPolicy.js';
import { LruEvictionPolicy } from './LRU.js';
import { LfuEvictionPolicy } from './LFU.js';
import { TinyLfuEvictionPolicy } from './TinyLFU.js';

export function createEvictionPolicy(type: EvictionPolicyType): EvictionPolicy {
  switch (type) {
    case EvictionPolicyType.LRU:
      return new LruEvictionPolicy();
    case EvictionPolicyType.LFU:
      return new LfuEvictionPolicy();
    case EvictionPolicyType.TINY_LFU:
      return new TinyLfuEvictionPolicy();
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown eviction policy type: ${String(exhaustiveCheck)}`);
    }
  }
}