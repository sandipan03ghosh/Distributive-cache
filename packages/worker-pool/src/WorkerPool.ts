/**
 * @flowcache/worker-pool — WorkerPool.ts
 *
 * A fixed-size pool of `worker_threads.Worker` instances used for any
 * CPU-bound or otherwise blocking work that shouldn't run on the main
 * thread while it's handling HTTP requests: snapshot serialization,
 * replication batch encoding, background expired-key cleanup scans,
 * and benchmark load execution (see `workers/handlers/`).
 *
 * Responsibilities:
 *   - Spawn `size` workers up front, running `workerScriptPath`.
 *   - `submitTask()` returns a Promise; dispatches immediately to an
 *     idle worker, or queues (FIFO) if all workers are busy.
 *   - Per-task timeout: a wedged task is rejected and its worker is
 *     terminated and replaced, so one stuck task can't permanently
 *     shrink pool capacity.
 *   - Fault tolerance: an unexpected worker crash/exit rejects its
 *     in-flight task (if any) and transparently spawns a replacement
 *     worker, then continues draining the queue — the pool's capacity
 *     self-heals without any external intervention.
 */

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { generateId } from '@flowcache/shared';
import type { TaskRequest, TaskResult, WorkerPoolOptions } from './types.js';

interface PendingTask {
  taskId: string;
  type: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout | null;
}

interface ManagedWorker {
  id: number;
  worker: Worker;
  busy: boolean;
  currentTaskId: string | null;
}

export interface WorkerPoolStats {
  poolSize: number;
  busyWorkers: number;
  queuedTasks: number;
  inFlightTasks: number;
}

const DEFAULT_TASK_TIMEOUT_MS = 30_000;

export class WorkerPool extends EventEmitter {
  private readonly size: number;
  private readonly workerScriptPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly workerData?: Record<string, unknown>;

  private workers: ManagedWorker[] = [];
  private queue: PendingTask[] = [];
  private readonly pendingByTaskId = new Map<string, PendingTask>();
  private nextWorkerId = 0;
  private disposed = false;

  constructor(options: WorkerPoolOptions) {
    super();
    this.size = Math.max(1, options.size);
    this.workerScriptPath = options.workerScriptPath ?? defaultWorkerScriptPath();
    this.defaultTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.workerData = options.workerData;

    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  submitTask<P = unknown, R = unknown>(type: string, payload: P, timeoutMs?: number): Promise<R> {
    if (this.disposed) {
      return Promise.reject(new Error('Cannot submit a task: WorkerPool has already been disposed'));
    }

    return new Promise<R>((resolve, reject) => {
      const taskId = generateId('task');
      const pending: PendingTask = {
        taskId,
        type,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutHandle: null,
      };

      const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
      if (effectiveTimeoutMs > 0) {
        pending.timeoutHandle = setTimeout(() => this.handleTimeout(pending), effectiveTimeoutMs);
        pending.timeoutHandle.unref?.();
      }

      this.pendingByTaskId.set(taskId, pending);

      const idleWorker = this.workers.find((w) => !w.busy);
      if (idleWorker) {
        this.dispatch(idleWorker, pending);
      } else {
        this.queue.push(pending);
      }
    });
  }

  get stats(): WorkerPoolStats {
    return {
      poolSize: this.workers.length,
      busyWorkers: this.workers.filter((w) => w.busy).length,
      queuedTasks: this.queue.length,
      inFlightTasks: this.pendingByTaskId.size,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const pending of [...this.queue, ...this.pendingByTaskId.values()]) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('WorkerPool was disposed before this task completed'));
    }
    this.queue = [];
    this.pendingByTaskId.clear();

    await Promise.all(this.workers.map((w) => terminateQuietly(w.worker)));
    this.workers = [];
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------

  private spawnWorker(): ManagedWorker {
    const id = this.nextWorkerId++;
    const worker = new Worker(this.workerScriptPath, { workerData: this.workerData });
    const managed: ManagedWorker = { id, worker, busy: false, currentTaskId: null };

    worker.on('message', (message: TaskResult) => this.handleWorkerMessage(managed, message));
    worker.on('error', (err: Error) => this.handleWorkerError(managed, err));
    worker.on('exit', (code: number) => this.handleWorkerExit(managed, code));

    this.workers.push(managed);
    this.emit('workerSpawned', id);
    return managed;
  }

  private dispatch(managedWorker: ManagedWorker, pending: PendingTask): void {
    managedWorker.busy = true;
    managedWorker.currentTaskId = pending.taskId;
    const request: TaskRequest = { taskId: pending.taskId, type: pending.type, payload: pending.payload };
    managedWorker.worker.postMessage(request);
  }

  private handleWorkerMessage(managedWorker: ManagedWorker, message: TaskResult): void {
    const pending = this.pendingByTaskId.get(message.taskId);
    managedWorker.busy = false;
    managedWorker.currentTaskId = null;

    if (pending) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      this.pendingByTaskId.delete(message.taskId);

      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(`Worker task "${pending.type}" failed: ${message.error.message}`));
      }
      this.emit('taskCompleted', message);
    }

    this.drainQueueTo(managedWorker);
  }

  private handleTimeout(pending: PendingTask): void {
    if (!this.pendingByTaskId.has(pending.taskId)) return; // already resolved/rejected
    this.pendingByTaskId.delete(pending.taskId);
    pending.reject(new Error(`Task "${pending.type}" (${pending.taskId}) timed out`));

    // The worker running this task may be permanently wedged (e.g.
    // stuck in a synchronous infinite loop) — terminate and replace it
    // rather than leaving it occupying a pool slot forever.
    const stuckWorker = this.workers.find((w) => w.currentTaskId === pending.taskId);
    if (stuckWorker) {
      this.replaceWorker(stuckWorker);
    }
  }

  private handleWorkerError(managedWorker: ManagedWorker, err: Error): void {
    this.emit('workerError', managedWorker.id, err);

    const failedTaskId = managedWorker.currentTaskId;
    if (failedTaskId) {
      const pending = this.pendingByTaskId.get(failedTaskId);
      if (pending) {
        if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
        this.pendingByTaskId.delete(failedTaskId);
        pending.reject(err);
      }
    }

    this.replaceWorker(managedWorker);
  }

  private handleWorkerExit(managedWorker: ManagedWorker, code: number): void {
    this.emit('workerExit', managedWorker.id, code);
    if (this.disposed) return;

    // A non-zero exit while the pool is still active means the worker
    // crashed rather than being intentionally terminated by us (we
    // always go through `replaceWorker`/`dispose`, which already
    // remove it from `this.workers` first). Self-heal by respawning.
    const stillTracked = this.workers.some((w) => w.id === managedWorker.id);
    if (stillTracked && code !== 0) {
      // Reject whatever task was in flight on this worker — without
      // this, a crash mid-task left the caller hanging until the
      // task's own timeout (default 30s) eventually fired, instead of
      // failing fast the way `handleWorkerError` already does for the
      // 'error' event.
      const crashedTaskId = managedWorker.currentTaskId;
      if (crashedTaskId) {
        const pending = this.pendingByTaskId.get(crashedTaskId);
        if (pending) {
          if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
          this.pendingByTaskId.delete(crashedTaskId);
          pending.reject(new Error(`Worker exited unexpectedly (code ${code}) while running task "${pending.type}"`));
        }
      }

      this.replaceWorker(managedWorker);
    }
  }

  private replaceWorker(managedWorker: ManagedWorker): void {
    this.workers = this.workers.filter((w) => w.id !== managedWorker.id);
    managedWorker.worker.removeAllListeners();
    void terminateQuietly(managedWorker.worker);

    if (!this.disposed) {
      const fresh = this.spawnWorker();
      this.drainQueueTo(fresh);
    }
  }

  private drainQueueTo(managedWorker: ManagedWorker): void {
    if (managedWorker.busy || this.disposed) return;
    const next = this.queue.shift();
    if (next) {
      this.dispatch(managedWorker, next);
    }
  }
}

function terminateQuietly(worker: Worker): Promise<number> {
  return worker.terminate().catch(() => 0);
}

function defaultWorkerScriptPath(): string {
  return fileURLToPath(new URL('./workers/workerEntry.js', import.meta.url));
}