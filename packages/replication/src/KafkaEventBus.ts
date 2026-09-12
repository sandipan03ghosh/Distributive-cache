/**
 * @flowcache/replication — KafkaEventBus.ts
 *
 * A thin wrapper around `kafkajs` (the one external dependency this
 * package needs — implementing the Kafka wire protocol from scratch is
 * out of scope for "no external *cache* libraries," which this isn't).
 * Every other package/service in FlowCache that needs Kafka goes
 * through this class rather than importing kafkajs directly, so there
 * is exactly one place that knows about topic subscription mechanics,
 * JSON encoding, and connection lifecycle.
 *
 * Kafka is used strictly for asynchronous, fire-and-forget-style
 * communication (replication, snapshot/metrics broadcast, node
 * join/leave announcements) — GET requests never touch this class; see
 * the architecture note in `services/cache-node`.
 */

import { Kafka, logLevel, type Consumer, type EachMessagePayload, type Producer } from 'kafkajs';
import type { Logger } from '@flowcache/shared';
import { KafkaTopic } from '@flowcache/shared';

export interface KafkaEventBusOptions {
  brokers: string[];
  clientId: string;
  consumerGroup: string;
  logger?: Logger;
}

export type TopicMessageHandler = (message: unknown, raw: EachMessagePayload) => Promise<void> | void;

export class KafkaEventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly options: KafkaEventBusOptions;
  private consumer: Consumer | null = null;
  private readonly handlers = new Map<string, TopicMessageHandler[]>();
  private producerConnected = false;
  private consumerRunning = false;

  constructor(options: KafkaEventBusOptions) {
    this.options = options;
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      // FlowCache's own structured logger (packages/shared) is used
      // instead of kafkajs's built-in logger.
      logLevel: logLevel.NOTHING,
      retry: { retries: 8, initialRetryTime: 300, maxRetryTime: 10_000 },
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
  }

  async connect(): Promise<void> {
    if (this.producerConnected) return;
    await this.producer.connect();
    this.producerConnected = true;
    this.options.logger?.info({ brokers: this.options.brokers }, 'Kafka producer connected');
  }

  /** Publishes a JSON-serializable message to a topic. `key` (if
   *  provided) is used as the Kafka partition key — publishing all
   *  events for a given cache key with that key as the partition key
   *  keeps per-key event ordering intact even with multiple
   *  partitions. */
  async publish<T>(topic: KafkaTopic | string, message: T, key?: string): Promise<void> {
    await this.connect();
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(message) }],
    });
  }

  /** Registers a handler for a topic. Multiple handlers may be
   *  registered per topic (all fire, in registration order, for every
   *  message). Handlers must be registered before calling
   *  `subscribeAll()` — kafkajs subscribes once and then runs a single
   *  long-lived consumer loop. */
  on(topic: KafkaTopic | string, handler: TopicMessageHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push(handler);
    this.handlers.set(topic, existing);
  }

  /** Starts the consumer loop for every topic that has at least one
   *  registered handler. Safe to call once; subsequent calls are
   *  no-ops if already running. */
  async subscribeAll(): Promise<void> {
    if (this.consumerRunning || this.handlers.size === 0) return;

    this.consumer = this.kafka.consumer({ groupId: this.options.consumerGroup });
    await this.consumer.connect();

    await Promise.all(
      [...this.handlers.keys()].map((topic) => this.consumer!.subscribe({ topic, fromBeginning: false })),
    );

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const topicHandlers = this.handlers.get(payload.topic);
        if (!topicHandlers || !payload.message.value) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.message.value.toString('utf8'));
        } catch (err) {
          this.options.logger?.warn(
            { topic: payload.topic, err },
            'Dropping malformed (non-JSON) Kafka message rather than crashing the consumer loop',
          );
          return;
        }

        for (const handler of topicHandlers) {
          await handler(parsed, payload);
        }
      },
    });

    this.consumerRunning = true;
    this.options.logger?.info({ topics: [...this.handlers.keys()] }, 'Kafka consumer subscribed and running');
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([
      this.producerConnected ? this.producer.disconnect() : Promise.resolve(),
      this.consumer ? this.consumer.disconnect() : Promise.resolve(),
    ]);
    this.producerConnected = false;
    this.consumerRunning = false;
  }
}