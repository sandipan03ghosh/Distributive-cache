/**
 * @flowcache/consistent-hash — RebalanceAnalyzer.ts
 *
 * Consistent hashing's whole selling point over naive `hash(key) % N`
 * is that adding or removing a node only moves ~1/N of the keyspace
 * instead of nearly all of it. This module makes that measurable: give
 * it a ring "before" and "after" a topology change plus a sample
 * keyspace, and it reports exactly how many of those sample keys
 * changed owner.
 *
 * Used by the benchmark engine's fault-injection scenarios (node
 * join/leave) to produce a concrete number for the README/benchmark
 * report rather than an unverified claim.
 */

import type { CacheKey } from '@flowcache/shared';
import type { ConsistentHashRing } from './ConsistentHashRing.js';
import type { KeyMovementReport } from './types.js';

export function analyzeKeyMovement(
  before: ConsistentHashRing,
  after: ConsistentHashRing,
  sampleKeys: readonly CacheKey[],
): KeyMovementReport {
  let moved = 0;
  for (const key of sampleKeys) {
    const beforeOwner = before.getNode(key);
    const afterOwner = after.getNode(key);
    if (beforeOwner !== afterOwner) moved += 1;
  }

  const nodeCountBefore = before.getPhysicalNodes().length;
  const nodeCountAfter = after.getPhysicalNodes().length;
  // Theoretical minimum for adding/removing one node against N nodes
  // is roughly 1/max(N_before, N_after) of the keyspace.
  const referenceNodeCount = Math.max(nodeCountBefore, nodeCountAfter, 1);

  return {
    sampleSize: sampleKeys.length,
    movedCount: moved,
    movedRatio: sampleKeys.length > 0 ? moved / sampleKeys.length : 0,
    theoreticalMinimumRatio: 1 / referenceNodeCount,
  };
}

/** Generates a synthetic, evenly spread sample keyspace for movement
 *  analysis (e.g. "key:0" .. "key:9999"). Kept here rather than in the
 *  benchmark package since it's specifically for exercising ring
 *  behavior, not general workload generation. */
export function generateSampleKeyspace(size: number, prefix = 'key'): CacheKey[] {
  const keys: CacheKey[] = new Array(size);
  for (let i = 0; i < size; i++) {
    keys[i] = `${prefix}:${i}`;
  }
  return keys;
}