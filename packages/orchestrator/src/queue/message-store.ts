/**
 * Simple message store for tracking outbound messages.
 * Uses Redis with TTL (7 days) for automatic cleanup.
 * Enables reply matching for SpokeStack and other integrations.
 */

import Redis from 'ioredis';
import { createLogger } from '../logger.js';
import type { Message } from '../types.js';
import type { RedisStreamsConfig } from './redis-streams.js';

const logger = createLogger('message-store');

const KEY_PREFIX = 'agentvbx:msg:';
const DEFAULT_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export class MessageStore {
  private redis: Redis;
  private connected = false;

  constructor(config: RedisStreamsConfig) {
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.redis.connect();
    this.connected = true;
    logger.info('Message store connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.redis.quit();
    this.connected = false;
    logger.info('Message store disconnected');
  }

  /**
   * Store a message for later reply matching.
   */
  async store(message: Message): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}${message.id}`,
      JSON.stringify(message),
      'EX',
      DEFAULT_TTL,
    );
  }

  /**
   * Retrieve a stored message by ID.
   */
  async get(messageId: string): Promise<Message | null> {
    const data = await this.redis.get(`${KEY_PREFIX}${messageId}`);
    if (!data) return null;
    return JSON.parse(data) as Message;
  }
}
