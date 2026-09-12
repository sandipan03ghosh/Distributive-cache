/**
 * @flowcache/dashboard — components/RingVisualization.tsx
 *
 * Plots every virtual node from `ClusterView.ring` around a circle at
 * the angle its hash corresponds to (hash / 2^32 * 360°), colored by
 * which physical node owns it. Visually communicates two things at a
 * glance that are otherwise hard to see: how many virtual nodes each
 * physical node holds (denser color = more of the keyspace), and how
 * evenly the ring is actually distributed.
 */

import { useMemo } from 'react';
import type { JSX } from 'react';
import type { ClusterView } from '@flowcache/shared';

const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 28;
const MAX_HASH = 0xffffffff;

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#84cc16', '#f43f5e'];

export interface RingVisualizationProps {
  cluster: ClusterView;
}

export function RingVisualization({ cluster }: RingVisualizationProps): JSX.Element {
  const nodeColor = useMemo(() => {
    const map = new Map<string, string>();
    cluster.nodes.forEach((node, index) => map.set(node.nodeId, PALETTE[index % PALETTE.length]));
    return map;
  }, [cluster.nodes]);

  const points = useMemo(
    () =>
      cluster.ring.map((assignment) => {
        const angle = (assignment.virtualNodeHash / MAX_HASH) * 2 * Math.PI;
        return {
          ...assignment,
          x: CENTER + RADIUS * Math.sin(angle),
          y: CENTER - RADIUS * Math.cos(angle),
        };
      }),
    [cluster.ring],
  );

  return (
    <div className="ring-viz">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" height="auto" role="img" aria-label="Consistent hash ring">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={1} />
        {points.map((point) => (
          <circle
            key={`${point.nodeId}-${point.virtualNodeHash}`}
            cx={point.x}
            cy={point.y}
            r={3}
            fill={nodeColor.get(point.nodeId) ?? '#94a3b8'}
            opacity={0.85}
          />
        ))}
        <circle cx={CENTER} cy={CENTER} r={2} fill="var(--text-secondary)" />
      </svg>

      <ul className="ring-viz__legend">
        {cluster.nodes.map((node) => (
          <li key={node.nodeId}>
            <span className="ring-viz__swatch" style={{ backgroundColor: nodeColor.get(node.nodeId) }} />
            {node.nodeId}
          </li>
        ))}
      </ul>
      <p className="ring-viz__caption">{cluster.ring.length} virtual nodes across {cluster.nodes.length} physical nodes</p>
    </div>
  );
}