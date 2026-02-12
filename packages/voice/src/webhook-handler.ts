/**
 * Telnyx webhook handler — processes inbound call and messaging events.
 *
 * Telnyx sends webhooks for:
 * - Inbound calls (call.initiated, call.answered, call.hangup)
 * - Voice AI events (call.ai_assistant.*, call.transcription)
 * - SMS/MMS (message.received, message.sent)
 * - Call recordings (call.recording.saved)
 *
 * This handler normalizes events into the channel-agnostic Message format
 * and forwards them to the orchestrator queue.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from './logger.js';

const logger = createLogger('telnyx-webhook');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TelnyxWebhookEvent {
  data: {
    event_type: string;
    id: string;
    occurred_at: string;
    payload: {
      call_control_id?: string;
      call_session_id?: string;
      from?: string;
      to?: string;
      direction?: string;
      state?: string;
      recording_urls?: { mp3: string };
      text?: string;
      media?: Array<{ url: string; content_type: string }>;
      [key: string]: unknown;
    };
    record_type: string;
  };
}

export type WebhookHandler = (event: TelnyxWebhookEvent) => Promise<void>;

// ─── Webhook Router ─────────────────────────────────────────────────────────

export function createWebhookRouter(handlers: {
  onInboundCall?: WebhookHandler;
  onCallAnswered?: WebhookHandler;
  onCallHangup?: WebhookHandler;
  onVoiceAIEvent?: WebhookHandler;
  onTranscription?: WebhookHandler;
  onSMSReceived?: WebhookHandler;
  onRecordingSaved?: WebhookHandler;
}): Router {
  const router = Router();

  router.post('/telnyx/webhook', async (req: Request, res: Response) => {
    const event = req.body as TelnyxWebhookEvent;
    const eventType = event?.data?.event_type;

    if (!eventType) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    logger.info({
      event_type: eventType,
      call_id: event.data.payload?.call_control_id,
      from: event.data.payload?.from,
    }, 'Webhook received');

    // Acknowledge immediately — process asynchronously
    res.status(200).json({ received: true });

    try {
      switch (eventType) {
        case 'call.initiated':
          if (event.data.payload?.direction === 'incoming') {
            await handlers.onInboundCall?.(event);
          }
          break;

        case 'call.answered':
          await handlers.onCallAnswered?.(event);
          break;

        case 'call.hangup':
          await handlers.onCallHangup?.(event);
          break;

        case 'call.ai_assistant.response':
        case 'call.ai_assistant.started':
        case 'call.ai_assistant.stopped':
          await handlers.onVoiceAIEvent?.(event);
          break;

        case 'call.transcription':
          await handlers.onTranscription?.(event);
          break;

        case 'message.received':
          await handlers.onSMSReceived?.(event);
          break;

        case 'call.recording.saved':
          await handlers.onRecordingSaved?.(event);
          break;

        default:
          logger.debug({ event_type: eventType }, 'Unhandled webhook event type');
      }
    } catch (err) {
      logger.error({ err, event_type: eventType }, 'Webhook handler error');
    }
  });

  return router;
}
