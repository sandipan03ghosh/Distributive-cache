/**
 * @flowcache/cache-node — CacheNodeServer.ts
 *
 * The composition root for a single cache node. Wires together every
 * package into one running service:
 *
 *   AdaptiveEvictionEngine  --(evictionHook)-->  StorageEngine
 *   StorageEngine           --(events)-------->  AdaptiveEvictionEngine (signals)
 *   StorageEngine           --(events)-------->  MetricsCollector
 *   ConsistentHashRing      --(replica lookup)->  ReplicationEngine
 *   ReplicationEngine       --(remote writes)-->  StorageEngine
 *   WorkerPool              --(cleanup task)---->  StorageEngine (expired-key sweep)
 *   WorkerPool              --(serialize task)-->  SnapshotManager
 *   SnapshotManager         --(restore)--------->  StorageEngine (via RecoveryEngine, at startup)
 *   FaultInjector           --(gates)------------> replication publish + HTTP routes
 *
 * Architecture note on Kafka vs HTTP: GET requests are always
 * synchronous plain HTTP against local storage — Kafka is never in the
 * critical path of a read. PUT/DELETE apply to local storage
 * synchronously (so the client's response reflects a durable local
 * write) and then publish an asynchronous replication event; the
 * client does not wait for replicas to ack.
 */

import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import {
  NodeStatus,
  createLogger,
  nowMs,
  type CacheEntry,
  type CacheKey,
  type CacheMetadata,
  type Logger,
  type CacheNodeConfig,
} from '@flowcache/shared';
import { StorageEngine } from '@flowcache/storage-engine';
import { AdaptiveEvictionEngine } from '@flowcache/eviction';
import { ConsistentHashRing } from '@flowcache/consistent-hash';
import { MetricsCollector } from '@flowcache/metrics';
import { SnapshotManager } from '@flowcache/snapshot';
import {
  WorkerPool,
  TaskTypes,
  type CleanupFindExpiredPayload,
  type CleanupFindExpiredResult,
  type SnapshotSerializePayload,
  type SnapshotSerializeResult,
} from '@flowcache/worker-pool';
import { KafkaEventBus, ReplicationEngine } from '@flowcache/replication';

import type { CacheNodeContext } from './CacheNodeContext.js';
import { FaultInjector } from './fault/FaultInjector.js';
import { RecoveryEngine } from './recovery/RecoveryEngine.js';
import { requestTimingMiddleware } from './middleware/requestTiming.js';
import { killSwitchMiddleware } from './middleware/killSwitch.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.js';
import { createCacheRoutes } from './routes/cacheRoutes.js';
import { createMetricsRoutes } from './routes/metricsRoutes.js';
import { createHealthRoutes } from './routes/healthRoutes.js';
import { createInternalRoutes } from './routes/internalRoutes.js';

/** Total number of nodes (primary + replicas) that should hold a copy
 *  of any given key. Kept as a simple constant rather than a config
 *  knob for this build — a natural next step would be
 *  `CacheNodeConfig.replicationFactor`. */
const REPLICATION_FACTOR = 2;

/** How often the worker-pool-driven background cleanup sweep runs. */
const CLEANUP_INTERVAL_MS = 15_000;

export class CacheNodeServer {
  private readonly config: CacheNodeConfig;
  private readonly logger: Logger;

  private readonly ring: ConsistentHashRing;
  private readonly evictionEngine: AdaptiveEvictionEngine;
  private readonly storage: StorageEngine;
  private readonly metricsCollector: MetricsCollector;
  private readonly workerPool: WorkerPool;
  private readonly snapshotManager: SnapshotManager;
  private readonly eventBus: KafkaEventBus;
  private readonly replicationEngine: ReplicationEngine;
  private readonly faultInjector: FaultInjector;
  private readonly recoveryEngine: RecoveryEngine;

  private readonly app: Express;
  private httpServer: Server | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: CacheNodeConfig) {
    this.config = config;
    this.logger = createLogger({ service: 'cache-node', nodeId: config.nodeId });
    this.faultInjector = new FaultInjector();

    // --- Ring (local copy, for computing replica targets) ----------
    this.ring = new ConsistentHashRing({ baseVirtualNodeCount: config.virtualNodeCount });
    for (const node of config.staticNodes) {
      this.ring.addNode({
        nodeId: node.nodeId,
        host: node.host,
        port: node.port,
        weight: node.weight,
        status: NodeStatus.HEALTHY,
        lastHeartbeat: nowMs(),
      });
    }

    // --- Eviction (created before storage; storage injects into it) -
    this.evictionEngine = new AdaptiveEvictionEngine();

    // --- Storage ------------------------------------------------------
    this.storage = new StorageEngine({
      maxEntries: Infinity,
      maxSizeBytes: config.maxMemoryBytes,
      defaultTtlMs: config.defaultTtlMs,
      evictionHook: this.evictionEngine,
      // The worker-pool-driven cleanup loop below handles active
      // expiration sweeps; disabling the engine's own internal timer
      // avoids doing that scan twice.
      activeSweepIntervalMs: 0,
    });

    this.evictionEngine.attachStorage(
      this.storage,
      () => this.storage.sizeBytes() / config.maxMemoryBytes,
      () => [...this.storage.entries()],
    );

    // --- Metrics --------------------------------------------------
    this.metricsCollector = new MetricsCollector({ nodeId: config.nodeId });
    this.metricsCollector.attachStorageStats(() => this.storage.getStats());
    this.metricsCollector.attachMemoryLimit(() => config.maxMemoryBytes);
    this.metricsCollector.attachEvictionPolicyGetter(() => this.evictionEngine.getCurrentPolicy());
    this.metricsCollector.attachNodeStatusGetter(() =>
      this.faultInjector.isKilled() ? NodeStatus.DEAD : NodeStatus.HEALTHY,
    );

    // --- Worker pool (cleanup + snapshot serialization offload) ----
    this.workerPool = new WorkerPool({ size: config.workerPool.size });

    // --- Snapshot (serialization delegated to the worker pool) -----
    this.snapshotManager = new SnapshotManager({
      nodeId: config.nodeId,
      directory: config.snapshot.directory,
      intervalMs: config.snapshot.intervalMs,
      compress: config.snapshot.compress,
      getEntries: () => [...this.storage.entries()],
      serialize: async (entries, compress) => {
        const result = await this.workerPool.submitTask<SnapshotSerializePayload, SnapshotSerializeResult>(
          TaskTypes.SNAPSHOT_SERIALIZE,
          { entries: [...entries], compress },
        );
        return { buffer: result.buffer, checksum: result.checksum };
      },
    });
    this.snapshotManager.on('snapshot', (metadata) => {
      this.metricsCollector.recordSnapshotDuration(metadata.durationMs);
      this.logger.info({ metadata }, 'Snapshot completed');
    });
    this.snapshotManager.on('error', (err: unknown) => {
      this.logger.error({ err }, 'Snapshot failed');
    });

    // --- Replication (Kafka) ---------------------------------------
    this.eventBus = new KafkaEventBus({
      brokers: config.kafka.brokers,
      clientId: config.kafka.clientId,
      consumerGroup: config.kafka.consumerGroup,
      logger: this.logger,
    });

    this.replicationEngine = new ReplicationEngine({
      nodeId: config.nodeId,
      eventBus: this.eventBus,
      getReplicaNodeIds: (key: CacheKey) => this.ring.getNodesForKey(key, REPLICATION_FACTOR),
      applyRemoteWrite: (key, value, metadata) => this.applyRemoteWrite(key, value, metadata),
      applyRemoteDelete: (key) => this.applyRemoteDelete(key),
    });

    // --- Recovery ----------------------------------------------------
    this.recoveryEngine = new RecoveryEngine({
      nodeId: config.nodeId,
      snapshotManager: this.snapshotManager,
      applyEntry: (entry) => this.applyRestoredEntry(entry),
      clearStorage: () => this.storage.clear(),
      logger: this.logger,
    });

    // --- HTTP ----------------------------------------------------------
    this.app = express();
    this.configureExpress();
  }

  // -----------------------------------------------------------------
  // Express wiring
  // -----------------------------------------------------------------

  private configureExpress(): void {
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '5mb' }));

    const ctx: CacheNodeContext = {
      nodeId: this.config.nodeId,
      logger: this.logger,
      storage: this.storage,
      evictionEngine: this.evictionEngine,
      metricsCollector: this.metricsCollector,
      faultInjector: this.faultInjector,
      replicateWrite: (key, value, metadata) => this.replicateWriteWithFaults(key, value, metadata),
      replicateDelete: (key) => this.replicateDeleteWithFaults(key),
      onRestart: () => this.handleRestart(),
    };

    this.app.use(requestTimingMiddleware(ctx));

    // Health and internal routes stay reachable even while "killed" —
    // see the doc comment on killSwitchMiddleware.
    this.app.use(createHealthRoutes(ctx));
    this.app.use(createInternalRoutes(ctx));

    this.app.use(killSwitchMiddleware(ctx));
    this.app.use(createCacheRoutes(ctx));
    this.app.use(createMetricsRoutes(ctx));

    this.app.use(errorHandlerMiddleware(this.logger));
  }

  // -----------------------------------------------------------------
  // Replication helpers (fault-injection aware)
  // -----------------------------------------------------------------

  private async replicateWriteWithFaults(key: CacheKey, value: unknown, metadata: CacheMetadata): Promise<string[]> {
    if (this.faultInjector.shouldDropReplicationMessage()) {
      this.logger.debug({ key }, 'Fault injection: dropping replication PUT message');
      return [];
    }
    await this.applyReplicationDelay();
    return this.replicationEngine.replicateWrite(key, value, metadata);
  }

  private async replicateDeleteWithFaults(key: CacheKey): Promise<string[]> {
    if (this.faultInjector.shouldDropReplicationMessage()) {
      this.logger.debug({ key }, 'Fault injection: dropping replication DELETE message');
      return [];
    }
    await this.applyReplicationDelay();
    return this.replicationEngine.replicateDelete(key);
  }

  private async applyReplicationDelay(): Promise<void> {
    const delayMs = this.faultInjector.getReplicationDelayMs();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // -----------------------------------------------------------------
  // Applying remote/restored data to local storage
  // -----------------------------------------------------------------

  private applyRemoteWrite(key: CacheKey, value: unknown, metadata: CacheMetadata): void {
    const existing = this.storage.peek(key);
    // Last-writer-wins by version: only apply if the incoming write is
    // at least as new as what's already here, so an out-of-order
    // replay (possible with Kafka's at-least-once delivery) can't
    // clobber a newer local value with a stale one.
    if (existing && existing.metadata.version >= metadata.version) {
      return;
    }
    const ttlMs = metadata.expiresAt !== null ? Math.max(0, metadata.expiresAt - nowMs()) : undefined;
    this.storage.set(key, value, { ttlMs });
  }

  private applyRemoteDelete(key: CacheKey): void {
    this.storage.delete(key);
  }

  private applyRestoredEntry(entry: CacheEntry): void {
    const ttlMs = entry.metadata.expiresAt !== null ? Math.max(0, entry.metadata.expiresAt - nowMs()) : undefined;
    this.storage.set(entry.key, entry.value, { ttlMs });
  }

  // -----------------------------------------------------------------
  // Background cleanup (worker-pool driven — never blocks requests)
  // -----------------------------------------------------------------

  private startBackgroundCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanupSweep().catch((err: unknown) => {
        this.logger.warn({ err }, 'Background cleanup sweep failed');
      });
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  private async runCleanupSweep(): Promise<void> {
    const entries = [...this.storage.entries()];
    if (entries.length === 0) return;

    const result = await this.workerPool.submitTask<CleanupFindExpiredPayload, CleanupFindExpiredResult>(
      TaskTypes.CLEANUP_FIND_EXPIRED,
      { entries, nowMs: nowMs() },
    );

    for (const key of result.expiredKeys) {
      this.storage.delete(key);
    }
    if (result.expiredKeys.length > 0) {
      this.logger.debug({ count: result.expiredKeys.length }, 'Background cleanup removed expired keys');
    }
  }

  // -----------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------

  async start(): Promise<void> {
    const report = await this.recoveryEngine.recover();
    this.recoveryEngine.assertHealthy(report);

    await this.replicationEngine.start();
    this.snapshotManager.start();
    this.startBackgroundCleanup();

    await new Promise<void>((resolve) => {
      this.httpServer = createServer(this.app);
      this.httpServer.listen(this.config.port, this.config.host, () => resolve());
    });

    this.logger.info(
      { host: this.config.host, port: this.config.port, nodeId: this.config.nodeId },
      'Cache node listening',
    );
  }

  private async handleRestart(): Promise<void> {
    this.logger.info('Fault injection RESTART received — re-running recovery');
    const report = await this.recoveryEngine.recover();
    this.recoveryEngine.assertHealthy(report);
    this.faultInjector.reset();
  }

  async stop(): Promise<void> {
    this.logger.info('Shutting down cache node');

    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.snapshotManager.stop();

    // Take a final snapshot on the way down so a clean shutdown never
    // loses writes that happened since the last periodic snapshot.
    try {
      await this.snapshotManager.takeSnapshot();
    } catch (err) {
      this.logger.warn({ err }, 'Final shutdown snapshot failed');
    }

    await this.replicationEngine.dispose();
    await this.eventBus.disconnect();
    await this.workerPool.dispose();
    this.evictionEngine.dispose();
    this.storage.dispose();

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }

    this.logger.info('Cache node shut down cleanly');
  }
}