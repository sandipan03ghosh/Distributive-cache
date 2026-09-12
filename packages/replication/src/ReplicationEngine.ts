/**
 * @flowcache/replication — ReplicationEngine.ts
 *
 * Implements FlowCache's primary/replica replication model:
 *
 *   1. A client's PUT/DELETE lands on whichever node the consistent
 *      hash ring says owns the key (the "primary" for that key, from
 *      that request's point of view). After applying it locally, the
 *      primary calls `replicateWrite` / `replicateDelete`, which
 *      determines the other nodes that should also hold this key (per
 *      the ring's replica list) and publishes one `ReplicationEvent`
 *      to the `cache.replication` Kafka topic.
 *   2. Every node consumes that topic. A node that is NOT one of the
 *      event's intended targets ignores it. A node that IS a target
 *      applies the write/delete to its own local storage (via the
 *      injected `applyRemoteWrite` / `applyRemoteDelete` callbacks) and
 *      publishes a `ReplicationAck` back on the same topic.
 *   3. The primary tracks outstanding acks per event; `replicateWrite`
 *      / `replicateDelete` resolve once every target has acked, or the
 *      ack timeout elapses (whichever comes first) — replication is
 *      asynchronous with respect to the client's original request
 *      (never blocks the initial response), but callers that want to
 *      know how far replication got can await the returned promise.
 *
 * This is deliberately NOT synchronous quorum replication — FlowCache
 * favors availability and low write latency over strict consistency,
 * consistent with the "asynchronous replication" requirement.
 */

import { EventEmitter } from 'node:events';
import {
  KafkaTopic,
  ReplicationError,
  generateId,
  nowMs,
  type CacheKey,
  type CacheMetadata,
  type ReplicationAck,
  type ReplicationEvent,
} from '@flowcache/shared';
import type { KafkaEventBus } from './KafkaEventBus.js';
import type { ReplicationTopicMessage } from './types.js';

interface AckWaiter {
  eventId: string;
  targetNodeIds: Set<string>;
  ackedBy: Set<string>;
  resolve: (ackedBy: string[]) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface ReplicationEngineOptions {
  nodeId: string;
  eventBus: KafkaEventBus;
  /** Returns the node ids that should hold a replica of `key`,
   *  according to the consistent hash ring (primary included). Passed
   *  in rather than importing @flowcache/consistent-hash directly, so
   *  this package has no dependency on ring internals. */
  getReplicaNodeIds: (key: CacheKey) => string[];
  /** Applies an incoming replicated write to this node's local
   *  storage. Passed in rather than importing @flowcache/storage-engine
   *  directly, for the same reason. */
  applyRemoteWrite: (key: CacheKey, value: unknown, metadata: CacheMetadata) => void;
  applyRemoteDelete: (key: CacheKey) => void;
  /** How long to wait for all targets to ack before resolving with
   *  whatever partial ack set has arrived so far. */
  ackTimeoutMs?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 5000;

export class ReplicationEngine extends EventEmitter {
  private readonly nodeId: string;
  private readonly eventBus: KafkaEventBus;
  private readonly getReplicaNodeIds: (key: CacheKey) => string[];
  private readonly applyRemoteWrite: (key: CacheKey, value: unknown, metadata: CacheMetadata) => void;
  private readonly applyRemoteDelete: (key: CacheKey) => void;
  private readonly ackTimeoutMs: number;

  private readonly pendingAcks = new Map<string, AckWaiter>();
  private started = false;

  constructor(options: ReplicationEngineOptions) {
    super();
    this.nodeId = options.nodeId;
    this.eventBus = options.eventBus;
    this.getReplicaNodeIds = options.getReplicaNodeIds;
    this.applyRemoteWrite = options.applyRemoteWrite;
    this.applyRemoteDelete = options.applyRemoteDelete;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.eventBus.on(KafkaTopic.CACHE_REPLICATION, (message) =>
      this.handleMessage(message as ReplicationTopicMessage),
    );
    await this.eventBus.subscribeAll();
    this.started = true;
  }

  async dispose(): Promise<void> {
    for (const waiter of this.pendingAcks.values()) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(new Error('ReplicationEngine disposed while awaiting replication acks'));
    }
    this.pendingAcks.clear();
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------
  // Primary-side: publish replication events
  // -------------------------------------------------------------------

  /** Call immediately after applying a write locally on the primary. */
  async replicateWrite(key: CacheKey, value: unknown, metadata: CacheMetadata): Promise<string[]> {
    return this.replicate(key, 'PUT', value, metadata);
  }

  /** Call immediately after applying a delete locally on the primary. */
  async replicateDelete(key: CacheKey): Promise<string[]> {
    return this.replicate(key, 'DELETE');
  }

  private async replicate(
    key: CacheKey,
    op: 'PUT' | 'DELETE',
    value?: unknown,
    metadata?: CacheMetadata,
  ): Promise<string[]> {
    const targetNodeIds = this.getReplicaNodeIds(key).filter((id) => id !== this.nodeId);
    if (targetNodeIds.length === 0) {
      return []; // no other node currently holds a replica of this key
    }

    const event: ReplicationEvent = {
      eventId: generateId('repl'),
      sourceNodeId: this.nodeId,
      key,
      op,
      value,
      metadata,
      timestamp: nowMs(),
    };

    const ackPromise = this.registerAckWaiter(event.eventId, targetNodeIds);

    const message: ReplicationTopicMessage = { kind: 'event', event, targetNodeIds };
    await this.eventBus.publish(KafkaTopic.CACHE_REPLICATION, message, key);

    return ackPromise;
  }

  private registerAckWaiter(eventId: string, targetNodeIds: string[]): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const waiter = this.pendingAcks.get(eventId);
        if (!waiter) return;
        this.pendingAcks.delete(eventId);
        // Resolve with whatever partial ack set arrived, rather than
        // rejecting: the event itself is already durably in Kafka, so
        // slow replicas will still apply it once they catch up — a
        // timeout here means "replication is lagging," not "the write
        // was lost."
        resolve([...waiter.ackedBy]);
        this.emit('ackTimeout', { eventId, ackedBy: [...waiter.ackedBy], targetNodeIds: [...waiter.targetNodeIds] });
      }, this.ackTimeoutMs);
      timeoutHandle.unref?.();

      this.pendingAcks.set(eventId, {
        eventId,
        targetNodeIds: new Set(targetNodeIds),
        ackedBy: new Set(),
        resolve,
        reject,
        timeoutHandle,
      });
    });
  }

  // -------------------------------------------------------------------
  // Replica-side: consume events, apply, ack
  // -------------------------------------------------------------------

  private async handleMessage(message: ReplicationTopicMessage): Promise<void> {
    if (message.kind === 'event') {
      await this.handleReplicationEvent(message.event, message.targetNodeIds);
    } else {
      this.handleAck(message.ack);
    }
  }

  private async handleReplicationEvent(event: ReplicationEvent, targetNodeIds: string[]): Promise<void> {
    // The topic is shared cluster-wide (not partitioned per node), so
    // every node consumes every event and must decide for itself
    // whether it's actually one of the intended replica targets.
    if (event.sourceNodeId === this.nodeId || !targetNodeIds.includes(this.nodeId)) {
      return;
    }

    let ack: ReplicationAck;
    try {
      if (event.op === 'PUT') {
        if (!event.metadata) {
          throw new ReplicationError(`Replication PUT event ${event.eventId} for key "${event.key}" has no metadata`);
        }
        this.applyRemoteWrite(event.key, event.value, event.metadata);
      } else {
        this.applyRemoteDelete(event.key);
      }
      ack = { eventId: event.eventId, replicaNodeId: this.nodeId, success: true, appliedAt: nowMs() };
    } catch (err) {
      ack = {
        eventId: event.eventId,
        replicaNodeId: this.nodeId,
        success: false,
        appliedAt: nowMs(),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.emit('applied', { event, ack });

    const ackMessage: ReplicationTopicMessage = { kind: 'ack', ack };
    await this.eventBus.publish(KafkaTopic.CACHE_REPLICATION, ackMessage, event.key);
  }

  private handleAck(ack: ReplicationAck): void {
    const waiter = this.pendingAcks.get(ack.eventId);
    if (!waiter) return; // ack for an event this node isn't (or is no longer) waiting on

    if (ack.success) {
      waiter.ackedBy.add(ack.replicaNodeId);
    }
    this.emit('ack', ack);

    const allTargetsAcked = [...waiter.targetNodeIds].every((id) => waiter.ackedBy.has(id));
    if (allTargetsAcked) {
      clearTimeout(waiter.timeoutHandle);
      this.pendingAcks.delete(ack.eventId);
      waiter.resolve([...waiter.ackedBy]);
    }
  }

  // -------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------

  /** Number of replication events published by this node that are
   *  still waiting on acks from one or more targets. Fed into
   *  `MetricsCollector.recordReplicationQueueDepth()`. */
  getPendingAckCount(): number {
    return this.pendingAcks.size;
  }
}