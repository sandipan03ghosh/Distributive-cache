/**
 * @flowcache/worker-pool — types.ts
 *
 * Generic task envelope types used for all `postMessage` traffic
 * between the main thread (`WorkerPool`) and worker threads
 * (`workers/workerEntry.ts`), plus the payload/result contracts for
 * the four built-in task types this package ships (snapshot
 * serialization, replication encoding, expired-key cleanup scanning,
 * and benchmark request execution).
 */

import type { CacheEntry, ReplicationEvent } from '@flowcache/shared';

// ---------------------------------------------------------------------
// Generic task envelope
// ---------------------------------------------------------------------

export interface TaskRequest<P = unknown> {
  taskId: string;
  type: string;
  payload: P;
}

export interface TaskSuccessResult<R = unknown> {
  taskId: string;
  success: true;
  result: R;
  durationMs: number;
}

export interface TaskErrorResult {
  taskId: string;
  success: false;
  error: { message: string; stack?: string };
  durationMs: number;
}

export type TaskResult<R = unknown> = TaskSuccessResult<R> | TaskErrorResult;

export type TaskHandler<P = unknown, R = unknown> = (payload: P) => Promise<R> | R;

export interface WorkerPoolOptions {
  /** Number of worker threads to keep alive in the pool. */
  size: number;
  /** Absolute path to the compiled worker entry script. Defaults to
   *  this package's own `workers/workerEntry.js`, which has the four
   *  built-in handlers below pre-registered. Pass a custom path if a
   *  service needs additional task types alongside (or instead of)
   *  the built-ins. */
  workerScriptPath?: string;
  /** Default per-task timeout; individual `submitTask` calls may
   *  override this. 0 disables timeouts entirely. */
  taskTimeoutMs?: number;
  /** Arbitrary data made available to every worker via
   *  `worker_threads.workerData`. */
  workerData?: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Built-in task contracts
// ---------------------------------------------------------------------

/** Offloads JSON serialization + optional gzip + SHA-256 checksumming
 *  of a full cache snapshot off the main thread. Used by
 *  `services/cache-node` in place of calling this logic synchronously
 *  inside `SnapshotManager` when the cache is large enough that doing
 *  it on the main thread would stall request handling. */
export interface SnapshotSerializePayload {
  entries: CacheEntry[];
  compress: boolean;
}
export interface SnapshotSerializeResult {
  buffer: Buffer;
  checksum: string;
  sizeBytes: number;
}

/** Offloads encoding (+ optional compression) of a batch of
 *  replication events before they're published to Kafka, so encoding a
 *  large replication burst doesn't compete with request handling on
 *  the main thread. */
export interface ReplicationEncodePayload {
  events: ReplicationEvent[];
  compress: boolean;
}
export interface ReplicationEncodeResult {
  buffer: Buffer;
  sizeBytes: number;
  eventCount: number;
}

/** Scans a batch of entries for expired keys off the main thread.
 *  `StorageEngine.sweepExpired()` already does a cheap in-process
 *  sweep for the common case; this exists for very large caches where
 *  even that linear scan is worth moving off the request-handling
 *  thread. */
export interface CleanupFindExpiredPayload {
  entries: CacheEntry[];
  nowMs: number;
}
export interface CleanupFindExpiredResult {
  expiredKeys: string[];
}

/** Executes a pre-generated sequence of HTTP operations against a
 *  running FlowCache gateway/cache-node and reports per-operation
 *  latency. `packages/benchmark` generates the *workload* (which keys,
 *  which distribution, read/write mix) cheaply on the main thread and
 *  fans the resulting operation list out across pool workers so many
 *  concurrent virtual clients can hammer the target in parallel without
 *  the benchmark driver's own event loop becoming the bottleneck. */
export interface BenchmarkOperation {
  op: 'GET' | 'PUT' | 'DELETE';
  key: string;
  value?: unknown;
  ttlMs?: number;
}
export interface BenchmarkExecuteOpsPayload {
  targetBaseUrl: string;
  operations: BenchmarkOperation[];
  requestTimeoutMs?: number;
}
export interface BenchmarkExecuteOpsResult {
  latenciesMs: number[];
  errors: number;
  opCounts: { GET: number; PUT: number; DELETE: number };
}