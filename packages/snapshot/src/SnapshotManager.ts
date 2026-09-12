/**
 * @flowcache/snapshot — SnapshotManager.ts
 *
 * Periodically (and on-demand) captures the full contents of a cache
 * node's storage engine to durable storage, and can restore the most
 * recent (or a specific) snapshot back into memory after a restart.
 *
 *   takeSnapshot():
 *     1. Pull all current entries via the injected `getEntries` getter.
 *     2. Serialize to JSON.
 *     3. Optionally gzip-compress (node:zlib — no external compression
 *        library).
 *     4. Compute a SHA-256 checksum (node:crypto) over the final bytes,
 *        so `restoreById`/`restoreLatest` can detect corruption before
 *        handing back bad data.
 *     5. Persist via the injected `ISnapshotStore`, update the "latest"
 *        pointer, and prune old snapshots beyond the retention count.
 *
 * All the actual byte-shuffling in this class runs on the Node.js main
 * thread, but the *call* to trigger a snapshot is designed to be
 * dispatchable from a worker thread via `packages/worker-pool` (see
 * that package's `snapshotWorker.ts`) so serialization/compression of
 * a large cache doesn't block request handling.
 */

import { EventEmitter } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  SnapshotError,
  generateId,
  nowMs,
  type CacheEntry,
  type SnapshotMetadata,
  type SnapshotPayload,
} from '@flowcache/shared';
import { FileSnapshotStore, type ISnapshotStore } from './SnapshotStore.js';

export interface SnapshotManagerOptions {
  nodeId: string;
  /** Filesystem directory to persist snapshots under. Ignored if a
   *  custom `store` is provided. */
  directory: string;
  /** How often to automatically snapshot, in ms. 0 disables the
   *  background timer (manual `takeSnapshot()` calls still work). */
  intervalMs: number;
  compress: boolean;
  /** How many past snapshots to keep on disk; older ones are pruned
   *  after each successful new snapshot. */
  maxRetainedSnapshots?: number;
  /** Getter for the current set of cache entries to serialize. */
  getEntries: () => readonly CacheEntry[];
  /** Override the storage backend (e.g. `InMemorySnapshotStore` for
   *  tests). Defaults to a `FileSnapshotStore` at `directory`. */
  store?: ISnapshotStore;
  /** Optional override for entry serialization + compression +
   *  checksumming — e.g. to offload the work to a worker thread via
   *  `@flowcache/worker-pool`'s SNAPSHOT_SERIALIZE task, so a large
   *  cache's JSON.stringify/gzip cost doesn't block request handling
   *  on the main thread. Defaults to doing the work inline below. */
  serialize?: (
    entries: readonly CacheEntry[],
    compress: boolean,
  ) => Promise<{ buffer: Buffer; checksum: string }>;
}

export class SnapshotManager extends EventEmitter {
  private readonly nodeId: string;
  private readonly intervalMs: number;
  private readonly compress: boolean;
  private readonly maxRetained: number;
  private readonly getEntries: () => readonly CacheEntry[];
  private readonly store: ISnapshotStore;
  private readonly serializeFn?: SnapshotManagerOptions['serialize'];

  private timer: NodeJS.Timeout | null = null;
  private snapshotInProgress = false;

  constructor(options: SnapshotManagerOptions) {
    super();
    this.nodeId = options.nodeId;
    this.intervalMs = options.intervalMs;
    this.compress = options.compress;
    this.maxRetained = options.maxRetainedSnapshots ?? 5;
    this.getEntries = options.getEntries;
    this.store = options.store ?? new FileSnapshotStore(options.directory);
    this.serializeFn = options.serialize;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.takeSnapshot().catch((err: unknown) => this.emit('error', err));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------

  async takeSnapshot(): Promise<SnapshotMetadata> {
    if (this.snapshotInProgress) {
      throw new SnapshotError(`Snapshot already in progress for node "${this.nodeId}"`);
    }
    this.snapshotInProgress = true;
    const startedAt = nowMs();

    try {
      const entries = [...this.getEntries()];
      let payload: Buffer;
      let checksum: string;
      if (this.serializeFn) {
        const result = await this.serializeFn(entries, this.compress);
        payload = result.buffer;
        checksum = result.checksum;
      } else {
        const serialized = Buffer.from(JSON.stringify(entries), 'utf8');
        payload = this.compress ? gzipSync(serialized) : serialized;
        checksum = sha256(payload);
      }
      const snapshotId = generateId('snap');
      const durationMs = nowMs() - startedAt;

      const metadata: SnapshotMetadata = {
        snapshotId,
        nodeId: this.nodeId,
        createdAt: startedAt,
        entryCount: entries.length,
        sizeBytes: payload.byteLength,
        durationMs,
        checksum,
        compressed: this.compress,
      };

      await this.store.write(snapshotId, payload, metadata);
      await this.store.writeLatestPointer(metadata);
      await this.pruneOldSnapshots();

      this.emit('snapshot', metadata);
      return metadata;
    } finally {
      this.snapshotInProgress = false;
    }
  }

  // -------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------

  async restoreLatest(): Promise<SnapshotPayload | null> {
    const pointer = await this.store.readLatestPointer();
    if (!pointer) return null;
    return this.restoreById(pointer.snapshotId);
  }

  async restoreById(snapshotId: string): Promise<SnapshotPayload | null> {
    let stored;
    try {
      stored = await this.store.read(snapshotId);
    } catch {
      return null;
    }

    const { buffer, metadata } = stored;
    const actualChecksum = sha256(buffer);
    if (actualChecksum !== metadata.checksum) {
      throw new SnapshotError(
        `Checksum mismatch restoring snapshot "${snapshotId}" for node "${this.nodeId}": ` +
          `expected ${metadata.checksum}, got ${actualChecksum}. The snapshot file may be corrupted.`,
      );
    }

    const raw = metadata.compressed ? gunzipSync(buffer) : buffer;
    const entries = JSON.parse(raw.toString('utf8')) as CacheEntry[];

    return { metadata, entries };
  }

  async listSnapshots(): Promise<SnapshotMetadata[]> {
    return this.store.list();
  }

  // -------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------

  private async pruneOldSnapshots(): Promise<void> {
    const all = await this.store.list(); // newest first
    if (all.length <= this.maxRetained) return;

    const toDelete = all.slice(this.maxRetained);
    for (const meta of toDelete) {
      await this.store.delete(meta.snapshotId);
    }
    if (toDelete.length > 0) {
      this.emit('pruned', toDelete.map((m) => m.snapshotId));
    }
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}