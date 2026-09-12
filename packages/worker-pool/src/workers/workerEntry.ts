/**
 * @flowcache/worker-pool — workers/workerEntry.ts
 *
 * This file's compiled output (`dist/workers/workerEntry.js`) is the
 * actual script `worker_threads.Worker` loads. It runs on its own
 * thread, separate from the main thread and every other worker. On
 * startup it registers the four built-in handlers, then listens for
 * `TaskRequest` messages from the main thread, executes the matching
 * handler, and posts back a `TaskResult` — success or failure, always
 * including timing.
 *
 * Never blocks request processing: this file's entire purpose is to
 * exist on a thread that ISN'T the one handling HTTP requests.
 */

import { parentPort } from 'node:worker_threads';
import './handlers/index.js';
import { getHandler } from './handlers/registry.js';
import type { TaskRequest, TaskResult } from '../types.js';

if (!parentPort) {
  throw new Error('workers/workerEntry.ts must be executed inside a worker_threads Worker (parentPort is null)');
}

const port = parentPort;

port.on('message', async (request: TaskRequest) => {
  const startedAtNs = process.hrtime.bigint();

  const handler = getHandler(request.type);
  if (!handler) {
    const result: TaskResult = {
      taskId: request.taskId,
      success: false,
      error: { message: `No task handler registered for type "${request.type}"` },
      durationMs: elapsedMs(startedAtNs),
    };
    port.postMessage(result);
    return;
  }

  try {
    const value = await handler(request.payload);
    const result: TaskResult = {
      taskId: request.taskId,
      success: true,
      result: value,
      durationMs: elapsedMs(startedAtNs),
    };
    port.postMessage(result);
  } catch (err) {
    const result: TaskResult = {
      taskId: request.taskId,
      success: false,
      error: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      durationMs: elapsedMs(startedAtNs),
    };
    port.postMessage(result);
  }
});

function elapsedMs(startedAtNs: bigint): number {
  return Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
}