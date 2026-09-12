/**
 * @flowcache/gateway — discovery/CacheNodeClient.ts
 *
 * Thin HTTP client the gateway uses to forward client requests to
 * whichever cache node the consistent hash ring says owns a key, and
 * to poll each node's `/metrics` for cluster-wide aggregation.
 */

import {
  KeyNotFoundError,
  NodeUnavailableError,
  type DeleteResponseBody,
  type GetResponseBody,
  type MetricsSnapshot,
  type NodeInfo,
  type PutRequestBody,
  type PutResponseBody,
} from '@flowcache/shared';

export interface CacheNodeClientOptions {
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class CacheNodeClient {
  private readonly timeoutMs: number;

  constructor(options: CacheNodeClientOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  baseUrlFor(node: NodeInfo): string {
    return `http://${node.host}:${node.port}`;
  }

  async get(node: NodeInfo, key: string): Promise<GetResponseBody> {
    const response = await this.fetchWithTimeout(node, `${this.baseUrlFor(node)}/cache/${encodeURIComponent(key)}`);
    if (response.status === 404) {
      throw new KeyNotFoundError(key);
    }
    if (!response.ok) {
      throw new NodeUnavailableError(node.nodeId, new Error(`GET returned status ${response.status}`));
    }
    return (await response.json()) as GetResponseBody;
  }

  async put(node: NodeInfo, body: PutRequestBody): Promise<PutResponseBody> {
    const response = await this.fetchWithTimeout(node, `${this.baseUrlFor(node)}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new NodeUnavailableError(node.nodeId, new Error(`PUT returned status ${response.status}`));
    }
    return (await response.json()) as PutResponseBody;
  }

  async delete(node: NodeInfo, key: string): Promise<DeleteResponseBody> {
    const response = await this.fetchWithTimeout(node, `${this.baseUrlFor(node)}/cache/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new NodeUnavailableError(node.nodeId, new Error(`DELETE returned status ${response.status}`));
    }
    return (await response.json()) as DeleteResponseBody;
  }

  async getMetrics(node: NodeInfo): Promise<MetricsSnapshot> {
    const response = await this.fetchWithTimeout(node, `${this.baseUrlFor(node)}/metrics`);
    if (!response.ok) {
      throw new NodeUnavailableError(node.nodeId, new Error(`GET /metrics returned status ${response.status}`));
    }
    return (await response.json()) as MetricsSnapshot;
  }

  async getHealth(node: NodeInfo): Promise<{ status: string }> {
    const response = await this.fetchWithTimeout(node, `${this.baseUrlFor(node)}/health`);
    if (!response.ok) {
      throw new NodeUnavailableError(node.nodeId, new Error(`GET /health returned status ${response.status}`));
    }
    return (await response.json()) as { status: string };
  }

  private async fetchWithTimeout(node: NodeInfo, url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new NodeUnavailableError(node.nodeId, err);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}