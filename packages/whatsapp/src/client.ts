/**
 * WhatsApp client using WWeb.js for Phase 1.
 *
 * Phase 1: WWeb.js (WhatsApp Web protocol, QR code auth)
 * Phase 2+: Telnyx WABA / direct Meta BSP (Business API on same number as voice)
 *
 * The client normalizes WhatsApp messages into the channel-agnostic Message format
 * and publishes them to the orchestrator's queue for routing.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';

const logger = createLogger('whatsapp-client');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WhatsAppConfig {
  session_path: string;
  tenant_id: string;
  number_id: string;
  headless?: boolean;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  isGroup: boolean;
  author?: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface WhatsAppClientEvents {
  ready: () => void;
  qr: (qr: string) => void;
  message: (msg: WhatsAppMessage) => void;
  disconnected: (reason: string) => void;
  auth_failure: (error: string) => void;
}

// ─── WhatsApp Client ────────────────────────────────────────────────────────

/**
 * WhatsApp client wrapper around WWeb.js.
 * Emits normalized events that the orchestrator can consume.
 *
 * Usage:
 *   const client = new WhatsAppClient(config);
 *   client.on('message', handleMessage);
 *   client.on('qr', displayQR);
 *   await client.initialize();
 */
export class WhatsAppClient extends EventEmitter {
  private config: WhatsAppConfig;
  private client: unknown = null; // WWeb.js Client instance
  private ready = false;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize the WhatsApp Web client.
   * Emits 'qr' event with QR code data for authentication.
   * Emits 'ready' when authenticated and ready to send/receive.
   */
  async initialize(): Promise<void> {
    logger.info({ tenant: this.config.tenant_id }, 'Initializing WhatsApp client');

    try {
      // Dynamic import to avoid issues when WWeb.js is not installed
      const { Client, LocalAuth } = await import('whatsapp-web.js');

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: this.config.session_path,
          clientId: this.config.tenant_id,
        }),
        puppeteer: {
          headless: this.config.headless ?? true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      });

      const client = this.client as InstanceType<typeof Client>;

      // QR code for authentication
      client.on('qr', (qr: string) => {
        logger.info('QR code received — scan to authenticate');
        this.emit('qr', qr);

        // Also display in terminal for development
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const qrcodeTerminal = require('qrcode-terminal');
          qrcodeTerminal.generate(qr, { small: true });
        } catch {
          // qrcode-terminal not available, that's fine
        }
      });

      // Ready
      client.on('ready', () => {
        this.ready = true;
        logger.info({ tenant: this.config.tenant_id }, 'WhatsApp client ready');
        this.emit('ready');
      });

      // Incoming message
      client.on('message', (msg: { id: { _serialized: string }; from: string; to: string; body: string; timestamp: number; hasMedia: boolean; fromMe: boolean; author?: string }) => {
        if (msg.fromMe) return; // Skip our own messages

        const normalized: WhatsAppMessage = {
          id: msg.id._serialized,
          from: msg.from,
          to: msg.to,
          body: msg.body,
          timestamp: msg.timestamp,
          hasMedia: msg.hasMedia,
          isGroup: msg.from.includes('@g.us'),
          author: msg.author,
        };

        logger.info({ from: normalized.from, preview: normalized.body.substring(0, 50) }, 'Message received');
        this.emit('message', normalized);
      });

      // Disconnected
      client.on('disconnected', (reason: string) => {
        this.ready = false;
        logger.warn({ reason }, 'WhatsApp client disconnected');
        this.emit('disconnected', reason);
      });

      // Auth failure
      client.on('auth_failure', (error: string) => {
        logger.error({ error }, 'WhatsApp authentication failed');
        this.emit('auth_failure', error);
      });

      await client.initialize();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize WhatsApp client');
      throw err;
    }
  }

  /**
   * Send a text message.
   */
  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp client not ready');
    }

    const client = this.client as { sendMessage: (to: string, text: string) => Promise<void> };
    await client.sendMessage(to, text);
    logger.info({ to, preview: text.substring(0, 50) }, 'Message sent');
  }

  /**
   * Send a message with media (image, video, document).
   */
  async sendMedia(to: string, mediaPath: string, caption?: string): Promise<void> {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp client not ready');
    }

    const { MessageMedia } = await import('whatsapp-web.js');
    const media = MessageMedia.fromFilePath(mediaPath);
    const client = this.client as { sendMessage: (to: string, media: unknown, options?: unknown) => Promise<void> };
    await client.sendMessage(to, media, { caption });
    logger.info({ to, mediaPath, caption }, 'Media sent');
  }

  /**
   * Check if the client is ready and connected.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Gracefully destroy the client.
   */
  async destroy(): Promise<void> {
    if (this.client) {
      const client = this.client as { destroy: () => Promise<void> };
      await client.destroy();
      this.ready = false;
      logger.info('WhatsApp client destroyed');
    }
  }
}
