/**
 * @flowcache/dashboard — hooks/useClusterData.ts
 *
 * Polls `GET /cluster` and `GET /metrics` on the gateway every
 * `POLL_INTERVAL_MS` and exposes the latest results plus loading/error
 * state — the dashboard's "live updates" without needing a WebSocket
 * server on the gateway.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ClusterView } from '@flowcache/shared';
import type { ClusterMetricsSummary } from '@flowcache/metrics';
import { fetchCluster, fetchClusterMetrics } from '../api/client.js';
import { useInterval } from './useInterval.js';

export interface ClusterDataState {
  cluster: ClusterView | null;
  metrics: ClusterMetricsSummary | null;
  error: string | null;
  loading: boolean;
  lastUpdatedAt: number | null;
}

const POLL_INTERVAL_MS = 3000;

export function useClusterData(): ClusterDataState {
  const [state, setState] = useState<ClusterDataState>({
    cluster: null,
    metrics: null,
    error: null,
    loading: true,
    lastUpdatedAt: null,
  });

  const refresh = useCallback(async () => {
    try {
      const [cluster, metrics] = await Promise.all([fetchCluster(), fetchClusterMetrics()]);
      setState({ cluster, metrics, error: null, loading: false, lastUpdatedAt: Date.now() });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);

  return state;
}