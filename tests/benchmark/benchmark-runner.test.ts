import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerPool } from '@flowcache/worker-pool';
import {
  BenchmarkRunner,
  PolicyComparisonRunner,
  generateMarkdownReport,
  generateJsonReport,
  WorkloadType,
  type PolicyComparisonReport,
} from '@flowcache/benchmark';

/**
 * BenchmarkRunner dispatches work through @flowcache/worker-pool's
 * BENCHMARK_EXECUTE_OPS task, whose built-in (TypeScript) handler
 * lives under packages/worker-pool/src/workers — which isn't
 * loadable directly by a real worker_threads.Worker without a build
 * step first (see the note in tests/unit/worker-pool.test.ts). So
 * here we supply a plain-JS worker implementing just that one task,
 * doing real `fetch` calls against a real in-memory HTTP test server —
 * this still exercises BenchmarkRunner's actual batching, concurrency,
 * and aggregation logic end to end.
 */
async function writeBenchmarkWorker(dir: string): Promise<string> {
  const filePath = path.join(dir, 'benchmark-worker.mjs');
  const source = `
    import { parentPort } from 'node:worker_threads';

    parentPort.on('message', async (msg) => {
      if (msg.type !== 'benchmark:execute-ops') return;
      const { targetBaseUrl, operations } = msg.payload;
      const latenciesMs = [];
      const opCounts = { GET: 0, PUT: 0, DELETE: 0 };
      let errors = 0;

      for (const op of operations) {
        const startedAt = process.hrtime.bigint();
        try {
          if (op.op === 'GET') {
            const res = await fetch(\`\${targetBaseUrl}/cache/\${encodeURIComponent(op.key)}\`);
            if (!res.ok && res.status !== 404) throw new Error('bad status');
          } else if (op.op === 'PUT') {
            const res = await fetch(\`\${targetBaseUrl}/cache\`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key: op.key, value: op.value }),
            });
            if (!res.ok) throw new Error('bad status');
          }
          opCounts[op.op] += 1;
        } catch {
          errors += 1;
        } finally {
          latenciesMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        }
      }

      parentPort.postMessage({
        taskId: msg.taskId,
        success: true,
        result: { latenciesMs, errors, opCounts },
        durationMs: 0,
      });
    });
  `;
  await writeFile(filePath, source, 'utf8');
  return filePath;
}

describe('BenchmarkRunner (end to end against an in-memory HTTP server)', () => {
  let httpServer: Server;
  let targetBaseUrl: string;
  let tempDir: string;
  let pool: WorkerPool;

  beforeAll(async () => {
    const store = new Map<string, unknown>();
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname.startsWith('/cache/')) {
        const key = decodeURIComponent(url.pathname.slice('/cache/'.length));
        if (store.has(key)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ key, value: store.get(key) }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'KEY_NOT_FOUND' } }));
        }
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/cache') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          store.set(parsed.key, parsed.value);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ key: parsed.key, version: 1 }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    targetBaseUrl = `http://127.0.0.1:${port}`;

    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-benchmark-'));
    const scriptPath = await writeBenchmarkWorker(tempDir);
    pool = new WorkerPool({ size: 2, workerScriptPath: scriptPath });
  });

  afterAll(async () => {
    await pool.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs a short workload and produces a well-formed result', async () => {
    const runner = new BenchmarkRunner({ pool });

    const result = await runner.run({
      name: 'smoke-test',
      targetBaseUrl,
      workload: { type: WorkloadType.UNIFORM_RANDOM, keyspaceSize: 50, readRatio: 0.5 },
      durationMs: 300,
      concurrency: 2,
      opsPerBatch: 10,
    });

    expect(result.totalOperations).toBeGreaterThan(0);
    expect(result.opCounts.GET + result.opCounts.PUT).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(result.throughputOpsPerSec).toBeGreaterThan(0);
    expect(result.latency.max).toBeGreaterThanOrEqual(result.latency.p99);
    expect(result.latency.p99).toBeGreaterThanOrEqual(result.latency.p50);
  }, 15_000);

  it('captures before/after metrics via the injected captureMetrics hook', async () => {
    const runner = new BenchmarkRunner({ pool });
    let callCount = 0;

    const result = await runner.run({
      name: 'with-metrics',
      targetBaseUrl,
      workload: { type: WorkloadType.SEQUENTIAL_SCAN, keyspaceSize: 20 },
      durationMs: 100,
      concurrency: 1,
      opsPerBatch: 5,
      captureMetrics: async () => {
        callCount += 1;
        return { overallHitRatio: 0.5 };
      },
    });

    expect(callCount).toBe(2); // once before, once after
    expect(result.metricsBefore).toEqual({ overallHitRatio: 0.5 });
    expect(result.metricsAfter).toEqual({ overallHitRatio: 0.5 });
  }, 15_000);

  it('captureMetrics failures degrade to null rather than failing the run', async () => {
    const runner = new BenchmarkRunner({ pool });

    const result = await runner.run({
      name: 'metrics-fail',
      targetBaseUrl,
      workload: { type: WorkloadType.UNIFORM_RANDOM, keyspaceSize: 10 },
      durationMs: 50,
      concurrency: 1,
      opsPerBatch: 5,
      captureMetrics: async () => {
        throw new Error('metrics endpoint down');
      },
    });

    expect(result.metricsBefore).toBeNull();
    expect(result.metricsAfter).toBeNull();
  }, 15_000);
});

describe('PolicyComparisonRunner + ReportGenerator', () => {
  let httpServer: Server;
  let targetBaseUrl: string;
  let tempDir: string;
  let pool: WorkerPool;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    targetBaseUrl = `http://127.0.0.1:${port}`;

    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-benchmark-cmp-'));
    const scriptPath = await writeBenchmarkWorker(tempDir);
    pool = new WorkerPool({ size: 2, workerScriptPath: scriptPath });
  });

  afterAll(async () => {
    await pool.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs one benchmark per policy and produces a comparison report', async () => {
    const runner = new BenchmarkRunner({ pool });
    const comparisonRunner = new PolicyComparisonRunner(runner);
    const setPolicyCalls: string[] = [];

    const report = await comparisonRunner.compare({
      targetBaseUrl,
      workload: { type: WorkloadType.UNIFORM_RANDOM, keyspaceSize: 20, readRatio: 1 },
      durationMs: 60,
      concurrency: 1,
      opsPerBatch: 5,
      policiesToCompare: ['LRU', 'LFU', 'ADAPTIVE'],
      setPolicy: async (policy) => {
        setPolicyCalls.push(policy);
      },
    });

    expect(setPolicyCalls).toEqual(['LRU', 'LFU', 'ADAPTIVE']);
    expect(report.results).toHaveLength(3);
    expect(report.results.map((r) => r.name)).toEqual(['LRU', 'LFU', 'ADAPTIVE']);
    expect(['LRU', 'LFU', 'ADAPTIVE']).toContain(report.bestThroughput);
    expect(['LRU', 'LFU', 'ADAPTIVE']).toContain(report.bestP99Latency);
  }, 20_000);

  it('generateMarkdownReport produces a table with every policy label', () => {
    const fakeReport: PolicyComparisonReport = {
      generatedAt: Date.now(),
      workloadType: WorkloadType.ZIPFIAN,
      results: [
        {
          name: 'LRU',
          workloadType: WorkloadType.ZIPFIAN,
          startedAt: 0,
          finishedAt: 1000,
          durationMs: 1000,
          totalOperations: 500,
          opCounts: { GET: 400, PUT: 100, DELETE: 0 },
          errors: 0,
          throughputOpsPerSec: 500,
          latency: { p50: 1, p95: 2, p99: 3, max: 5 },
          metricsBefore: null,
          metricsAfter: { overallHitRatio: 0.73 },
        },
      ],
      bestThroughput: 'LRU',
      bestP99Latency: 'LRU',
      bestHitRatio: 'LRU',
    };

    const markdown = generateMarkdownReport([fakeReport]);
    expect(markdown).toContain('# FlowCache Benchmark Report');
    expect(markdown).toContain('LRU');
    expect(markdown).toContain('73.0%');

    const json = generateJsonReport([fakeReport]);
    expect(JSON.parse(json)[0].results[0].name).toBe('LRU');
  });
});