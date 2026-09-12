import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerPool } from '@flowcache/worker-pool';

async function writeMathWorker(dir: string): Promise<string> {
  const filePath = path.join(dir, 'math-worker.mjs');
  const source = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', (msg) => {
      if (msg.type === 'square') {
        parentPort.postMessage({ taskId: msg.taskId, success: true, result: msg.payload * msg.payload, durationMs: 0 });
      }
    });
  `;
  await writeFile(filePath, source, 'utf8');
  return filePath;
}

describe('WorkerPool stress', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('correctly processes thousands of concurrent tasks across a small pool', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'flowcache-pool-stress-'));
    const scriptPath = await writeMathWorker(tempDir);
    const pool = new WorkerPool({ size: 4, workerScriptPath: scriptPath, taskTimeoutMs: 10_000 });

    const TASK_COUNT = 2000;
    const promises = Array.from({ length: TASK_COUNT }, (_, i) => pool.submitTask<number, number>('square', i));
    const results = await Promise.all(promises);

    for (let i = 0; i < TASK_COUNT; i++) {
      expect(results[i]).toBe(i * i);
    }

    // Pool should have drained back to idle — no leaked in-flight state.
    expect(pool.stats.queuedTasks).toBe(0);
    expect(pool.stats.inFlightTasks).toBe(0);
    expect(pool.stats.busyWorkers).toBe(0);

    await pool.dispose();
  }, 30_000);
});