/**
 * @flowcache/worker-pool — workers/handlers/replicationEncodeHandler.ts
 *
 * Task: REPLICATION_ENCODE ('replication:encode')
 *
 * Encodes (and optionally compresses) a batch of `ReplicationEvent`s
 * before they're published to Kafka. Under heavy write load, batches
 * can get large; offloading the JSON + gzip work to a worker keeps the
 * main event loop free to keep accepting new requests.
 */

import { gzipSync } from 'node:zlib';
import { TaskTypes } from '../../TaskTypes.js';
import { registerHandler } from './registry.js';
import type { ReplicationEncodePayload, ReplicationEncodeResult } from '../../types.js';

registerHandler<ReplicationEncodePayload, ReplicationEncodeResult>(
  TaskTypes.REPLICATION_ENCODE,
  async ({ events, compress }) => {
    const serialized = Buffer.from(JSON.stringify(events), 'utf8');
    const buffer = compress ? gzipSync(serialized) : serialized;
    return { buffer, sizeBytes: buffer.byteLength, eventCount: events.length };
  },
);