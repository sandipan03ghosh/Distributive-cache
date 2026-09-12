import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { StorageEngine } from '@flowcache/storage-engine';
import { AdaptiveEvictionEngine } from '@flowcache/eviction';
import { MetricsCollector } from '@flowcache/metrics';
import { NodeStatus, createLogger } from '@flowcache/shared';

// Route factories and FaultInjector live in the cache-node service,
// not a published package — imported by relative path since this is
// an in-repo integration test, not an external consumer.
import { FaultInjector } from '../../services/cache-node/src/fault/FaultInjector.js';
import type { CacheNodeContext } from '../../services/cache-node/src/CacheNodeContext.js';
import { createCacheRoutes } from '../../services/cache-node/src/routes/cacheRoutes.js';
import { createHealthRoutes } from '../../services/cache-node/src/routes/healthRoutes.js';
import { createMetricsRoutes } from '../../services/cache-node/src/routes/metricsRoutes.js';
import { createInternalRoutes } from '../../services/cache-node/src/routes/internalRoutes.js';
import { killSwitchMiddleware } from '../../services/cache-node/src/middleware/killSwitch.js';
import { errorHandlerMiddleware } from '../../services/cache-node/src/middleware/errorHandler.js';

describe('cache-node HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let evictionEngine: AdaptiveEvictionEngine;
  let restartCalls = 0;

  beforeAll(async () => {
    const storage = new StorageEngine({ maxSizeBytes: 1_000_000, activeSweepIntervalMs: 0 });
    evictionEngine = new AdaptiveEvictionEngine({ evaluationIntervalMs: 0 });
    evictionEngine.attachStorage(
      storage,
      () => 0,
      () => [...storage.entries()],
    );

    const metricsCollector = new MetricsCollector({ nodeId: 'test-node' });
    metricsCollector.attachStorageStats(() => storage.getStats());
    metricsCollector.attachMemoryLimit(() => 1_000_000);
    metricsCollector.attachEvictionPolicyGetter(() => evictionEngine.getCurrentPolicy());
    metricsCollector.attachNodeStatusGetter(() => NodeStatus.HEALTHY);

    const faultInjector = new FaultInjector();

    const ctx: CacheNodeContext = {
      nodeId: 'test-node',
      logger: createLogger({ service: 'test', level: 'silent' as never }),
      storage,
      evictionEngine,
      metricsCollector,
      faultInjector,
      // No real Kafka in this test — replication is a stubbed no-op.
      replicateWrite: async () => [],
      replicateDelete: async () => [],
      onRestart: async () => {
        restartCalls += 1;
      },
    };

    const app = express();
    app.use(express.json());
    app.use(createHealthRoutes(ctx));
    app.use(createInternalRoutes(ctx));
    app.use(killSwitchMiddleware(ctx));
    app.use(createCacheRoutes(ctx));
    app.use(createMetricsRoutes(ctx));
    app.use(errorHandlerMiddleware(ctx.logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    evictionEngine.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('PUT then GET returns the stored value', async () => {
    const putRes = await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'greeting', value: 'hello world' }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.version).toBe(1);

    const getRes = await fetch(`${baseUrl}/cache/greeting`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.value).toBe('hello world');
  });

  it('GET on a missing key returns 404 with a structured error body', async () => {
    const res = await fetch(`${baseUrl}/cache/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('KEY_NOT_FOUND');
  });

  it('DELETE removes the key; a second DELETE reports deleted: false', async () => {
    await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'temp', value: 1 }),
    });

    const first = await fetch(`${baseUrl}/cache/temp`, { method: 'DELETE' });
    expect((await first.json()).deleted).toBe(true);

    const second = await fetch(`${baseUrl}/cache/temp`, { method: 'DELETE' });
    expect((await second.json()).deleted).toBe(false);
  });

  it('PUT without a "value" field returns 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${baseUrl}/cache`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'bad' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /health always returns 200 with a status field', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('HEALTHY');
  });

  it('GET /metrics reflects recorded traffic', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeId).toBe('test-node');
    expect(typeof body.hitRatio).toBe('number');
  });

  it('fault injection KILL causes /cache/* to 503, and RESTART recovers it', async () => {
    const killRes = await fetch(`${baseUrl}/internal/fault-injection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'KILL', targetNodeId: 'test-node' }),
    });
    expect(killRes.status).toBe(200);

    const duringKill = await fetch(`${baseUrl}/cache/greeting`);
    expect(duringKill.status).toBe(503);

    // Health check should still be reachable and reflect DEAD.
    const health = await fetch(`${baseUrl}/health`);
    expect((await health.json()).status).toBe('DEAD');

    const restartRes = await fetch(`${baseUrl}/internal/fault-injection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'RESTART', targetNodeId: 'test-node' }),
    });
    expect(restartRes.status).toBe(200);
    expect(restartCalls).toBeGreaterThan(0);

    const afterRestart = await fetch(`${baseUrl}/health`);
    expect((await afterRestart.json()).status).toBe('HEALTHY');
  });

  it('POST /internal/policy pins a specific eviction policy', async () => {
    const res = await fetch(`${baseUrl}/internal/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'LFU' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentPolicy).toBe('LFU');
    expect(body.autoSwitchEnabled).toBe(false);
  });

  it('GET /internal/replicate/export returns the full local entry set', async () => {
    const res = await fetch(`${baseUrl}/internal/replicate/export`);
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(Array.isArray(entries)).toBe(true);
  });
});