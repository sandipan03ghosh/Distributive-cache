/**
 * @flowcache/dashboard — pages/Overview.tsx
 */

import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { MetricsSnapshot } from '@flowcache/shared';
import { useClusterData } from '../hooks/useClusterData.js';
import { NodeCard } from '../components/NodeCard.js';
import { RingVisualization } from '../components/RingVisualization.js';
import { MetricsCharts, type HistoryPoint } from '../components/MetricsCharts.js';

const HISTORY_LIMIT = 30;

export function Overview(): JSX.Element {
  const { cluster, metrics, error, loading, lastUpdatedAt } = useClusterData();
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!metrics) return;
    setHistory((prev) => {
      const point: HistoryPoint = {
        time: new Date(metrics.timestamp).toLocaleTimeString(),
        hitRatio: metrics.overallHitRatio,
        rps: metrics.totalRequestsPerSecond,
        p99: metrics.clusterP99LatencyMs,
      };
      const next = [...prev, point];
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    });
  }, [metrics]);

  const metricsByNode = useMemo(() => {
    const map = new Map<string, MetricsSnapshot>();
    metrics?.perNode.forEach((snapshot) => map.set(snapshot.nodeId, snapshot));
    return map;
  }, [metrics]);

  return (
    <div className="overview">
      <header className="app__header">
        <h1>FlowCache</h1>
        <p className="app__subtitle">Adaptive Distributed Cache — Cluster Dashboard</p>
        {lastUpdatedAt && <p className="app__updated">Updated {new Date(lastUpdatedAt).toLocaleTimeString()}</p>}
      </header>

      {error && (
        <div className="app__error">
          Failed to reach gateway: {error}. Retrying every few seconds…
        </div>
      )}
      {loading && !cluster && <div className="app__loading">Loading cluster state…</div>}

      {metrics && (
        <section className="summary-grid" aria-label="Cluster summary">
          <SummaryStat label="Nodes healthy" value={`${metrics.healthyNodeCount} / ${metrics.nodeCount}`} />
          <SummaryStat label="Hit ratio" value={`${(metrics.overallHitRatio * 100).toFixed(1)}%`} />
          <SummaryStat label="Throughput" value={`${metrics.totalRequestsPerSecond.toFixed(1)} req/s`} />
          <SummaryStat label="P99 latency" value={`${metrics.clusterP99LatencyMs.toFixed(1)} ms`} />
          <SummaryStat label="Total entries" value={metrics.totalEntryCount.toLocaleString()} />
          <SummaryStat label="Total evictions" value={metrics.totalEvictions.toLocaleString()} />
        </section>
      )}

      <div className="main-grid">
        <section className="panel">
          <h2>Nodes</h2>
          <div className="node-grid">
            {cluster?.nodes.map((node) => (
              <NodeCard key={node.nodeId} node={node} metrics={metricsByNode.get(node.nodeId)} />
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Hash Ring</h2>
          {cluster && <RingVisualization cluster={cluster} />}
        </section>
      </div>

      {metrics && (
        <section className="panel">
          <h2>Metrics</h2>
          <MetricsCharts history={history} policyDistribution={metrics.policyDistribution} />
        </section>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="summary-stat">
      <span className="summary-stat__value">{value}</span>
      <span className="summary-stat__label">{label}</span>
    </div>
  );
}