/**
 * @flowcache/worker-pool — workers/handlers/benchmarkExecuteOpsHandler.ts
 *
 * Task: BENCHMARK_EXECUTE_OPS ('benchmark:execute-ops')
 *
 * Executes a pre-generated list of GET/PUT/DELETE operations against a
 * running FlowCache gateway (or cache node directly), timing each call
 * with a monotonic clock. `packages/benchmark` generates the workload
 * (key distribution, read/write mix) cheaply on the main thread and
 * fans batches of operations out across pool workers, so many virtual
 * clients genuinely run in parallel (separate threads) rather than
 * being serialized behind one event loop — which matters for getting
 * believable throughput numbers out of the benchmark engine.
 */

import { TaskTypes } from '../../TaskTypes.js';
import { registerHandler } from './registry.js';
import type { BenchmarkExecuteOpsPayload, BenchmarkExecuteOpsResult, BenchmarkOperation } from '../../types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

registerHandler<BenchmarkExecuteOpsPayload, BenchmarkExecuteOpsResult>(
  TaskTypes.BENCHMARK_EXECUTE_OPS,
  async ({ targetBaseUrl, operations, requestTimeoutMs }) => {
    const latenciesMs: number[] = [];
    const opCounts = { GET: 0, PUT: 0, DELETE: 0 };
    let errors = 0;

    for (const operation of operations) {
      const startedAt = process.hrtime.bigint();
      try {
        await executeOperation(targetBaseUrl, operation, requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        opCounts[operation.op] += 1;
      } catch {
        errors += 1;
      } finally {
        latenciesMs.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      }
    }

    return { latenciesMs, errors, opCounts };
  },
);

async function executeOperation(baseUrl: string, operation: BenchmarkOperation, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const encodedKey = encodeURIComponent(operation.key);

    if (operation.op === 'GET') {
      const response = await fetch(`${baseUrl}/cache/${encodedKey}`, { signal: controller.signal });
      if (!response.ok && response.status !== 404) {
        throw new Error(`GET /cache/${operation.key} failed with status ${response.status}`);
      }
      return;
    }

    if (operation.op === 'PUT') {
      const response = await fetch(`${baseUrl}/cache`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: operation.key, value: operation.value, ttlMs: operation.ttlMs }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`PUT /cache (key=${operation.key}) failed with status ${response.status}`);
      }
      return;
    }

    // DELETE
    const response = await fetch(`${baseUrl}/cache/${encodedKey}`, {
      method: 'DELETE',
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE /cache/${operation.key} failed with status ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}