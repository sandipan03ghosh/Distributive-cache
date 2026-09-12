import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerPool } from '@flowcache/worker-pool';

/**
 * WorkerPool spawns real OS worker_threads that load a plain compiled
 * JS file — they do NOT go through Vitest's TypeScript transform. So
 * rather than pointing tests at the (TypeScript) built-in handlers in
 * this package, we write a small, self-contained plain-JS worker
 * script to a temp file for each test and point the pool at that,
 * keeping these tests fast and independent of any build step.
 */
async function writeEchoWorker(dir: string): Promise<string> {
  const filePath = path.join(dir, 'echo-worker.mjs');
  const source = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', async (msg) => {
      if (msg.type === 'echo') {
        parentPort.postMessage({ taskId: msg.taskId, success: true, result: msg.payload, durationMs: 1 });
      } else if (msg.type === 'slow') {
        await new Promise((r) => setTimeout(r, msg.payload.ms));
        parentPort.postMessage({ taskId: msg.taskId, success: true, result: 'done', durationMs: msg.payload.ms });
      } else if (msg.type === 'throw') {
        parentPort.postMessage({ taskId: msg.taskId, success: false, error: { message: 'boom' }, durationMs: 1 });
      } else if (msg.type === 'crash') {
        process.exit(1);
      }
    });
  `;
  await writeFile(filePath, source, 'utf8');
  return filePath;
}

describe('WorkerPool', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('executes a task and resolves with its result', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 2, workerScriptPath: scriptPath });

    const result = await pool.submitTask('echo', { hello: 'world' });
    expect(result).toEqual({ hello: 'world' });

    await pool.dispose();
  });

  it('queues tasks beyond pool capacity and drains them in order', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 1, workerScriptPath: scriptPath });

    const results = await Promise.all([
      pool.submitTask('echo', 1),
      pool.submitTask('echo', 2),
      pool.submitTask('echo', 3),
    ]);

    expect(results).toEqual([1, 2, 3]);
    await pool.dispose();
  });

  it('rejects the caller when the task handler reports failure', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 1, workerScriptPath: scriptPath });

    await expect(pool.submitTask('throw', {})).rejects.toThrow(/boom/);
    await pool.dispose();
  });

  it('times out a task that never responds and replaces the stuck worker', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 1, workerScriptPath: scriptPath, taskTimeoutMs: 100 });

    await expect(pool.submitTask('slow', { ms: 5000 }, 100)).rejects.toThrow(/timed out/);

    // Pool should have self-healed and still be usable afterward. Give
    // this call its own generous timeout rather than inheriting the
    // pool's tight 100ms default — a freshly-spawned replacement
    // worker's module load + startup can plausibly take longer than
    // that on its own, which isn't what this assertion is testing for.
    const result = await pool.submitTask('echo', 'still alive', 5000);
    expect(result).toBe('still alive');

    await pool.dispose();
  }, 10_000);

  it('recovers automatically when a worker crashes mid-task', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 1, workerScriptPath: scriptPath });

    await expect(pool.submitTask('crash', {})).rejects.toBeTruthy();

    // A fresh worker should have been spawned to replace the crashed one.
    const result = await pool.submitTask('echo', 'recovered');
    expect(result).toBe('recovered');

    await pool.dispose();
  }, 10_000);

  it('exposes pool stats', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 3, workerScriptPath: scriptPath });

    expect(pool.stats.poolSize).toBe(3);
    expect(pool.stats.busyWorkers).toBe(0);

    await pool.dispose();
  });

  it('rejects new submissions after dispose()', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-'));
    const scriptPath = await writeEchoWorker(tempDir);
    const pool = new WorkerPool({ size: 1, workerScriptPath: scriptPath });
    await pool.dispose();

    await expect(pool.submitTask('echo', 1)).rejects.toThrow(/disposed/);
  });
});