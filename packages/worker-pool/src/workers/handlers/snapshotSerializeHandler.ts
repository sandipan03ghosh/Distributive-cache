/**
 * @flowcache/worker-pool — workers/handlers/snapshotSerializeHandler.ts
 *
 * Task: SNAPSHOT_SERIALIZE ('snapshot:serialize')
 *
 * Takes a full array of cache entries, JSON-serializes them, optionally
 * gzip-compresses the result, and computes a SHA-256 checksum — all off
 * the main thread. `SnapshotManager` can call this via the pool instead
 * of doing the same work inline when a cache is large enough that the
 * synchronous CPU cost would otherwise stall request handling.
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TaskTypes } from '../../TaskTypes.js';
import { registerHandler } from './registry.js';
import type { SnapshotSerializePayload, SnapshotSerializeResult } from '../../types.js';

registerHandler<SnapshotSerializePayload, SnapshotSerializeResult>(
  TaskTypes.SNAPSHOT_SERIALIZE,
  async ({ entries, compress }) => {
    const serialized = Buffer.from(JSON.stringify(entries), 'utf8');
    const buffer = compress ? gzipSync(serialized) : serialized;
    const checksum = createHash('sha256').update(buffer).digest('hex');
    return { buffer, checksum, sizeBytes: buffer.byteLength };
  },
);