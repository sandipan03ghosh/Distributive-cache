/**
 * @flowcache/cache-node — CacheNodeContext.ts
 *
 * The dependency bag every route module and middleware receives.
 * Keeping this as an explicit, narrow interface (rather than passing
 * around the whole `CacheNodeServer` instance) makes each route's
 * actual dependencies visible at a glance and keeps them independently
 * testable with a hand-built fake context.
 */

import type { CacheKey, CacheMetadata, Logger } from '@flowcache/shared';
import type { IStorageEngine } from '@flowcache/storage-engine';
import type { AdaptiveEvictionEngine } from '@flowcache/eviction';
import type { MetricsCollector } from '@flowcache/metrics';
import type { FaultInjector } from './fault/FaultInjector.js';

export interface CacheNodeContext {
  nodeId: string;
  logger: Logger;
  storage: IStorageEngine;
  evictionEngine: AdaptiveEvictionEngine;
  metricsCollector: MetricsCollector;
  faultInjector: FaultInjector;
  /** Replicates a write to this key's other ring-assigned nodes,
   *  already wrapped with fault-injection delay/drop behavior. Resolves
   *  with the list of node ids that acked (possibly empty/partial —
   *  see `ReplicationEngine`). */
  replicateWrite: (key: CacheKey, value: unknown, metadata: CacheMetadata) => Promise<string[]>;
  replicateDelete: (key: CacheKey) => Promise<string[]>;
  /** Re-runs recovery (restore from latest snapshot) — called after a
   *  fault-injected RESTART command. */
  onRestart: () => Promise<void>;
}