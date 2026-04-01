/**
 * Event stream service — in-memory pub/sub for real-time SSE events.
 *
 * Mission Control subscribes via GET /api/v1/events/:orgId.
 * Webhook handlers publish events when messages arrive or agents respond.
 * Uses Node EventEmitter — zero external dependencies, suitable for
 * single-process deployments. For multi-instance, swap for Redis Pub/Sub.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../logger.js';

const logger = createLogger('event-stream');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentEvent {
  orgId: string;
  action: string;           // "message.received", "agent.responded", etc.
  entityType: string;       // "MESSAGE", "TASK", "CALL", etc.
  entityId?: string;
  entityTitle?: string;
  agentType?: string;       // "orchestrator", "whatsapp_handler", etc.
  channel?: string;         // "whatsapp", "voice", "web", "sms"
  timestamp: string;        // ISO 8601
  metadata?: Record<string, unknown>;
}

// ─── Service ────────────────────────────────────────────────────────────────

class EventStreamService {
  private emitter = new EventEmitter();

  constructor() {
    // Each connected Mission Control tab is one listener per orgId key.
    // 100 concurrent connections per org is a safe upper bound.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publish an event to all subscribers for the given org.
   * Synchronous (in-memory emit) — effectively instant, never blocks callers.
   */
  publish(event: AgentEvent): void {
    this.emitter.emit(`org:${event.orgId}`, event);
    logger.debug(
      { orgId: event.orgId, action: event.action, channel: event.channel },
      'Event published',
    );
  }

  /**
   * Subscribe to events for a given org.
   * Returns an unsubscribe function — call it when the SSE client disconnects.
   */
  subscribe(orgId: string, callback: (event: AgentEvent) => void): () => void {
    const key = `org:${orgId}`;
    this.emitter.on(key, callback);
    logger.info({ orgId, listeners: this.emitter.listenerCount(key) }, 'SSE client subscribed');

    return () => {
      this.emitter.off(key, callback);
      logger.info({ orgId, listeners: this.emitter.listenerCount(key) }, 'SSE client unsubscribed');
    };
  }

  /** Current listener count for an org — useful for health checks. */
  listenerCount(orgId: string): number {
    return this.emitter.listenerCount(`org:${orgId}`);
  }
}

// Singleton — shared across all route handlers in the process
export const eventStream = new EventStreamService();
