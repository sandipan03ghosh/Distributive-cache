/**
 * @flowcache/consistent-hash — ConsistentHashRing.ts
 *
 * A from-scratch consistent hash ring:
 *   - Each physical node is represented by many "virtual nodes"
 *     (points on the ring), so that adding/removing one physical node
 *     redistributes only a small, roughly-even slice of the keyspace
 *     rather than causing a global reshuffle.
 *   - Points are kept in a sorted array; lookup is a binary search for
 *     the first point clockwise (>=) of a key's hash, wrapping around
 *     to index 0 if the key hashes past the last point — the "ring"
 *     part of consistent hashing.
 *   - `weight` on a node scales its virtual node count, so
 *     heterogeneous-capacity nodes can claim proportionally more or
 *     less of the keyspace.
 *
 * No external consistent-hashing library is used — the ring, the
 * binary search, and the hash function (`RingHash.ts`) are all
 * implemented here.
 */

import { NodeStatus, type CacheKey, type NodeInfo, type RingAssignment } from '@flowcache/shared';
import { ringHash } from './RingHash.js';
import { DEFAULT_RING_OPTIONS, type ConsistentHashRingOptions, type RingPoint } from './types.js';

export class ConsistentHashRing {
  private readonly options: ConsistentHashRingOptions;
  private points: RingPoint[] = []; // always kept sorted ascending by hash
  private readonly nodes = new Map<string, NodeInfo>();

  constructor(options: Partial<ConsistentHashRingOptions> = {}) {
    this.options = { ...DEFAULT_RING_OPTIONS, ...options };
  }

  // -------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------

  /** Adds (or re-adds) a node to the ring, generating its virtual
   *  nodes. Returns the RingAssignments that were added, so callers can
   *  log / broadcast exactly what changed. */
  addNode(node: NodeInfo): RingAssignment[] {
    // If the node already exists, remove its old points first so this
    // also serves as a clean "update" path (e.g. weight changed).
    if (this.nodes.has(node.nodeId)) {
      this.removeNode(node.nodeId);
    }

    this.nodes.set(node.nodeId, node);
    const virtualCount = this.virtualNodeCountFor(node);
    const added: RingPoint[] = [];

    for (let i = 0; i < virtualCount; i++) {
      const label = `${node.nodeId}#${i}`;
      const point: RingPoint = { hash: ringHash(label), nodeId: node.nodeId, virtualIndex: i };
      added.push(point);
    }

    this.points.push(...added);
    this.points.sort((a, b) => a.hash - b.hash);

    return added.map((p) => ({ nodeId: p.nodeId, virtualNodeHash: p.hash }));
  }

  /** Removes a node and all of its virtual nodes from the ring. Keys
   *  that were owned by this node's virtual nodes fall through to
   *  whichever remaining virtual node is next clockwise — by
   *  construction this is spread across many different physical nodes
   *  rather than dumped entirely onto one neighbor. */
  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.points = this.points.filter((p) => p.nodeId !== nodeId);
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  getNodeInfo(nodeId: string): NodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  updateNodeStatus(nodeId: string, status: NodeStatus, lastHeartbeat: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.set(nodeId, { ...node, status, lastHeartbeat });
  }

  getPhysicalNodes(): NodeInfo[] {
    return [...this.nodes.values()];
  }

  getHealthyPhysicalNodes(): NodeInfo[] {
    return this.getPhysicalNodes().filter((n) => n.status === NodeStatus.HEALTHY);
  }

  // -------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------

  /** Returns the nodeId that owns `key`, or null if the ring is empty. */
  getNode(key: CacheKey): string | null {
    if (this.points.length === 0) return null;
    const point = this.points[this.successorIndex(ringHash(key))];
    return point.nodeId;
  }

  /**
   * Returns up to `count` distinct *physical* node ids, walking
   * clockwise from `key`'s position — used to pick replication
   * targets (primary + N replicas) in one pass. Skips repeated virtual
   * nodes belonging to a physical node already selected.
   */
  getNodesForKey(key: CacheKey, count: number): string[] {
    if (this.points.length === 0 || count <= 0) return [];

    const result: string[] = [];
    const seen = new Set<string>();
    let idx = this.successorIndex(ringHash(key));
    let guard = this.points.length;

    while (result.length < count && guard > 0) {
      const candidate = this.points[idx];
      if (!seen.has(candidate.nodeId)) {
        seen.add(candidate.nodeId);
        result.push(candidate.nodeId);
      }
      idx = (idx + 1) % this.points.length;
      guard -= 1;
    }

    return result;
  }

  /** Binary search for the first ring point with hash >= target,
   *  wrapping to index 0 (the classic "consistent hashing ring"
   *  behavior — the point just clockwise of the key, or the very first
   *  point if the key hashes past everything). */
  private successorIndex(targetHash: number): number {
    let lo = 0;
    let hi = this.points.length - 1;

    if (targetHash > this.points[hi].hash) {
      return 0; // wrap around
    }

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].hash < targetHash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // -------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------

  getRingSnapshot(): RingAssignment[] {
    return this.points.map((p) => ({ nodeId: p.nodeId, virtualNodeHash: p.hash }));
  }

  totalVirtualNodeCount(): number {
    return this.points.length;
  }

  private virtualNodeCountFor(node: NodeInfo): number {
    return Math.max(1, Math.round(this.options.baseVirtualNodeCount * node.weight));
  }

  clone(): ConsistentHashRing {
    const copy = new ConsistentHashRing(this.options);
    for (const node of this.nodes.values()) {
      copy.addNode(node);
    }
    return copy;
  }
}