/**
 * WhatsApp <-> Orchestrator bridge.
 *
 * Connects the WhatsApp client to the orchestrator queue.
 * Inbound WhatsApp messages are normalized and published to the queue.
 * Outbound messages (responses) are sent back via WhatsApp.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from './logger.js';
import type { WhatsAppClient, WhatsAppMessage } from './client.js';

const logger = createLogger('whatsapp-bridge');

export interface WhatsAppBridgeConfig {
  tenant_id: string;
  number_id: string;
}

export interface MessagePublisher {
  handleMessage(message: {
    id: string;
    tenant_id: string;
    number_id: string;
    channel: 'whatsapp';
    direction: 'inbound';
    from: string;
    to: string;
    text: string;
    timestamp: string;
    attachments?: Array<{ filename: string; mime_type: string; size_bytes: number; url?: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

export class WhatsAppBridge {
  private client: WhatsAppClient;
  private publisher: MessagePublisher;
  private config: WhatsAppBridgeConfig;

  constructor(client: WhatsAppClient, publisher: MessagePublisher, config: WhatsAppBridgeConfig) {
    this.client = client;
    this.publisher = publisher;
    this.config = config;
  }

  /**
   * Start listening to WhatsApp messages and bridging them to the orchestrator.
   */
  start(): void {
    this.client.on('message', (msg: WhatsAppMessage) => {
      this.handleInbound(msg).catch((err) => {
        logger.error({ err, from: msg.from }, 'Failed to bridge WhatsApp message');
      });
    });

    this.client.on('ready', () => {
      logger.info({ tenant: this.config.tenant_id }, 'WhatsApp bridge ready');
    });

    logger.info('WhatsApp bridge started');
  }

  /**
   * Send a response back via WhatsApp.
   */
  async sendResponse(to: string, text: string, _metadata?: Record<string, unknown>): Promise<void> {
    await this.client.sendMessage(to, text);
  }

  /**
   * Handle an inbound WhatsApp message.
   */
  private async handleInbound(msg: WhatsAppMessage): Promise<void> {
    // Skip group messages for now (can be enabled per-tenant later)
    if (msg.isGroup) {
      logger.debug({ from: msg.from }, 'Skipping group message');
      return;
    }

    const message = {
      id: msg.id || uuid(),
      tenant_id: this.config.tenant_id,
      number_id: this.config.number_id,
      channel: 'whatsapp' as const,
      direction: 'inbound' as const,
      from: msg.from,
      to: msg.to,
      text: msg.body,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      metadata: {
        has_media: msg.hasMedia,
        is_group: msg.isGroup,
        author: msg.author,
      },
    };

    const queueId = await this.publisher.handleMessage(message);
    logger.info({ from: msg.from, queueId, preview: msg.body.substring(0, 50) }, 'WhatsApp message bridged to queue');
  }
}
