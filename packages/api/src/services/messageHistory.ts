/**
 * Org-scoped message history — Redis sorted set per org.
 *
 * Stores messages in a sorted set (score = Unix timestamp in ms) with
 * 7-day TTL auto-trim. Full message payloads are stored in separate
 * keys with matching TTL.
 *
 * Uses ioredis, matching the existing Redis pattern in packages/orchestrator.
 */

import Redis from 'ioredis';
import { createLogger } from '../logger.js';

const logger = createLogger('message-history');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  orgId: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  content: string;
  from?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MessageHistoryConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HISTORY_TTL_DAYS = 7;
const HISTORY_TTL_MS = HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_TTL_SECONDS = HISTORY_TTL_DAYS * 24 * 60 * 60;

function orgMessagesKey(orgId: string): string {
  return `org:${orgId}:messages`;
}

function messageDetailKey(orgId: string, messageId: string): string {
  return `org:${orgId}:msg:${messageId}`;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class MessageHistoryService {
  private redis: Redis;

  constructor(config?: MessageHistoryConfig) {
    this.redis = new Redis({
      host: config?.host ?? process.env.REDIS_HOST ?? 'localhost',
      port: config?.port ?? parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: config?.password ?? process.env.REDIS_PASSWORD ?? undefined,
      db: config?.db ?? 0,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
    });

    this.redis.on('error', (err) => {
      logger.error({ err }, 'Message history Redis error');
    });
  }

  /**
   * Save a message to the org's history.
   */
  async addMessage(orgId: string, message: StoredMessage): Promise<void> {
    try {
      await this.redis.connect().catch(() => {/* already connected */});
    } catch { /* ignore */ }

    const score = new Date(message.timestamp).getTime();
    const messageJson = JSON.stringify(message);

    const pipeline = this.redis.pipeline();
    pipeline.zadd(orgMessagesKey(orgId), score, message.id);
    pipeline.set(messageDetailKey(orgId, message.id), messageJson, 'EX', HISTORY_TTL_SECONDS);
    pipeline.expire(orgMessagesKey(orgId), HISTORY_TTL_SECONDS);
    await pipeline.exec();

    // Trim entries older than 7 days
    const cutoff = Date.now() - HISTORY_TTL_MS;
    await this.redis.zremrangebyscore(orgMessagesKey(orgId), '-inf', cutoff);
  }

  /**
   * Get recent messages for an org, newest first.
   * @param before - Unix timestamp in ms for pagination (return messages older than this)
   */
  async getHistory(orgId: string, limit = 50, before?: number): Promise<StoredMessage[]> {
    try {
      await this.redis.connect().catch(() => {/* already connected */});
    } catch { /* ignore */ }

    const maxScore = before !== undefined ? String(before - 1) : '+inf';
    const minScore = String(Date.now() - HISTORY_TTL_MS);

    const messageIds = await this.redis.zrevrangebyscore(
      orgMessagesKey(orgId),
      maxScore,
      minScore,
      'LIMIT',
      0,
      limit,
    );

    if (messageIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of messageIds) {
      pipeline.get(messageDetailKey(orgId, id));
    }
    const results = await pipeline.exec();

    const messages: StoredMessage[] = [];
    if (results) {
      for (const [err, raw] of results) {
        if (!err && raw && typeof raw === 'string') {
          try {
            messages.push(JSON.parse(raw) as StoredMessage);
          } catch {
            // skip malformed entries
          }
        }
      }
    }

    return messages;
  }

  /**
   * Get the total message count for an org (within the 7-day window).
   */
  async getMessageCount(orgId: string): Promise<number> {
    try {
      await this.redis.connect().catch(() => {/* already connected */});
    } catch { /* ignore */ }

    const minScore = Date.now() - HISTORY_TTL_MS;
    return this.redis.zcount(orgMessagesKey(orgId), minScore, '+inf');
  }

  /**
   * Disconnect from Redis.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
