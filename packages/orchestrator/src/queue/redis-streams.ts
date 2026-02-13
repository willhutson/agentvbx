/**
 * Redis Streams message queue with priority lanes.
 * Voice gets priority over chat, chat over background tasks.
 */

import Redis from 'ioredis';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import type { Message, QueueMessage, QueuePriority } from '../types.js';

const logger = createLogger('redis-streams');

// Stream names for priority lanes
const STREAMS = {
  voice: 'agentvbx:queue:voice',
  chat: 'agentvbx:queue:chat',
  background: 'agentvbx:queue:background',
} as const;

const CONSUMER_GROUP = 'agentvbx-workers';
const MAX_ATTEMPTS = 3;

export interface RedisStreamsConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export class RedisStreams {
  private redis: Redis;
  private subscriber: Redis;
  private connected = false;

  constructor(private config: RedisStreamsConfig) {
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db ?? 0,
      keyPrefix: config.keyPrefix,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
    });

    this.subscriber = this.redis.duplicate();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.redis.ping();
      this.connected = true;
      logger.info('Connected to Redis');

      // Ensure consumer groups exist for each stream
      for (const stream of Object.values(STREAMS)) {
        try {
          await this.redis.xgroup('CREATE', stream, CONSUMER_GROUP, '0', 'MKSTREAM');
          logger.info({ stream }, 'Created consumer group');
        } catch (err: unknown) {
          // Group already exists — that's fine
          if (err instanceof Error && err.message.includes('BUSYGROUP')) {
            logger.debug({ stream }, 'Consumer group already exists');
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Redis');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
    await this.subscriber.quit();
    this.connected = false;
    logger.info('Disconnected from Redis');
  }

  /**
   * Publish a message to the appropriate priority stream.
   * Voice messages go to the voice lane, WhatsApp/Telegram/SMS to chat, everything else to background.
   */
  async publish(message: Message, priority?: QueuePriority): Promise<string> {
    const resolvedPriority = priority ?? this.resolvePriority(message);
    const stream = STREAMS[resolvedPriority];
    const queueId = uuid();

    const queueMessage: QueueMessage = {
      id: queueId,
      stream,
      priority: resolvedPriority,
      message,
      created_at: new Date().toISOString(),
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
    };

    const messageId = await this.redis.xadd(
      stream,
      '*',
      'id', queueId,
      'data', JSON.stringify(queueMessage),
      'tenant_id', message.tenant_id,
      'priority', resolvedPriority,
    );

    logger.info({
      queueId,
      messageId,
      stream,
      priority: resolvedPriority,
      tenant_id: message.tenant_id,
      channel: message.channel,
    }, 'Message published');

    return queueId;
  }

  /**
   * Consume messages from priority streams. Voice is checked first, then chat, then background.
   * Uses XREADGROUP for consumer group semantics (at-least-once delivery).
   */
  async consume(
    consumerName: string,
    handler: (msg: QueueMessage) => Promise<void>,
    options: { batchSize?: number; blockMs?: number } = {},
  ): Promise<void> {
    const { batchSize = 5, blockMs = 2000 } = options;

    // Read from all streams in priority order
    const streams = [STREAMS.voice, STREAMS.chat, STREAMS.background];
    const ids = streams.map(() => '>');

    try {
      const results = await this.redis.xreadgroup(
        'GROUP', CONSUMER_GROUP, consumerName,
        'COUNT', batchSize,
        'BLOCK', blockMs,
        'STREAMS', ...streams, ...ids,
      );

      if (!results) return;

      for (const [_stream, messages] of results as [string, [string, string[]][]][]) {
        for (const [messageId, fields] of messages) {
          const dataIdx = fields.indexOf('data');
          if (dataIdx === -1) continue;

          const raw = fields[dataIdx + 1];
          const queueMsg: QueueMessage = JSON.parse(raw);
          queueMsg.attempts += 1;

          try {
            await handler(queueMsg);
            // Acknowledge successful processing
            await this.redis.xack(_stream as string, CONSUMER_GROUP, messageId);
            logger.debug({ id: queueMsg.id, messageId }, 'Message acknowledged');
          } catch (err) {
            logger.error({ err, id: queueMsg.id, attempts: queueMsg.attempts }, 'Handler failed');

            if (queueMsg.attempts >= queueMsg.max_attempts) {
              // Move to dead letter queue
              await this.redis.xadd(
                'agentvbx:queue:dead-letter',
                '*',
                'data', JSON.stringify(queueMsg),
                'error', String(err),
              );
              await this.redis.xack(_stream as string, CONSUMER_GROUP, messageId);
              logger.warn({ id: queueMsg.id }, 'Message moved to dead letter queue');
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('NOGROUP')) {
        await this.connect(); // Recreate groups
      } else {
        logger.error({ err }, 'Consumer error');
        throw err;
      }
    }
  }

  /**
   * Get pending messages (not yet acknowledged) for recovery.
   */
  async getPending(stream: string, count = 10): Promise<unknown[]> {
    return this.redis.xpending(stream, CONSUMER_GROUP, '-', '+', count);
  }

  /**
   * Get stream length for monitoring.
   */
  async getStreamLength(priority: QueuePriority): Promise<number> {
    return this.redis.xlen(STREAMS[priority]);
  }

  /**
   * Get all stream lengths for health checks.
   */
  async getQueueStats(): Promise<Record<QueuePriority, number>> {
    const [voice, chat, background] = await Promise.all([
      this.redis.xlen(STREAMS.voice),
      this.redis.xlen(STREAMS.chat),
      this.redis.xlen(STREAMS.background),
    ]);
    return { voice, chat, background };
  }

  /**
   * Resolve message priority based on channel.
   * Voice calls get highest priority, chat channels get normal, everything else is background.
   */
  private resolvePriority(message: Message): QueuePriority {
    if (message.channel === 'voice') return 'voice';
    if (['whatsapp', 'telegram', 'sms', 'app'].includes(message.channel)) return 'chat';
    return 'background';
  }
}
