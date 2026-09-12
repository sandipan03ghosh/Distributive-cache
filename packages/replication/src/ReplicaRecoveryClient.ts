/**
 * @flowcache/replication — ReplicaRecoveryClient.ts
 *
 * Kafka replay handles the steady-state "stay in sync" case just fine:
 * a replica that's briefly behind catches up by consuming events it
 * missed. It does NOT handle a brand-new node joining with empty local
 * state, or a replica that's been offline longer than the topic's
 * retention window — in both cases there's no event history left to
 * replay from. For that, the recovering node needs to bulk-pull a
 * full, point-in-time export of the relevant keyspace from a healthy
 * peer over plain HTTP.
 *
 * Expects the peer's cache-node service to expose
 * `GET /internal/replicate/export` (see `services/cache-node`'s
 * internal routes), returning a JSON array of `CacheEntry`.
 */

import { NodeUnavailableError, type CacheEntry } from '@flowcache/shared';

export interface ReplicaRecoveryClientOptions {
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ReplicaRecoveryClient {
  private readonly timeoutMs: number;

  constructor(options: ReplicaRecoveryClientOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Pulls every entry currently held by `peerBaseUrl` (e.g.
   *  "http://cache-node-2:4001"). Callers are expected to filter the
   *  result down to whatever subset of keys they're actually
   *  responsible for post-rebalance, since the peer's export is not
   *  aware of the requester's ring ownership. */
  async pullFullState(peerBaseUrl: string): Promise<CacheEntry[]> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${peerBaseUrl}/internal/replicate/export`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NodeUnavailableError(peerBaseUrl, new Error(`HTTP ${response.status}`));
      }

      return (await response.json()) as CacheEntry[];
    } catch (err) {
      if (err instanceof NodeUnavailableError) throw err;
      throw new NodeUnavailableError(peerBaseUrl, err);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}