/**
 * @flowcache/shared — types.ts
 *
 * Central domain type definitions shared by every service and package
 * in the FlowCache system. Keeping these in one place guarantees wire
 * compatibility between the gateway, cache nodes, and the dashboard.
 */

// ---------------------------------------------------------------------------
// Cache primitives
// ---------------------------------------------------------------------------

export type CacheKey = string;

export interface CacheMetadata {
  /** Monotonically increasing version, bumped on every write (used for
   *  conflict resolution during replication and recovery replay). */
  version: number;
  /** Epoch millis this entry was created. */
  createdAt: number;
  /** Epoch millis this entry was last written. */
  updatedAt: number;
  /** Epoch millis this entry was last read. Used by LRU / TinyLFU. */
  lastAccessedAt: number;
  /** Number of times this entry has been read. Used by LFU / TinyLFU. */
  frequency: number;
  /** Epoch millis at which this entry expires, or null for no TTL. */
  expiresAt: number | null;
  /** Approximate size in bytes of the serialized value, used for memory
   *  accounting and eviction decisions. */
  sizeBytes: number;
}

export interface CacheEntry<V = unknown> {
  key: CacheKey;
  value: V;
  metadata: CacheMetadata;
}

export interface StorageStats {
  entryCount: number;
  totalSizeBytes: number;
  hits: number;
  misses: number;
  expirations: number;
  evictions: number;
  writes: number;
  deletes: number;
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

export enum EvictionPolicyType {
  LRU = 'LRU',
  LFU = 'LFU',
  TINY_LFU = 'TINY_LFU',
}

export interface EvictionDecision {
  policy: EvictionPolicyType;
  victimKey: CacheKey | null;
  reason: string;
}

/** Workload signal snapshot fed into the AdaptiveEvictionEngine. */
export interface WorkloadSignals {
  hitRate: number;
  missRate: number;
  memoryUsageRatio: number; // 0..1, current size / max size
  writeRatio: number; // writes / (reads + writes) over the window
  readRatio: number;
  frequencySkew: number; // Gini-like coefficient of access frequency, 0..1
  sequentialAccessScore: number; // 0..1, fraction of accesses that were sequential scans
  workingSetSizeRatio: number; // distinct keys touched / capacity, 0..1
  windowSampleCount: number;
}

export interface PolicySwitchEvent {
  timestamp: number;
  fromPolicy: EvictionPolicyType;
  toPolicy: EvictionPolicyType;
  reason: string;
  signals: WorkloadSignals;
}

// ---------------------------------------------------------------------------
// Cluster / consistent hashing
// ---------------------------------------------------------------------------

export interface NodeInfo {
  nodeId: string;
  host: string;
  port: number;
  status: NodeStatus;
  lastHeartbeat: number;
  weight: number; // relative capacity, affects virtual node count
}

export enum NodeStatus {
  JOINING = 'JOINING',
  HEALTHY = 'HEALTHY',
  SUSPECT = 'SUSPECT',
  DEAD = 'DEAD',
  LEAVING = 'LEAVING',
}

export interface RingAssignment {
  nodeId: string;
  virtualNodeHash: number;
}

// ---------------------------------------------------------------------------
// Replication / Kafka event bus
// ---------------------------------------------------------------------------

export enum KafkaTopic {
  CACHE_PUT = 'cache.put',
  CACHE_DELETE = 'cache.delete',
  CACHE_REPLICATION = 'cache.replication',
  CACHE_SNAPSHOT = 'cache.snapshot',
  CACHE_METRICS = 'cache.metrics',
  NODE_JOIN = 'cache.node.join',
  NODE_LEAVE = 'cache.node.leave',
}

export interface ReplicationEvent {
  eventId: string;
  sourceNodeId: string;
  key: CacheKey;
  op: 'PUT' | 'DELETE';
  value?: unknown;
  metadata?: CacheMetadata;
  timestamp: number;
}

export interface ReplicationAck {
  eventId: string;
  replicaNodeId: string;
  success: boolean;
  appliedAt: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Snapshot / recovery
// ---------------------------------------------------------------------------

export interface SnapshotMetadata {
  snapshotId: string;
  nodeId: string;
  createdAt: number;
  entryCount: number;
  sizeBytes: number;
  durationMs: number;
  checksum: string;
  compressed: boolean;
}

export interface SnapshotPayload {
  metadata: SnapshotMetadata;
  entries: CacheEntry[];
}

export interface RecoveryReport {
  nodeId: string;
  startedAt: number;
  finishedAt: number;
  snapshotRestored: string | null;
  entriesRestoredFromSnapshot: number;
  operationsReplayed: number;
  integrityVerified: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface MetricsSnapshot {
  nodeId: string;
  timestamp: number;
  hits: number;
  misses: number;
  hitRatio: number;
  evictions: number;
  entryCount: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  requestsPerSecond: number;
  latency: LatencyPercentiles;
  replicationQueueDepth: number;
  lastSnapshotDurationMs: number | null;
  currentEvictionPolicy: EvictionPolicyType;
  nodeStatus: NodeStatus;
}

// ---------------------------------------------------------------------------
// HTTP DTOs (Gateway <-> Cache Node <-> Client)
// ---------------------------------------------------------------------------

export interface PutRequestBody {
  key: CacheKey;
  value: unknown;
  ttlMs?: number;
}

export interface PutResponseBody {
  key: CacheKey;
  version: number;
  nodeId: string;
  replicated: boolean;
}

export interface GetResponseBody {
  key: CacheKey;
  value: unknown;
  metadata: CacheMetadata;
  nodeId: string;
}

export interface DeleteResponseBody {
  key: CacheKey;
  deleted: boolean;
  nodeId: string;
}

export interface ClusterView {
  nodes: NodeInfo[];
  ring: RingAssignment[];
  virtualNodesPerNode: number;
  totalKeys: number;
}

export interface HealthCheckResponse {
  nodeId: string;
  status: NodeStatus;
  uptimeMs: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

export interface FaultInjectionCommand {
  type: 'KILL' | 'RESTART' | 'DELAY_REPLICATION' | 'DROP_MESSAGES';
  targetNodeId: string;
  durationMs?: number;
  dropRate?: number; // 0..1, used with DROP_MESSAGES
}

export type Serializable =
  | string
  | number
  | boolean
  | null
  | Serializable[]
  | { [key: string]: Serializable };