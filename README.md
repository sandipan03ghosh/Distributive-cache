# FlowCache

**An adaptive distributed cache with dynamic eviction policies.**

FlowCache automatically switches between LRU, LFU, and TinyLFU eviction
policies at runtime based on observed workload characteristics — no
manual tuning, no restarts. It's a from-scratch distributed systems
project built to demonstrate consistent hashing, asynchronous
replication, crash recovery, worker-thread concurrency, and
performance benchmarking, end to end, in TypeScript.

\`\`\`
Client
  │
  ▼
API Gateway  ──────────────────────────►  Consistent Hash Ring
  │                                              │
  ▼                                              ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ Cache Node 1│   │ Cache Node 2│   │ Cache Node 3│
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────────┬────┴────────┬────────┘
                     ▼             ▼
              Kafka Event Bus   Snapshot Storage
                     │
                     ▼
              Replication (async, primary → replicas)
\`\`\`

---

## Table of contents

- [Why FlowCache](#why-flowcache)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quickstart (Docker Compose)](#quickstart-docker-compose)
- [Local development](#local-development)
- [API reference](#api-reference)
- [Sequence diagrams](#sequence-diagrams)
- [Configuration](#configuration)
- [Testing](#testing)
- [Benchmarking](#benchmarking)
- [Fault injection](#fault-injection)
- [Design tradeoffs and known limitations](#design-tradeoffs-and-known-limitations)

---

## Why FlowCache

Real caches see workloads that shift over time: a burst of sequential
scans, a sudden hot key, a write-heavy migration window. A single
fixed eviction policy is never optimal for all of them. FlowCache's
**Adaptive Eviction Engine** (`packages/eviction`) continuously
measures hit rate, memory pressure, read/write ratio, key-popularity
skew, and sequential-access patterns, then applies a small,
deterministic (not ML-based) rule table to pick the best-fit policy:

| Signal | Chosen policy | Why |
|---|---|---|
| Memory usage ≥ 85% | **TinyLFU** | Scan-resistant *and* frequency-aware — safest under pressure |
| Sequential scan detected | **LRU** | Keeps the scan's own working set coherent by recency |
| Read-heavy + skewed popularity | **LFU** | Protects a small set of genuinely hot keys |
| Write-heavy | **LRU** | Recency is the best proxy for "read again soon" under churn |
| No signal dominates | **TinyLFU** | Balanced, scan-resistant default |

Every switch is logged with its reasoning and exposed via
`GET /metrics/eviction` on each node.

## Architecture

**Packages** (`packages/*`) — pure, dependency-injected logic, no I/O
side effects beyond what's explicitly their job:

| Package | Responsibility |
|---|---|
| `shared` | Cross-cutting types, config loading, logger, error hierarchy |
| `storage-engine` | From-scratch hashmap store: TTL, metadata, versioning, stats |
| `eviction` | `EvictionPolicy` interface + LRU / LFU / TinyLFU + `AdaptiveEvictionEngine` |
| `consistent-hash` | Hash ring with virtual nodes, join/leave, minimal-movement rebalancing |
| `metrics` | Latency histograms, rate counters, per-node and cluster-wide aggregation |
| `snapshot` | Periodic serialize/compress/checksum snapshots + restore |
| `worker-pool` | Fixed-size `worker_threads` pool for CPU-bound work off the request path |
| `replication` | Kafka-backed primary → replica async replication with acks |
| `benchmark` | Workload generators, policy comparison runner, report generator |

**Services & apps**:

| | Responsibility |
|---|---|
| `services/cache-node` | The actual cache: wires every package above into an Express server |
| `apps/gateway` | Consistent-hash routing, health tracking, failover, cluster metrics |
| `apps/dashboard` | React dashboard: cluster topology, hash ring viz, live metrics |

### Why Kafka is only for async communication

`GET` requests are always synchronous, plain HTTP, end to end (client
→ gateway → cache node's local storage) — Kafka is never in the
critical path of a read. `PUT`/`DELETE` apply to local storage
*synchronously* (the client's response reflects a durable local write)
and then publish an asynchronous replication event; the client never
waits on replica acknowledgement.

## Repository layout

\`\`\`
flowcache/
├── package.json                 # npm workspaces root
├── tsconfig.base.json            # shared TS compiler options
├── tsconfig.build.json           # composite project-references graph (build order)
├── vitest.config.ts               # test runner config
├── docker-compose.yml
├── docker/                        # Dockerfiles + nginx config
├── scripts/
│   └── run-benchmark.ts           # runnable benchmark CLI
├── packages/                      # see table above
│   ├── shared/ storage-engine/ eviction/ consistent-hash/
│   ├── metrics/ snapshot/ worker-pool/ replication/ benchmark/
├── services/
│   └── cache-node/
├── apps/
│   ├── gateway/
│   └── dashboard/
└── tests/
    ├── unit/ integration/ stress/ benchmark/
\`\`\`

## Quickstart (Docker Compose)

Requires Docker + Docker Compose. Brings up Kafka (KRaft mode, no
Zookeeper), 3 cache nodes, the gateway, and the dashboard:

\`\`\`bash
docker compose up --build
\`\`\`

Once healthy:

| Service | URL |
|---|---|
| Gateway API | http://localhost:4000 |
| Dashboard | http://localhost:8080 |
| Kafka broker | localhost:9092 |

Try it:

\`\`\`bash
curl -X PUT http://localhost:4000/cache \
  -H 'content-type: application/json' \
  -d '{"key": "hello", "value": "world", "ttlMs": 60000}'

curl http://localhost:4000/cache/hello

curl http://localhost:4000/cluster | jq
curl http://localhost:4000/metrics | jq
\`\`\`

## Local development

Requires Node.js ≥ 20 and a running Kafka broker (or `docker compose
up kafka` to run just the broker locally).

\`\`\`bash
npm install
npm run build            # tsc -b tsconfig.build.json — builds every package in dependency order

# In separate terminals:
NODE_ID=node-1 PORT=4001 SNAPSHOT_DIR=/tmp/node-1 npm run dev:cache-node
NODE_ID=node-2 PORT=4002 SNAPSHOT_DIR=/tmp/node-2 npm run dev:cache-node
NODE_ID=node-3 PORT=4003 SNAPSHOT_DIR=/tmp/node-3 npm run dev:cache-node
npm run dev:gateway
npm run dev:dashboard    # http://localhost:5173, proxies API calls to :4000
\`\`\`

`STATIC_NODES` (same value on every node and the gateway) controls
ring membership — see [Configuration](#configuration). The default
value already matches a 3-node local setup on ports 4001–4003.

## API reference

### Gateway (`apps/gateway`, default port 4000)

| Method | Path | Description |
|---|---|---|
| `GET` | `/cache/:key` | Fetch a value. Routes to the ring-owner node, fails over to replicas. |
| `PUT` | `/cache` | `{ key, value, ttlMs? }`. Creates or updates a key. |
| `DELETE` | `/cache/:key` | Deletes a key. |
| `GET` | `/metrics` | Cluster-wide aggregated metrics (fans out to every node). |
| `GET` | `/cluster` | Ring topology: node list + virtual node assignments. |
| `GET` | `/health` | Gateway's own liveness. |

### Cache node (`services/cache-node`, default port 4001)

| Method | Path | Description |
|---|---|---|
| `GET` | `/cache/:key` | Local read. |
| `PUT` | `/cache` | Local write + async replication. |
| `DELETE` | `/cache/:key` | Local delete + async replication. |
| `GET` | `/metrics` | This node's `MetricsSnapshot`. |
| `GET` | `/metrics/eviction` | Current policy, live workload signals, full switch history. |
| `GET` | `/health` | `{ nodeId, status, uptimeMs, timestamp }` — always 200; `status` communicates health. |
| `GET` | `/internal/replicate/export` | Full point-in-time export of this node's entries (bulk recovery). |
| `POST` | `/internal/fault-injection` | `{ type: KILL\|RESTART\|DELAY_REPLICATION\|DROP_MESSAGES, ... }` |
| `POST` | `/internal/policy` | `{ policy: LRU\|LFU\|TINY_LFU\|ADAPTIVE }` — pin or resume adaptive eviction. |

> Internal routes are cluster-internal by convention, not by network
> enforcement — see [Design tradeoffs](#design-tradeoffs-and-known-limitations).

## Sequence diagrams

### Write path (PUT)

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway
    participant N as Cache Node (primary)
    participant K as Kafka
    participant R as Cache Node (replica)

    C->>G: PUT /cache {key, value}
    G->>G: ring.getNodesForKey(key) -> pick primary
    G->>N: PUT /cache
    N->>N: storage.set(key, value)
    N-->>G: 200 {version, replicated: false}
    G-->>C: 200 {version, replicated: false}
    N->>K: publish ReplicationEvent (async, non-blocking)
    K->>R: consume event
    R->>R: apply write locally (version check)
    R->>K: publish ReplicationAck
    K->>N: consume ack
\`\`\`

The client gets its response as soon as the **local** write succeeds —
replication happens after, off the critical path.

### Read path (GET) with failover

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway
    participant N1 as Primary (DOWN)
    participant N2 as Replica

    C->>G: GET /cache/:key
    G->>G: ring.getNodesForKey(key, 3) -> [N1, N2, N3]
    G->>N1: GET /cache/:key
    N1--xG: connection refused
    G->>N2: GET /cache/:key (failover)
    N2-->>G: 200 {value}
    G-->>C: 200 {value}
\`\`\`

### Node recovery after crash/restart

\`\`\`mermaid
sequenceDiagram
    participant Op as Operator / Fault Injector
    participant N as Cache Node
    participant S as SnapshotManager
    participant K as Kafka

    Op->>N: POST /internal/fault-injection {type: RESTART}
    N->>N: RecoveryEngine.recover()
    N->>N: clearStorage()
    N->>S: restoreLatest()
    S-->>N: {entries, metadata}
    N->>N: apply each restored entry
    N->>K: replication consumer resumes from last committed offset
    K-->>N: replay any events missed while down
    N-->>Op: 200 {applied: true}
\`\`\`

### Adaptive policy switch

\`\`\`mermaid
sequenceDiagram
    participant SE as StorageEngine
    participant AE as AdaptiveEvictionEngine
    participant WM as WorkloadMonitor
    participant DR as DecisionRules

    loop every request
        SE->>AE: recordAccess / recordWrite (via EvictionHook)
        SE->>WM: hit / miss / write events
    end

    loop every evaluationIntervalMs
        AE->>WM: computeSignals(memoryUsageRatio)
        WM-->>AE: WorkloadSignals
        AE->>DR: decidePolicy(signals)
        DR-->>AE: {policy, reason}
        alt policy changed and cooldown elapsed
            AE->>AE: seed new policy from current entries
            AE->>AE: swap active policy
            AE-->>AE: emit 'policySwitch'
        end
    end
\`\`\`

## Configuration

All config is environment-variable driven (`packages/shared/src/config.ts`).

### Cache node

| Variable | Default | Description |
|---|---|---|
| `NODE_ID` | *(required)* | Unique node identifier |
| `HOST` / `PORT` | `0.0.0.0` / `4001` | Listen address |
| `NODE_WEIGHT` | `1` | Relative ring capacity (more virtual nodes) |
| `MAX_MEMORY_BYTES` | `128MB` | Storage engine capacity |
| `DEFAULT_TTL_MS` | *(none)* | Default TTL applied to writes without one |
| `VIRTUAL_NODE_COUNT` | `128` | Base virtual nodes per physical node |
| `SNAPSHOT_INTERVAL_MS` | `60000` | Periodic snapshot interval |
| `SNAPSHOT_DIR` | `/data/snapshots/<nodeId>` | Snapshot storage path |
| `SNAPSHOT_COMPRESS` | `true` | Gzip snapshots |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated broker list |
| `KAFKA_CONSUMER_GROUP` | `flowcache-node-group-<nodeId>` | **Must be unique per node** — see tradeoffs |
| `WORKER_POOL_SIZE` | `4` | Worker threads for cleanup/snapshot offload |
| `STATIC_NODES` | 3-node local default | `id:host:port:weight,...` — same value across all nodes + gateway |

### Gateway

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `HEALTH_CHECK_INTERVAL_MS` | `5000` | Node health poll interval |
| `SUSPECT_AFTER_MISSES` / `DEAD_AFTER_MISSES` | `2` / `5` | Consecutive-miss thresholds (hysteresis) |
| `STATIC_NODES` | 3-node local default | Must match every cache node's value |

## Testing

\`\`\`bash
npm test                 # everything
npm run test:unit        # packages in isolation (no network/filesystem beyond temp dirs)
npm run test:integration # real HTTP servers, fake Kafka bus, no real broker needed
npm run test:stress      # high-volume writes, concurrent worker-pool load
\`\`\`

Tests resolve `@flowcache/*` imports straight to TypeScript source
(`vitest.config.ts`), so `npm test` works immediately after `npm
install` — no build step required first.

`tests/integration` exercises the real HTTP route stacks
(`cache-node-http.test.ts`, `gateway-routing.test.ts`) against real
`StorageEngine`/`AdaptiveEvictionEngine`/`ConsistentHashRing`
instances, with Kafka and cross-service networking stubbed out —
these don't require Docker Compose. `tests/unit/replication-engine.test.ts`
covers the actual replication protocol logic against a fake in-memory
event bus, for the same reason.

## Benchmarking

With a cluster running (Docker Compose or local dev):

\`\`\`bash
npm run benchmark -- --target http://localhost:4000 --duration 15000 --concurrency 16
\`\`\`

This runs all four policies (LRU, LFU, TinyLFU, Adaptive) against all
six workload types (uniform random, Zipfian, read-heavy, write-heavy,
mixed, sequential scan), prints a live summary, and writes both
`reports/benchmark-<timestamp>.md` and `.json`.

Policy pinning between runs calls each cache node's
`/internal/policy` directly (not the gateway) — set `NODE_BASE_URLS`
if your nodes aren't on the default `localhost:4001-4003`:

\`\`\`bash
NODE_BASE_URLS=http://localhost:4001,http://localhost:4002,http://localhost:4003 \
  npm run benchmark
\`\`\`

To compose a custom benchmark programmatically, use the library
directly:

\`\`\`typescript
import { BenchmarkRunner, WorkloadType } from '@flowcache/benchmark';

const runner = new BenchmarkRunner({ poolSize: 8 });
const result = await runner.run({
  name: 'my-run',
  targetBaseUrl: 'http://localhost:4000',
  workload: { type: WorkloadType.ZIPFIAN, keyspaceSize: 50_000, zipfianSkew: 1.2 },
  durationMs: 30_000,
  concurrency: 32,
});
console.log(result.throughputOpsPerSec, result.latency.p99);
await runner.dispose();
\`\`\`

## Fault injection

Every cache node accepts fault-injection commands for stress-testing
recovery behavior:

\`\`\`bash
# Kill a node
curl -X POST http://localhost:4001/internal/fault-injection \
  -H 'content-type: application/json' \
  -d '{"type": "KILL", "targetNodeId": "node-1"}'

# ... gateway routing fails over to node-2/node-3 automatically ...

# Bring it back — triggers RecoveryEngine (restore from snapshot)
curl -X POST http://localhost:4001/internal/fault-injection \
  -H 'content-type: application/json' \
  -d '{"type": "RESTART", "targetNodeId": "node-1"}'

# Simulate a slow/unreliable network for replication
curl -X POST http://localhost:4001/internal/fault-injection \
  -H 'content-type: application/json' \
  -d '{"type": "DELAY_REPLICATION", "durationMs": 3000}'

curl -X POST http://localhost:4001/internal/fault-injection \
  -H 'content-type: application/json' \
  -d '{"type": "DROP_MESSAGES", "dropRate": 0.3}'
\`\`\`

`@flowcache/benchmark`'s `FaultInjectionClient` wraps these calls,
including a `killAndRestart(url, nodeId, downtimeMs)` convenience
helper for scripted recovery scenarios.

## Design tradeoffs and known limitations

Documented honestly rather than glossed over:

- **Replication factor is a hardcoded constant** (`REPLICATION_FACTOR = 2`
  in `CacheNodeServer.ts`), not a config knob yet. Same for the
  gateway's failover candidate count (`FAILOVER_CANDIDATE_COUNT = 3`).
- **Internal routes aren't network-isolated.** `/internal/*` endpoints
  (fault injection, policy override, replica export) are reachable on
  the same port as public routes. A production deployment would put
  these behind a separate internal listener, mTLS, or a network
  policy; that's out of scope here.
- **Each cache node needs its own Kafka consumer group** — the
  replication topic is a broadcast, not a work queue, so sharing a
  group across nodes would silently load-balance (and thus drop)
  replication events. `KAFKA_CONSUMER_GROUP` defaults correctly per
  node; double-check this if you override it.
- **Docker images build somewhat redundantly.** `cache-node.Dockerfile`,
  `gateway.Dockerfile`, and `dashboard.Dockerfile` each independently
  install and compile the workspace rather than sharing a cached build
  stage. A build-speed-optimized setup would use a single multi-target
  Dockerfile or Turborepo/BuildKit cache mounts.
- **Snapshot recovery doesn't replay a WAL.** Kafka itself is treated
  as the write-ahead log for replicated writes — a restarted node
  restores its last snapshot and then catches up via normal Kafka
  consumer offset resumption, rather than this project maintaining a
  separate on-disk operation log. This is simpler but means a brief
  window exists between "snapshot restored" and "fully caught up"
  where very recent keys may be temporarily missing.
- **TinyLFU here is simplified**, not the full W-TinyLFU design
  (window + probationary/protected SLRU segments + Bloom-filter
  doorkeeper). It captures the core idea — evict by frequency among
  the least-recently-used candidates, not just by recency — using a
  Count-Min Sketch plus the existing LRU list, which is meaningfully
  scan-resistant without the added complexity. See the doc comment in
  `packages/eviction/src/TinyLFU.ts` for the full reasoning.
- **This environment couldn't run `npm install` or `tsc --build`**
  (no network access) while this project was generated — every file
  was written and reviewed carefully, and several real bugs were
  caught and fixed along the way (a path-traversal gap in
  `SnapshotStore`, a shared-Kafka-consumer-group correctness bug), but
  a full `npm install && npm run build && npm test` pass in an
  environment with registry access is worth doing before treating this
  as production-ready.