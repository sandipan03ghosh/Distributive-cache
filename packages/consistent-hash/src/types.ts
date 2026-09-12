/**
 * @flowcache/consistent-hash — types.ts
 */

import type { CacheKey, NodeInfo } from '@flowcache/shared';

/** A single point on the ring: one virtual node belonging to one
 *  physical node. */
export interface RingPoint {
  hash: number; // position on the [0, 2^32) circular keyspace
  nodeId: string;
  virtualIndex: number;
}

export interface ConsistentHashRingOptions {
  /** Base number of virtual nodes for a node with weight === 1. Actual
   *  virtual node count for a given node is
   *  round(baseVirtualNodeCount * node.weight), so heavier nodes claim
   *  proportionally more of the ring (and therefore more keys). */
  baseVirtualNodeCount: number;
}

export const DEFAULT_RING_OPTIONS: ConsistentHashRingOptions = {
  baseVirtualNodeCount: 128,
};

export interface KeyMovementReport {
  sampleSize: number;
  movedCount: number;
  movedRatio: number;
  /** Theoretical minimum for a single node join/leave against N nodes
   *  is roughly 1/N of the keyspace; this is included so callers can
   *  judge how close to "minimal" the observed movement was. */
  theoreticalMinimumRatio: number;
}

export type { CacheKey, NodeInfo };