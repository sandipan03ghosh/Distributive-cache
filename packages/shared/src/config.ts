/**
 * @flowcache/shared — config.ts
 *
 * Centralized, typed configuration loading from environment variables.
 * Every service calls one of the `load*Config` functions at startup so
 * that config shape and defaults live in exactly one place.
 */

import { ConfigurationError } from './errors.js';

function readString(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }
  return v;
}

function readNumber(key: string, fallback?: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new ConfigurationError(`Environment variable ${key} must be numeric, got "${v}"`);
  }
  return n;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function readList(key: string, fallback: string[] = []): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Static node list — shared by cache-node and gateway configs. Both read
// the same STATIC_NODES value (same format, same default) so the ring
// membership every service computes locally stays identical.
// ---------------------------------------------------------------------------

export interface StaticNodeEntry {
  nodeId: string;
  host: string;
  port: number;
  weight: number;
}

const DEFAULT_STATIC_NODES =
  'node-1:cache-node-1:4001:1,node-2:cache-node-2:4001:1,node-3:cache-node-3:4001:1';

export function parseStaticNodes(raw: string): StaticNodeEntry[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [nodeId, host, portStr, weightStr] = entry.split(':');
      if (!nodeId || !host || !portStr) {
        throw new ConfigurationError(`Malformed STATIC_NODES entry: "${entry}"`);
      }
      return {
        nodeId,
        host,
        port: Number(portStr),
        weight: weightStr ? Number(weightStr) : 1,
      };
    });
}

// ---------------------------------------------------------------------------
// Cache Node config
// ---------------------------------------------------------------------------

export interface CacheNodeConfig {
  nodeId: string;
  host: string;
  port: number;
  weight: number;
  maxMemoryBytes: number;
  defaultTtlMs: number | null;
  virtualNodeCount: number;
  snapshot: {
    intervalMs: number;
    directory: string;
    compress: boolean;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    consumerGroup: string;
  };
  workerPool: {
    size: number;
  };
  gatewayUrl: string;
  seedNodes: string[]; // other cache node base URLs, for ring bootstrap
  staticNodes: StaticNodeEntry[]; // full ring membership — see parseStaticNodes
}

export function loadCacheNodeConfig(): CacheNodeConfig {
  const nodeId = readString('NODE_ID');
  return {
    nodeId,
    host: readString('HOST', '0.0.0.0'),
    port: readNumber('PORT', 4001),
    weight: readNumber('NODE_WEIGHT', 1),
    maxMemoryBytes: readNumber('MAX_MEMORY_BYTES', 128 * 1024 * 1024),
    defaultTtlMs: process.env.DEFAULT_TTL_MS ? readNumber('DEFAULT_TTL_MS') : null,
    virtualNodeCount: readNumber('VIRTUAL_NODE_COUNT', 128),
    snapshot: {
      intervalMs: readNumber('SNAPSHOT_INTERVAL_MS', 60_000),
      directory: readString('SNAPSHOT_DIR', `/data/snapshots/${nodeId}`),
      compress: readBoolean('SNAPSHOT_COMPRESS', true),
    },
    kafka: {
      brokers: readList('KAFKA_BROKERS', ['localhost:9092']),
      clientId: readString('KAFKA_CLIENT_ID', `flowcache-${nodeId}`),
      consumerGroup: readString('KAFKA_CONSUMER_GROUP', `flowcache-node-group`),
    },
    workerPool: {
      size: readNumber('WORKER_POOL_SIZE', 4),
    },
    gatewayUrl: readString('GATEWAY_URL', 'http://gateway:4000'),
    seedNodes: readList('SEED_NODES', []),
    staticNodes: parseStaticNodes(readString('STATIC_NODES', DEFAULT_STATIC_NODES)),
  };
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  port: number;
  host: string;
  virtualNodeCount: number;
  healthCheckIntervalMs: number;
  healthCheckTimeoutMs: number;
  suspectAfterMisses: number;
  deadAfterMisses: number;
  staticNodes: StaticNodeEntry[];
}

export function loadGatewayConfig(): GatewayConfig {
  const staticNodes = parseStaticNodes(readString('STATIC_NODES', DEFAULT_STATIC_NODES));

  return {
    port: readNumber('PORT', 4000),
    host: readString('HOST', '0.0.0.0'),
    virtualNodeCount: readNumber('VIRTUAL_NODE_COUNT', 128),
    healthCheckIntervalMs: readNumber('HEALTH_CHECK_INTERVAL_MS', 5_000),
    healthCheckTimeoutMs: readNumber('HEALTH_CHECK_TIMEOUT_MS', 2_000),
    suspectAfterMisses: readNumber('SUSPECT_AFTER_MISSES', 2),
    deadAfterMisses: readNumber('DEAD_AFTER_MISSES', 5),
    staticNodes,
  };
}

// ---------------------------------------------------------------------------
// Benchmark config
// ---------------------------------------------------------------------------

export interface BenchmarkConfig {
  targetBaseUrl: string;
  durationMs: number;
  concurrency: number;
  keyspaceSize: number;
  reportDirectory: string;
}

export function loadBenchmarkConfig(): BenchmarkConfig {
  return {
    targetBaseUrl: readString('BENCHMARK_TARGET_URL', 'http://localhost:4000'),
    durationMs: readNumber('BENCHMARK_DURATION_MS', 30_000),
    concurrency: readNumber('BENCHMARK_CONCURRENCY', 16),
    keyspaceSize: readNumber('BENCHMARK_KEYSPACE_SIZE', 10_000),
    reportDirectory: readString('BENCHMARK_REPORT_DIR', './reports'),
  };
}

export { readString, readNumber, readBoolean, readList };