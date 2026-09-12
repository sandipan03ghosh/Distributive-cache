import { describe, it, expect } from 'vitest';
import { ReplicationEngine } from '@flowcache/replication';
import type { KafkaEventBus, TopicMessageHandler } from '@flowcache/replication';
import { KafkaTopic, type CacheMetadata } from '@flowcache/shared';

/**
 * A fake event bus standing in for a real Kafka broker: `publish`
 * synchronously fans a message out to every handler registered for
 * that topic across every ReplicationEngine instance sharing this
 * fake bus — modeling "every node independently consumes every event"
 * (see the KAFKA_CONSUMER_GROUP-per-node fix this test suite is
 * paired with), without needing a real broker in unit tests.
 */
class FakeEventBus {
  private readonly handlers = new Map<string, TopicMessageHandler[]>();

  on(topic: string, handler: TopicMessageHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push(handler);
    this.handlers.set(topic, existing);
  }

  async subscribeAll(): Promise<void> {
    /* no-op: handlers already fire synchronously from publish() */
  }

  async publish<T>(topic: string, message: T): Promise<void> {
    const topicHandlers = this.handlers.get(topic) ?? [];
    for (const handler of topicHandlers) {
      await handler(message, {} as never);
    }
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }
}

function metadata(version = 1): CacheMetadata {
  return { version, createdAt: 0, updatedAt: 0, lastAccessedAt: 0, frequency: 1, expiresAt: null, sizeBytes: 1 };
}

describe('ReplicationEngine', () => {
  it('replicates a write to target nodes and resolves once all ack', async () => {
    const bus = new FakeEventBus() as unknown as KafkaEventBus;

    const replicaStorage = new Map<string, unknown>();
    const primary = new ReplicationEngine({
      nodeId: 'node-1',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: () => {
        throw new Error('primary should never receive its own write back');
      },
      applyRemoteDelete: () => {
        throw new Error('unused');
      },
    });

    const replica = new ReplicationEngine({
      nodeId: 'node-2',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: (key, value) => replicaStorage.set(key, value),
      applyRemoteDelete: (key) => replicaStorage.delete(key),
    });

    await primary.start();
    await replica.start();

    const ackedBy = await primary.replicateWrite('user:1', { name: 'ada' }, metadata());

    expect(ackedBy).toEqual(['node-2']);
    expect(replicaStorage.get('user:1')).toEqual({ name: 'ada' });

    await primary.dispose();
    await replica.dispose();
  });

  it('replicates a delete the same way', async () => {
    const bus = new FakeEventBus() as unknown as KafkaEventBus;
    const replicaStorage = new Map<string, unknown>([['k1', 'v1']]);

    const primary = new ReplicationEngine({
      nodeId: 'node-1',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: () => undefined,
      applyRemoteDelete: () => undefined,
    });
    const replica = new ReplicationEngine({
      nodeId: 'node-2',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: (key, value) => replicaStorage.set(key, value),
      applyRemoteDelete: (key) => replicaStorage.delete(key),
    });

    await primary.start();
    await replica.start();

    await primary.replicateDelete('k1');
    expect(replicaStorage.has('k1')).toBe(false);

    await primary.dispose();
    await replica.dispose();
  });

  it('returns an empty ack list immediately when there are no other replica targets', async () => {
    const bus = new FakeEventBus() as unknown as KafkaEventBus;
    const solo = new ReplicationEngine({
      nodeId: 'node-1',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1'], // only itself
      applyRemoteWrite: () => undefined,
      applyRemoteDelete: () => undefined,
    });

    await solo.start();
    const acked = await solo.replicateWrite('k1', 'v1', metadata());
    expect(acked).toEqual([]);

    await solo.dispose();
  });

  it('a node ignores events not addressed to it', async () => {
    const bus = new FakeEventBus() as unknown as KafkaEventBus;
    let applyCalled = false;

    const primary = new ReplicationEngine({
      nodeId: 'node-1',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'], // node-3 not a target
      applyRemoteWrite: () => undefined,
      applyRemoteDelete: () => undefined,
    });
    const bystander = new ReplicationEngine({
      nodeId: 'node-3',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: () => {
        applyCalled = true;
      },
      applyRemoteDelete: () => undefined,
    });

    await primary.start();
    await bystander.start();
    await primary.replicateWrite('k1', 'v1', metadata());

    expect(applyCalled).toBe(false);

    await primary.dispose();
    await bystander.dispose();
  });

  it('getPendingAckCount() reflects in-flight (unacked) events', async () => {
    const bus = new FakeEventBus() as unknown as KafkaEventBus;
    // A "black hole" replica bus with no responder registered for
    // node-2, so the publish never gets an ack — use a short timeout.
    const primary = new ReplicationEngine({
      nodeId: 'node-1',
      eventBus: bus,
      getReplicaNodeIds: () => ['node-1', 'node-2'],
      applyRemoteWrite: () => undefined,
      applyRemoteDelete: () => undefined,
      ackTimeoutMs: 50,
    });

    await primary.start();
    const ackPromise = primary.replicateWrite('k1', 'v1', metadata());
    expect(primary.getPendingAckCount()).toBe(1);

    await ackPromise; // resolves with [] once the timeout elapses
    expect(primary.getPendingAckCount()).toBe(0);

    await primary.dispose();
  });
});