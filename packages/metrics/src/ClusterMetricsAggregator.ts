/**
 * @flowcache/metrics — ClusterMetricsAggregator.ts
 *
 * The gateway polls `GET /metrics` on every cache node and needs to
 * present one coherent cluster-wide picture (total throughput, overall
 * hit ratio, worst-case latency across nodes, node health breakdown,
 * policy distribution) rather than making the dashboard stitch N raw
 * snapshots together itself.
 */

import { NodeStatus, EvictionPolicyType, type MetricsSnapshot } from '@flowcache/shared';

export interface ClusterMetricsSummary {
  timestamp: number;
  nodeCount: number;
  healthyNodeCount: number;
  totalRequestsPerSecond: number;
  totalEntryCount: number;
  totalMemoryUsageBytes: number;
  totalMemoryLimitBytes: number;
  /** Cluster-wide hit ratio, computed from summed hits/misses across
   *  nodes (not an average of per-node ratios, which would
   *  misrepresent nodes with very different traffic volumes). */
  overallHitRatio: number;
  totalEvictions: number;
  /** Worst (highest) P99 latency observed across all nodes — the
   *  figure that actually matters for a client's tail-latency SLO. */
  clusterP99LatencyMs: number;
  policyDistribution: Record<EvictionPolicyType, number>;
  nodeStatusBreakdown: Record<NodeStatus, number>;
  perNode: MetricsSnapshot[];
}

export function aggregateClusterMetrics(snapshots: readonly MetricsSnapshot[]): ClusterMetricsSummary {
  const policyDistribution: Record<EvictionPolicyType, number> = {
    [EvictionPolicyType.LRU]: 0,
    [EvictionPolicyType.LFU]: 0,
    [EvictionPolicyType.TINY_LFU]: 0,
  };

  const nodeStatusBreakdown: Record<NodeStatus, number> = {
    [NodeStatus.JOINING]: 0,
    [NodeStatus.HEALTHY]: 0,
    [NodeStatus.SUSPECT]: 0,
    [NodeStatus.DEAD]: 0,
    [NodeStatus.LEAVING]: 0,
  };

  let totalHits = 0;
  let totalMisses = 0;
  let totalRps = 0;
  let totalEntries = 0;
  let totalMemory = 0;
  let totalMemoryLimit = 0;
  let totalEvictions = 0;
  let worstP99 = 0;

  for (const snapshot of snapshots) {
    totalHits += snapshot.hits;
    totalMisses += snapshot.misses;
    totalRps += snapshot.requestsPerSecond;
    totalEntries += snapshot.entryCount;
    totalMemory += snapshot.memoryUsageBytes;
    totalMemoryLimit += Number.isFinite(snapshot.memoryLimitBytes) ? snapshot.memoryLimitBytes : 0;
    totalEvictions += snapshot.evictions;
    worstP99 = Math.max(worstP99, snapshot.latency.p99);

    policyDistribution[snapshot.currentEvictionPolicy] += 1;
    nodeStatusBreakdown[snapshot.nodeStatus] += 1;
  }

  const totalReads = totalHits + totalMisses;

  return {
    timestamp: Date.now(),
    nodeCount: snapshots.length,
    healthyNodeCount: nodeStatusBreakdown[NodeStatus.HEALTHY],
    totalRequestsPerSecond: totalRps,
    totalEntryCount: totalEntries,
    totalMemoryUsageBytes: totalMemory,
    totalMemoryLimitBytes: totalMemoryLimit,
    overallHitRatio: totalReads > 0 ? totalHits / totalReads : 0,
    totalEvictions,
    clusterP99LatencyMs: worstP99,
    policyDistribution,
    nodeStatusBreakdown,
    perNode: [...snapshots],
  };
}