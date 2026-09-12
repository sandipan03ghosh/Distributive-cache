import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ConsistentHashRing } from '@flowcache/consistent-hash';
import { KeyNotFoundError, NodeStatus, NodeUnavailableError, createLogger, type NodeInfo } from '@flowcache/shared';

import type { GatewayContext } from '../../apps/gateway/src/GatewayContext.js';
import { createCacheRoutes } from '../../apps/gateway/src/routes/cacheRoutes.js';
import { errorHandlerMiddleware } from '../../apps/gateway/src/middleware/errorHandler.js';
import type { CacheNodeClient } from '../../apps/gateway/src/discovery/CacheNodeClient.js';

/** In-memory fake standing in for real cache nodes: each "node" is
 *  just a Map. The primary node ("a") always fails, so these tests
 *  can prove the gateway actually fails over to the next ring
 *  candidate rather than merely picking one node and hoping. */
function buildFakeClient(options: { failingNodeIds: Set<string> }): CacheNodeClient {
  const stores = new Map<string, Map<string, unknown>>();

  function storeFor(node: NodeInfo): Map<string, unknown> {
    let store = stores.get(node.nodeId);
    if (!store) {
      store = new Map();
      stores.set(node.nodeId, store);
    }
    return store;
  }

  return {
    baseUrlFor: (node: NodeInfo) => `http://${node.nodeId}`,
    get: async (node: NodeInfo, key: string) => {
      if (options.failingNodeIds.has(node.nodeId)) {
        throw new NodeUnavailableError(node.nodeId);
      }
      const store = storeFor(node);
      if (!store.has(key)) throw new KeyNotFoundError(key);
      return { key, value: store.get(key), metadata: {} as never, nodeId: node.nodeId };
    },
    put: async (node: NodeInfo, body: { key: string; value: unknown }) => {
      if (options.failingNodeIds.has(node.nodeId)) {
        throw new NodeUnavailableError(node.nodeId);
      }
      storeFor(node).set(body.key, body.value);
      return { key: body.key, version: 1, nodeId: node.nodeId, replicated: false };
    },
    delete: async (node: NodeInfo, key: string) => {
      if (options.failingNodeIds.has(node.nodeId)) {
        throw new NodeUnavailableError(node.nodeId);
      }
      const deleted = storeFor(node).delete(key);
      return { key, deleted, nodeId: node.nodeId };
    },
    getMetrics: async () => {
      throw new Error('not used in this test');
    },
    getHealth: async () => ({ status: 'HEALTHY' }),
  } as unknown as CacheNodeClient;
}

describe('gateway cache routing with failover', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 64 });
    const nodeA: NodeInfo = { nodeId: 'a', host: 'a', port: 1, weight: 1, status: NodeStatus.HEALTHY, lastHeartbeat: 0 };
    const nodeB: NodeInfo = { nodeId: 'b', host: 'b', port: 1, weight: 1, status: NodeStatus.HEALTHY, lastHeartbeat: 0 };
    ring.addNode(nodeA);
    ring.addNode(nodeB);

    // Node 'a' always fails its requests, forcing failover to 'b'
    // regardless of which one the ring picks as primary for a given key.
    const client = buildFakeClient({ failingNodeIds: new Set(['a']) });

    const ctx: GatewayContext = {
      logger: createLogger({ service: 'test', level: 'silent' as never }),
      ring,
      client,
      replicationFactorForFailover: 2,
    };

    const app = express();
    app.use(express.json());
    app.use(createCacheRoutes(ctx));
    app.use(errorHandlerMiddleware(ctx.logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('PUT succeeds by failing over to a healthy replica when the primary fails', async () => {
    const res = await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k1', value: 'v1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeId).toBe('b'); // only the non-failing node could have served this
  });

  it('GET after a successful PUT returns the value via failover too', async () => {
    await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k2', value: 'v2' }),
    });

    const res = await fetch(`${baseUrl}/cache/k2`);
    expect(res.status).toBe(200);
    expect((await res.json()).value).toBe('v2');
  });

  it('a genuine 404 (key not found) is NOT retried against another node', async () => {
    const res = await fetch(`${baseUrl}/cache/definitely-not-here`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('KEY_NOT_FOUND');
  });

  it('PUT with a missing "key" field returns 400', async () => {
    const res = await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'orphan' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('gateway cache routing with no healthy nodes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 32 });
    const deadNode: NodeInfo = { nodeId: 'dead', host: 'dead', port: 1, weight: 1, status: NodeStatus.DEAD, lastHeartbeat: 0 };
    ring.addNode(deadNode);

    const client = buildFakeClient({ failingNodeIds: new Set() });
    const ctx: GatewayContext = {
      logger: createLogger({ service: 'test', level: 'silent' as never }),
      ring,
      client,
      replicationFactorForFailover: 2,
    };

    const app = express();
    app.use(express.json());
    app.use(createCacheRoutes(ctx));
    app.use(errorHandlerMiddleware(ctx.logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 503 NO_HEALTHY_NODES when every ring candidate is DEAD', async () => {
    const res = await fetch(`${baseUrl}/cache/anything`);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('NO_HEALTHY_NODES');
  });
});