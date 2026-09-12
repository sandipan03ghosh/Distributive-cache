import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SnapshotManager, InMemorySnapshotStore, FileSnapshotStore } from '@flowcache/snapshot';
import type { CacheEntry } from '@flowcache/shared';

function entry(key: string, value: unknown): CacheEntry {
  return {
    key,
    value,
    metadata: {
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      lastAccessedAt: 0,
      frequency: 1,
      expiresAt: null,
      sizeBytes: 10,
    },
  };
}

describe('SnapshotManager', () => {
  it('takeSnapshot() then restoreLatest() roundtrips the entries exactly', async () => {
    const entries: CacheEntry[] = [entry('a', 1), entry('b', { nested: true })];
    const manager = new SnapshotManager({
      nodeId: 'node-1',
      directory: '/unused',
      intervalMs: 0,
      compress: true,
      getEntries: () => entries,
      store: new InMemorySnapshotStore(),
    });

    await manager.takeSnapshot();
    const restored = await manager.restoreLatest();

    expect(restored).not.toBeNull();
    expect(restored!.entries).toEqual(entries);
    expect(restored!.metadata.entryCount).toBe(2);
    expect(restored!.metadata.compressed).toBe(true);
  });

  it('restoreLatest() returns null when no snapshot has ever been taken', async () => {
    const manager = new SnapshotManager({
      nodeId: 'node-1',
      directory: '/unused',
      intervalMs: 0,
      compress: false,
      getEntries: () => [],
      store: new InMemorySnapshotStore(),
    });

    expect(await manager.restoreLatest()).toBeNull();
  });

  it('detects checksum corruption on restore', async () => {
    const store = new InMemorySnapshotStore();
    const manager = new SnapshotManager({
      nodeId: 'node-1',
      directory: '/unused',
      intervalMs: 0,
      compress: false,
      getEntries: () => [entry('a', 1)],
      store,
    });

    const metadata = await manager.takeSnapshot();

    const stored = await store.read(metadata.snapshotId);
    stored.buffer[0] = stored.buffer[0] ^ 0xff;
    await store.write(metadata.snapshotId, stored.buffer, metadata);

    await expect(manager.restoreById(metadata.snapshotId)).rejects.toThrow(/checksum/i);
  });

  it('prunes old snapshots beyond the retention count', async () => {
    let counter = 0;
    const manager = new SnapshotManager({
      nodeId: 'node-1',
      directory: '/unused',
      intervalMs: 0,
      compress: false,
      maxRetainedSnapshots: 2,
      getEntries: () => [entry(`k${counter}`, counter++)],
      store: new InMemorySnapshotStore(),
    });

    await manager.takeSnapshot();
    await manager.takeSnapshot();
    await manager.takeSnapshot();

    const all = await manager.listSnapshots();
    expect(all).toHaveLength(2);
  });

  it('uses an injected serialize function when provided instead of the default inline path', async () => {
    let called = false;
    const manager = new SnapshotManager({
      nodeId: 'node-1',
      directory: '/unused',
      intervalMs: 0,
      compress: false,
      getEntries: () => [entry('a', 1)],
      store: new InMemorySnapshotStore(),
      serialize: async (entries) => {
        called = true;
        return { buffer: Buffer.from(JSON.stringify(entries)), checksum: 'fake-checksum' };
      },
    });

    const metadata = await manager.takeSnapshot();
    expect(called).toBe(true);
    expect(metadata.checksum).toBe('fake-checksum');
  });
});

describe('FileSnapshotStore path traversal guard', () => {
  it('rejects a snapshotId containing path traversal characters', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowcache-snap-'));
    try {
      const store = new FileSnapshotStore(dir);
      const maliciousId = '../../../etc/passwd';

      await expect(store.write(maliciousId, Buffer.from('x'), {
        snapshotId: maliciousId,
        nodeId: 'node-1',
        createdAt: 0,
        entryCount: 0,
        sizeBytes: 1,
        durationMs: 0,
        checksum: 'x',
        compressed: false,
      })).rejects.toThrow(/invalid snapshot id/i);

      await expect(store.read(maliciousId)).rejects.toThrow(/invalid snapshot id/i);
      await expect(store.delete(maliciousId)).rejects.toThrow(/invalid snapshot id/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts a normal generated snapshot id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowcache-snap-'));
    try {
      const store = new FileSnapshotStore(dir);
      const id = 'snap_abc123_def456';
      await store.write(id, Buffer.from('hello'), {
        snapshotId: id,
        nodeId: 'node-1',
        createdAt: 0,
        entryCount: 0,
        sizeBytes: 5,
        durationMs: 0,
        checksum: 'x',
        compressed: false,
      });

      const result = await store.read(id);
      expect(result.buffer.toString()).toBe('hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});