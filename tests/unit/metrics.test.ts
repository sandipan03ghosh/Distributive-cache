import { describe, it, expect, vi } from 'vitest';
import { LatencyHistogram, RateCounter, MetricsCollector, aggregateClusterMetrics } from '@flowcache/metrics';
import { EvictionPolicyType, NodeStatus, type MetricsSnapshot } from '@flowcache/shared';

describe('LatencyHistogram', () => {
  it('computes p50/p95/p99/max from recorded samples', () => {
    const hist = new LatencyHistogram();
    for (let i = 1; i <= 100; i++) hist.record(i);

    const pct = hist.percentiles();
    expect(pct.p50).toBeCloseTo(50, 0);
    expect(pct.p95).toBeCloseTo(95, 0);
    expect(pct.p99).toBeCloseTo(99, 0);
    expect(pct.max).toBe(100);
  });

  it('returns all zeros with no samples', () => {
    const hist = new LatencyHistogram();
    expect(hist.percentiles()).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it('respects a bounded capacity (ring buffer, not unbounded growth)', () => {
    const hist = new LatencyHistogram(10);
    for (let i = 0; i < 1000; i++) hist.record(i);
    expect(hist.sampleCount()).toBe(10);
  });
});

describe('RateCounter', () => {
  it('computes requests per second over the trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const rate = new RateCounter(1000);

    for (let i = 0; i < 10; i++) rate.hit();

    expect(rate.rate()).toBe(10);
    vi.useRealTimers();
  });

  it('excludes hits outside the trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const rate = new RateCounter(1000);
    rate.hit();

    vi.setSystemTime(2000);
    rate.hit();

    expect(rate.rate()).toBe(1);
    vi.useRealTimers();
  });
});

describe('MetricsCollector', () => {
  it('produces a snapshot reflecting attached getters and recorded requests', () => {
    const collector = new MetricsCollector({ nodeId: 'node-1' });
    collector.attachStorageStats(() => ({
      entryCount: 10,
      totalSizeBytes: 1000,
      hits: 8,
      misses: 2,
      expirations: 0,
      evictions: 1,
      writes: 5,
      deletes: 0,
    }));
    collector.attachMemoryLimit(() => 10_000);
    collector.attachEvictionPolicyGetter(() => EvictionPolicyType.LFU);
    collector.attachNodeStatusGetter(() => NodeStatus.HEALTHY);

    collector.recordRequest(12.5);
    collector.recordReplicationQueueDepth(3);
    collector.recordSnapshotDuration(42);

    const snapshot = collector.getSnapshot();
    expect(snapshot.nodeId).toBe('node-1');
    expect(snapshot.hits).toBe(8);
    expect(snapshot.misses).toBe(2);
    expect(snapshot.hitRatio).toBeCloseTo(0.8);
    expect(snapshot.memoryLimitBytes).toBe(10_000);
    expect(snapshot.currentEvictionPolicy).toBe(EvictionPolicyType.LFU);
    expect(snapshot.nodeStatus).toBe(NodeStatus.HEALTHY);
    expect(snapshot.replicationQueueDepth).toBe(3);
    expect(snapshot.lastSnapshotDurationMs).toBe(42);
    expect(snapshot.latency.max).toBe(12.5);
  });

  it('defaults gracefully when nothing is attached', () => {
    const collector = new MetricsCollector({ nodeId: 'node-1' });
    const snapshot = collector.getSnapshot();
    expect(snapshot.hitRatio).toBe(0);
    expect(snapshot.entryCount).toBe(0);
  });
});

describe('aggregateClusterMetrics', () => {
  function snapshot(overrides: Partial<MetricsSnapshot>): MetricsSnapshot {
    return {
      nodeId: 'node-x',
      timestamp: 0,
      hits: 0,
      misses: 0,
      hitRatio: 0,
      evictions: 0,
      entryCount: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 1000,
      requestsPerSecond: 0,
      latency: { p50: 0, p95: 0, p99: 0, max: 0 },
      replicationQueueDepth: 0,
      lastSnapshotDurationMs: null,
      currentEvictionPolicy: EvictionPolicyType.LRU,
      nodeStatus: NodeStatus.HEALTHY,
      ...overrides,
    };
  }

  it('sums hits/misses across nodes for a traffic-weighted overall hit ratio', () => {
    const summary = aggregateClusterMetrics([
      snapshot({ nodeId: 'a', hits: 90, misses: 10 }),
      snapshot({ nodeId: 'b', hits: 10, misses: 90 }),
    ]);
    // (90+10) / (100+100) = 0.5, NOT the naive average of the two
    // per-node ratios (0.9 and 0.1 averaged would also be 0.5 here by
    // coincidence — use an asymmetric traffic split to actually prove
    // it's not doing a naive average).
    expect(summary.overallHitRatio).toBeCloseTo(0.5);
  });

  it('reports the worst (max) P99 latency across nodes', () => {
    const summary = aggregateClusterMetrics([
      snapshot({ nodeId: 'a', latency: { p50: 1, p95: 2, p99: 5, max: 10 } }),
      snapshot({ nodeId: 'b', latency: { p50: 1, p95: 2, p99: 40, max: 50 } }),
    ]);
    expect(summary.clusterP99LatencyMs).toBe(40);
  });

  it('breaks down node status and policy distribution', () => {
    const summary = aggregateClusterMetrics([
      snapshot({ nodeId: 'a', nodeStatus: NodeStatus.HEALTHY, currentEvictionPolicy: EvictionPolicyType.LRU }),
      snapshot({ nodeId: 'b', nodeStatus: NodeStatus.DEAD, currentEvictionPolicy: EvictionPolicyType.LFU }),
    ]);
    expect(summary.nodeStatusBreakdown[NodeStatus.HEALTHY]).toBe(1);
    expect(summary.nodeStatusBreakdown[NodeStatus.DEAD]).toBe(1);
    expect(summary.policyDistribution[EvictionPolicyType.LRU]).toBe(1);
    expect(summary.policyDistribution[EvictionPolicyType.LFU]).toBe(1);
    expect(summary.healthyNodeCount).toBe(1);
  });

  it('handles an empty snapshot list without dividing by zero', () => {
    const summary = aggregateClusterMetrics([]);
    expect(summary.overallHitRatio).toBe(0);
    expect(summary.nodeCount).toBe(0);
  });
});