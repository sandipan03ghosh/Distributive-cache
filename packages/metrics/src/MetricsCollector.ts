/**
 * @flowcache/metrics — MetricsCollector.ts
 *
 * The single per-node metrics aggregation point. `services/cache-node`
 * constructs one `MetricsCollector`, wires it to the storage engine,
 * eviction engine, replication engine, and snapshot manager via getter
 * functions (the same "attach with a getter" seam used elsewhere in
 * FlowCache to avoid circular package dependencies), and calls
 * `recordRequest()` on every HTTP request. `GET /metrics` on the cache
 * node then just calls `getSnapshot()`.
 */

import {
  NodeStatus,
  EvictionPolicyType,
  type MetricsSnapshot,
  type StorageStats,
} from '@flowcache/shared';
import { LatencyHistogram } from './LatencyHistogram.js';
import { RateCounter } from './RateCounter.js';

export interface MetricsCollectorOptions {
  nodeId: string;
  latencySampleCapacity?: number;
  rpsWindowMs?: number;
}

const DEFAULT_STORAGE_STATS: StorageStats = {
  entryCount: 0,
  totalSizeBytes: 0,
  hits: 0,
  misses: 0,
  expirations: 0,
  evictions: 0,
  writes: 0,
  deletes: 0,
};

export class MetricsCollector {
  private readonly nodeId: string;
  private readonly latency: LatencyHistogram;
  private readonly requestRate: RateCounter;

  private replicationQueueDepth = 0;
  private lastSnapshotDurationMs: number | null = null;

  private getStorageStats: () => StorageStats = () => DEFAULT_STORAGE_STATS;
  private getMemoryLimitBytes: () => number = () => Number.POSITIVE_INFINITY;
  private getCurrentPolicy: () => EvictionPolicyType = () => EvictionPolicyType.LRU;
  private getNodeStatus: () => NodeStatus = () => NodeStatus.HEALTHY;

  constructor(options: MetricsCollectorOptions) {
    this.nodeId = options.nodeId;
    this.latency = new LatencyHistogram(options.latencySampleCapacity);
    this.requestRate = new RateCounter(options.rpsWindowMs ?? 1000);
  }

  // -------------------------------------------------------------------
  // Recording (hot path — called per request / per event)
  // -------------------------------------------------------------------

  /** Call once per completed HTTP request with its total latency. */
  recordRequest(latencyMs: number): void {
    this.latency.record(latencyMs);
    this.requestRate.hit();
  }

  recordReplicationQueueDepth(depth: number): void {
    this.replicationQueueDepth = depth;
  }

  recordSnapshotDuration(durationMs: number): void {
    this.lastSnapshotDurationMs = durationMs;
  }

  // -------------------------------------------------------------------
  // Wiring (called once at startup by services/cache-node)
  // -------------------------------------------------------------------

  attachStorageStats(getter: () => StorageStats): void {
    this.getStorageStats = getter;
  }

  attachMemoryLimit(getter: () => number): void {
    this.getMemoryLimitBytes = getter;
  }

  attachEvictionPolicyGetter(getter: () => EvictionPolicyType): void {
    this.getCurrentPolicy = getter;
  }

  attachNodeStatusGetter(getter: () => NodeStatus): void {
    this.getNodeStatus = getter;
  }

  // -------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------

  getSnapshot(): MetricsSnapshot {
    const stats = this.getStorageStats();
    const totalReads = stats.hits + stats.misses;

    return {
      nodeId: this.nodeId,
      timestamp: Date.now(),
      hits: stats.hits,
      misses: stats.misses,
      hitRatio: totalReads > 0 ? stats.hits / totalReads : 0,
      evictions: stats.evictions,
      entryCount: stats.entryCount,
      memoryUsageBytes: stats.totalSizeBytes,
      memoryLimitBytes: this.getMemoryLimitBytes(),
      requestsPerSecond: this.requestRate.rate(),
      latency: this.latency.percentiles(),
      replicationQueueDepth: this.replicationQueueDepth,
      lastSnapshotDurationMs: this.lastSnapshotDurationMs,
      currentEvictionPolicy: this.getCurrentPolicy(),
      nodeStatus: this.getNodeStatus(),
    };
  }

  reset(): void {
    this.latency.reset();
    this.requestRate.reset();
    this.replicationQueueDepth = 0;
    this.lastSnapshotDurationMs = null;
  }
}