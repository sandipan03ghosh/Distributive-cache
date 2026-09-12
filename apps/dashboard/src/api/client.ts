/**
 * @flowcache/dashboard — api/client.ts
 *
 * All dashboard data comes from the gateway's own public API
 * (`/cluster`, `/metrics`) — the dashboard never talks to individual
 * cache nodes directly, matching the architecture diagram (Client ->
 * Gateway -> ... ). Types are imported straight from
 * `@flowcache/shared` / `@flowcache/metrics` (this app is part of the
 * same npm workspace) so the dashboard can never silently drift out of
 * sync with what the gateway actually returns.
 */

import type { ClusterView } from '@flowcache/shared';
import type { ClusterMetricsSummary } from '@flowcache/metrics';

const API_BASE = import.meta.env.VITE_GATEWAY_URL ?? '';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchCluster(): Promise<ClusterView> {
  return getJson<ClusterView>('/cluster');
}

export function fetchClusterMetrics(): Promise<ClusterMetricsSummary> {
  return getJson<ClusterMetricsSummary>('/metrics');
}