/**
 * @flowcache/gateway — GatewayServer.ts
 *
 * The composition root for the API Gateway. Builds a consistent hash
 * ring from static cluster membership, starts a background health
 * tracker that keeps that ring's node statuses accurate, and wires up
 * every HTTP route.
 */

import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import { NodeStatus, createLogger, nowMs, type GatewayConfig, type Logger } from '@flowcache/shared';
import { ConsistentHashRing } from '@flowcache/consistent-hash';

import type { GatewayContext } from './GatewayContext.js';
import { CacheNodeClient } from './discovery/CacheNodeClient.js';
import { NodeHealthTracker } from './discovery/NodeHealthTracker.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.js';
import { createHealthRoutes } from './routes/healthRoutes.js';
import { createClusterRoutes } from './routes/clusterRoutes.js';
import { createMetricsRoutes } from './routes/metricsRoutes.js';
import { createCacheRoutes } from './routes/cacheRoutes.js';

/** Number of ring candidates (primary + replicas) the gateway will try
 *  before giving up on a request. Should be >= the cache nodes'
 *  REPLICATION_FACTOR so a primary failure genuinely has a replica to
 *  fail over to. */
const FAILOVER_CANDIDATE_COUNT = 3;

export class GatewayServer {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly ring: ConsistentHashRing;
  private readonly client: CacheNodeClient;
  private readonly healthTracker: NodeHealthTracker;
  private readonly app: Express;
  private httpServer: Server | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.logger = createLogger({ service: 'gateway' });

    this.ring = new ConsistentHashRing({ baseVirtualNodeCount: config.virtualNodeCount });
    for (const node of config.staticNodes) {
      this.ring.addNode({
        nodeId: node.nodeId,
        host: node.host,
        port: node.port,
        weight: node.weight,
        // Starts as JOINING; the health tracker's first poll cycle
        // (kicked off immediately in start()) promotes it to HEALTHY
        // as soon as its /health check succeeds.
        status: NodeStatus.JOINING,
        lastHeartbeat: nowMs(),
      });
    }

    this.client = new CacheNodeClient();
    this.healthTracker = new NodeHealthTracker({
      ring: this.ring,
      client: this.client,
      intervalMs: config.healthCheckIntervalMs,
      suspectAfterMisses: config.suspectAfterMisses,
      deadAfterMisses: config.deadAfterMisses,
      logger: this.logger,
    });

    this.app = express();
    this.configureExpress();
  }

  private configureExpress(): void {
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '5mb' }));
    this.app.use(requestLoggerMiddleware(this.logger));

    const ctx: GatewayContext = {
      logger: this.logger,
      ring: this.ring,
      client: this.client,
      replicationFactorForFailover: FAILOVER_CANDIDATE_COUNT,
    };

    this.app.use(createHealthRoutes());
    this.app.use(createClusterRoutes(ctx));
    this.app.use(createMetricsRoutes(ctx));
    this.app.use(createCacheRoutes(ctx));

    this.app.use(errorHandlerMiddleware(this.logger));
  }

  async start(): Promise<void> {
    this.healthTracker.start();

    await new Promise<void>((resolve) => {
      this.httpServer = createServer(this.app);
      this.httpServer.listen(this.config.port, this.config.host, () => resolve());
    });

    this.logger.info({ host: this.config.host, port: this.config.port }, 'Gateway listening');
  }

  async stop(): Promise<void> {
    this.logger.info('Shutting down gateway');
    this.healthTracker.stop();

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }

    this.logger.info('Gateway shut down cleanly');
  }
}