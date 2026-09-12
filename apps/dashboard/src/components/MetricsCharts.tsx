/**
 * @flowcache/dashboard — components/MetricsCharts.tsx
 */

import type { JSX } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface HistoryPoint {
  time: string;
  hitRatio: number;
  rps: number;
  p99: number;
}

export interface MetricsChartsProps {
  history: HistoryPoint[];
  policyDistribution: Record<string, number>;
}

export function MetricsCharts({ history, policyDistribution }: MetricsChartsProps): JSX.Element {
  const policyData = Object.entries(policyDistribution).map(([policy, count]) => ({ policy, count }));

  return (
    <div className="charts-grid">
      <div className="chart-card">
        <h3>Hit Ratio</h3>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '')} />
            <Line type="monotone" dataKey="hitRatio" stroke="#22c55e" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-card">
        <h3>Throughput (req/sec)</h3>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line type="monotone" dataKey="rps" stroke="#6366f1" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-card">
        <h3>P99 Latency (ms)</h3>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line type="monotone" dataKey="p99" stroke="#f59e0b" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-card">
        <h3>Eviction Policy Distribution</h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={policyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="policy" tick={{ fontSize: 10 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Bar dataKey="count" fill="#ec4899" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}