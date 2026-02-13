/**
 * Meta Webhooks handler — processes lead forms, ad events, and conversions.
 *
 * Receives webhook events from Meta and routes them into the AGENTVBX
 * orchestrator as messages/triggers for recipe execution.
 */

import { createLogger } from './logger.js';

const logger = createLogger('meta-webhooks');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MetaWebhookConfig {
  verify_token: string;
  app_secret: string;
}

export interface LeadgenEntry {
  id: string;
  time: number;
  changes: Array<{
    field: string;
    value: {
      form_id: string;
      leadgen_id: string;
      created_time: number;
      page_id: string;
      ad_id?: string;
      adgroup_id?: string;
    };
  }>;
}

export interface ProcessedLead {
  lead_id: string;
  form_id: string;
  page_id: string;
  ad_id?: string;
  fields: Record<string, string>;
  created_at: string;
}

export type WebhookHandler = (event: {
  type: 'lead' | 'ad_event' | 'conversion';
  data: unknown;
}) => void;

// ─── Webhook Processor ──────────────────────────────────────────────────────

export class MetaWebhookProcessor {
  private handlers: WebhookHandler[] = [];

  constructor(private config: MetaWebhookConfig) {}

  /**
   * Handle webhook verification challenge (GET request).
   */
  handleVerification(query: {
    'hub.mode'?: string;
    'hub.verify_token'?: string;
    'hub.challenge'?: string;
  }): { status: number; body: string } {
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === this.config.verify_token
    ) {
      logger.info('Webhook verification successful');
      return { status: 200, body: query['hub.challenge'] ?? '' };
    }
    return { status: 403, body: 'Verification failed' };
  }

  /**
   * Process an incoming webhook event (POST request).
   */
  async processEvent(body: {
    object: string;
    entry?: LeadgenEntry[];
  }): Promise<ProcessedLead[]> {
    if (body.object !== 'page' && body.object !== 'instagram') {
      logger.warn({ object: body.object }, 'Unknown webhook object type');
      return [];
    }

    const leads: ProcessedLead[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes) {
        if (change.field === 'leadgen') {
          const lead: ProcessedLead = {
            lead_id: change.value.leadgen_id,
            form_id: change.value.form_id,
            page_id: change.value.page_id,
            ad_id: change.value.ad_id,
            fields: {},
            created_at: new Date(change.value.created_time * 1000).toISOString(),
          };

          leads.push(lead);

          // Emit to handlers
          for (const handler of this.handlers) {
            try {
              handler({ type: 'lead', data: lead });
            } catch (err) {
              logger.error({ err }, 'Webhook handler error');
            }
          }
        }
      }
    }

    logger.info({ leads_count: leads.length }, 'Processed webhook leads');
    return leads;
  }

  /**
   * Validate webhook signature (HMAC SHA256).
   */
  validateSignature(payload: string, signature: string): boolean {
    // Use node:crypto for HMAC validation
    try {
      const crypto = require('node:crypto');
      const expectedSig = crypto
        .createHmac('sha256', this.config.app_secret)
        .update(payload)
        .digest('hex');
      return `sha256=${expectedSig}` === signature;
    } catch {
      logger.error('Signature validation failed');
      return false;
    }
  }

  /**
   * Register a webhook event handler.
   */
  onEvent(handler: WebhookHandler): void {
    this.handlers.push(handler);
  }
}
