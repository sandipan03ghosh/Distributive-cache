/**
 * @flowcache/replication — types.ts
 */

import type { ReplicationAck, ReplicationEvent } from '@flowcache/shared';

/**
 * The `cache.replication` topic (see `KafkaTopic.CACHE_REPLICATION` in
 * @flowcache/shared) carries two kinds of message, discriminated by
 * `kind`: the replication event itself (published by the primary that
 * handled the write), and acknowledgements (published by each replica
 * once it has applied that event). Using one topic for both — rather
 * than inventing an extra ack-specific topic beyond FlowCache's
 * defined topic set — keeps ordering guarantees simple: an ack for a
 * given key is guaranteed to be observed after that key's event by any
 * consumer, since Kafka preserves per-partition order and both message
 * kinds for the same key are published with that key as the partition
 * key.
 */
export type ReplicationTopicMessage =
  | { kind: 'event'; event: ReplicationEvent; targetNodeIds: string[] }
  | { kind: 'ack'; ack: ReplicationAck };