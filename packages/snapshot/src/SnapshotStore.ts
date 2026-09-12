/**
 * @flowcache/snapshot — SnapshotStore.ts
 *
 * Isolates all filesystem I/O behind an `ISnapshotStore` interface so
 * `SnapshotManager` (orchestration: when to snapshot, how to serialize,
 * checksum verification, retention policy) never touches `fs` directly
 * and can be unit tested against an in-memory fake store. Layout on
 * disk, per node, under its configured snapshot directory:
 *
 *   <directory>/
 *     latest.json                 <- pointer: metadata of the newest snapshot
 *     <snapshotId>.snap           <- raw (optionally gzip'd) entry payload
 *     <snapshotId>.meta.json      <- that snapshot's SnapshotMetadata
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotMetadata } from '@flowcache/shared';

export interface StoredSnapshot {
  metadata: SnapshotMetadata;
  buffer: Buffer;
}

export interface ISnapshotStore {
  ensureReady(): Promise<void>;
  write(snapshotId: string, buffer: Buffer, metadata: SnapshotMetadata): Promise<void>;
  read(snapshotId: string): Promise<StoredSnapshot>;
  writeLatestPointer(metadata: SnapshotMetadata): Promise<void>;
  readLatestPointer(): Promise<SnapshotMetadata | null>;
  list(): Promise<SnapshotMetadata[]>;
  delete(snapshotId: string): Promise<void>;
}

const DATA_SUFFIX = '.snap';
const METADATA_SUFFIX = '.meta.json';
const LATEST_POINTER_FILE = 'latest.json';

/** `generateId('snap')` (see @flowcache/shared/utils.ts) only ever
 *  produces `prefix_base36_base36_base36` — alphanumeric plus
 *  underscores. Anything else (path separators, `..`, absolute paths)
 *  is rejected outright before it ever reaches the filesystem, so a
 *  crafted snapshotId can't escape `directory` via write/read/delete. */
const VALID_SNAPSHOT_ID = /^[A-Za-z0-9_-]+$/;

function assertValidSnapshotId(snapshotId: string): void {
  if (!VALID_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error(`Invalid snapshot id: "${snapshotId}"`);
  }
}

export class FileSnapshotStore implements ISnapshotStore {
  constructor(private readonly directory: string) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async write(snapshotId: string, buffer: Buffer, metadata: SnapshotMetadata): Promise<void> {
    assertValidSnapshotId(snapshotId);
    await this.ensureReady();
    await writeFile(this.dataPath(snapshotId), buffer);
    await writeFile(this.metaPath(snapshotId), JSON.stringify(metadata, null, 2), 'utf8');
  }

  async read(snapshotId: string): Promise<StoredSnapshot> {
    assertValidSnapshotId(snapshotId);
    const [buffer, metaRaw] = await Promise.all([
      readFile(this.dataPath(snapshotId)),
      readFile(this.metaPath(snapshotId), 'utf8'),
    ]);
    return { buffer, metadata: JSON.parse(metaRaw) as SnapshotMetadata };
  }

  async writeLatestPointer(metadata: SnapshotMetadata): Promise<void> {
    await this.ensureReady();
    await writeFile(this.latestPath(), JSON.stringify(metadata, null, 2), 'utf8');
  }

  async readLatestPointer(): Promise<SnapshotMetadata | null> {
    try {
      const raw = await readFile(this.latestPath(), 'utf8');
      return JSON.parse(raw) as SnapshotMetadata;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async list(): Promise<SnapshotMetadata[]> {
    await this.ensureReady();
    const files = await readdir(this.directory);
    const metadataFiles = files.filter((f) => f.endsWith(METADATA_SUFFIX));

    const results: SnapshotMetadata[] = [];
    for (const file of metadataFiles) {
      const raw = await readFile(path.join(this.directory, file), 'utf8');
      results.push(JSON.parse(raw) as SnapshotMetadata);
    }
    // Newest first — callers (retention pruning, "latest N") rely on this order.
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(snapshotId: string): Promise<void> {
    assertValidSnapshotId(snapshotId);
    await Promise.allSettled([unlink(this.dataPath(snapshotId)), unlink(this.metaPath(snapshotId))]);
  }

  private dataPath(snapshotId: string): string {
    return path.join(this.directory, `${snapshotId}${DATA_SUFFIX}`);
  }

  private metaPath(snapshotId: string): string {
    return path.join(this.directory, `${snapshotId}${METADATA_SUFFIX}`);
  }

  private latestPath(): string {
    return path.join(this.directory, LATEST_POINTER_FILE);
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/**
 * In-memory implementation of `ISnapshotStore`, used by unit tests and
 * by any environment where writing to disk isn't desired (e.g. quick
 * local experimentation) without touching `SnapshotManager` itself.
 */
export class InMemorySnapshotStore implements ISnapshotStore {
  private readonly data = new Map<string, StoredSnapshot>();
  private latest: SnapshotMetadata | null = null;

  async ensureReady(): Promise<void> {
    /* no-op */
  }

  async write(snapshotId: string, buffer: Buffer, metadata: SnapshotMetadata): Promise<void> {
    this.data.set(snapshotId, { buffer, metadata });
  }

  async read(snapshotId: string): Promise<StoredSnapshot> {
    const entry = this.data.get(snapshotId);
    if (!entry) throw new Error(`No such snapshot: ${snapshotId}`);
    return entry;
  }

  async writeLatestPointer(metadata: SnapshotMetadata): Promise<void> {
    this.latest = metadata;
  }

  async readLatestPointer(): Promise<SnapshotMetadata | null> {
    return this.latest;
  }

  async list(): Promise<SnapshotMetadata[]> {
    return [...this.data.values()].map((s) => s.metadata).sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(snapshotId: string): Promise<void> {
    this.data.delete(snapshotId);
  }
}