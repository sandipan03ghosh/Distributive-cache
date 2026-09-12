/**
 * @flowcache/dashboard — components/NodeCard.tsx
 */

import type { JSX } from 'react';
import type { MetricsSnapshot, NodeInfo } from '@flowcache/shared';

const STATUS_COLORS: Record<string, string> = {
  HEALTHY: '#22c55e',
  JOINING: '#3b82f6',
  SUSPECT: '#f59e0b',
  DEAD: '#ef4444',
  LEAVING: '#6b7280',
};

export interface NodeCardProps {
  node: NodeInfo;
  metrics?: MetricsSnapshot;
}

export function NodeCard({ node, metrics }: NodeCardProps): JSX.Element {
  const color = STATUS_COLORS[node.status] ?? '#6b7280';

  return (
    <div className="node-card">
      <div className="node-card__header">
        <span className="node-card__dot" style={{ backgroundColor: color }} />
        <span className="node-card__id">{node.nodeId}</span>
        <span className="node-card__status" style={{ color }}>
          {node.status}
        </span>
      </div>
      <div className="node-card__address">
        {node.host}:{node.port} · weight {node.weight}
      </div>

      {metrics ? (
        <dl className="node-card__stats">
          <Stat label="Policy" value={metrics.currentEvictionPolicy} />
          <Stat label="Hit ratio" value={`${(metrics.hitRatio * 100).toFixed(1)}%`} />
          <Stat label="Entries" value={metrics.entryCount.toLocaleString()} />
          <Stat label="Memory" value={`${formatBytes(metrics.memoryUsageBytes)} / ${formatBytes(metrics.memoryLimitBytes)}`} />
          <Stat label="RPS" value={metrics.requestsPerSecond.toFixed(1)} />
          <Stat label="P99" value={`${metrics.latency.p99.toFixed(1)} ms`} />
          <Stat label="Repl. queue" value={String(metrics.replicationQueueDepth)} />
          <Stat label="Evictions" value={metrics.evictions.toLocaleString()} />
        </dl>
      ) : (
        <p className="node-card__no-metrics">No metrics available</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="node-card__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '∞';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}