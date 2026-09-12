/**
 * @flowcache/eviction — LRU.ts
 *
 * Classic Least-Recently-Used policy, implemented from scratch with a
 * doubly linked list (recency order) plus a Map<key, Node> for O(1)
 * lookup — no external LRU library. `head` is the most-recently-used
 * end, `tail` is the least-recently-used end (the eviction candidate).
 */

import { EvictionPolicyType, type CacheEntry, type CacheKey } from '@flowcache/shared';
import type { EvictionPolicy } from './EvictionPolicy.js';

class DllNode {
  prev: DllNode | null = null;
  next: DllNode | null = null;
  constructor(public readonly key: CacheKey) {}
}

export class LruEvictionPolicy implements EvictionPolicy {
  readonly type = EvictionPolicyType.LRU;

  private readonly nodes = new Map<CacheKey, DllNode>();
  private head: DllNode | null = null; // most recently used
  private tail: DllNode | null = null; // least recently used

  recordAccess(key: CacheKey): void {
    this.touch(key);
  }

  recordWrite(key: CacheKey): void {
    this.touch(key);
  }

  recordRemoval(key: CacheKey): void {
    const node = this.nodes.get(key);
    if (!node) return;
    this.unlink(node);
    this.nodes.delete(key);
  }

  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null {
    const matches = this.leastRecentlyUsedCandidates(candidateKeys, 1);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Walks from the LRU (tail) end and returns up to `limit` keys that
   * are present in `candidateKeys`, ordered from least- to
   * more-recently-used. Exposed (not just used internally) so
   * TinyLFU's window/frequency comparison can reuse this list-walking
   * logic instead of reimplementing it.
   */
  leastRecentlyUsedCandidates(candidateKeys: readonly CacheKey[], limit: number): CacheKey[] {
    if (limit <= 0) return [];
    const candidateSet = new Set(candidateKeys);
    const result: CacheKey[] = [];
    let node = this.tail;
    // Guard against an unbounded walk if the linked list and the
    // storage engine's key set have drifted out of sync.
    let guard = this.nodes.size + 1;
    while (node && result.length < limit && guard > 0) {
      if (candidateSet.has(node.key)) {
        result.push(node.key);
      }
      node = node.prev;
      guard -= 1;
    }
    return result;
  }

  reset(): void {
    this.nodes.clear();
    this.head = null;
    this.tail = null;
  }

  seed(entries: readonly CacheEntry[]): void {
    this.reset();
    // Order by lastAccessedAt ascending so the coldest entries land at
    // the tail (LRU end) and the warmest at the head, matching what a
    // real LRU list would look like if it had been tracking all along.
    const ordered = [...entries].sort((a, b) => a.metadata.lastAccessedAt - b.metadata.lastAccessedAt);
    for (const entry of ordered) {
      this.touch(entry.key);
    }
  }

  size(): number {
    return this.nodes.size;
  }

  // ---------------------------------------------------------------------
  // Internal linked-list mechanics
  // ---------------------------------------------------------------------

  private touch(key: CacheKey): void {
    let node = this.nodes.get(key);
    if (node) {
      this.unlink(node);
    } else {
      node = new DllNode(key);
      this.nodes.set(key, node);
    }
    this.pushFront(node);
  }

  private pushFront(node: DllNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private unlink(node: DllNode): void {
    if (node.prev) node.prev.next = node.next;
    else if (this.head === node) this.head = node.next;

    if (node.next) node.next.prev = node.prev;
    else if (this.tail === node) this.tail = node.prev;

    node.prev = null;
    node.next = null;
  }
}