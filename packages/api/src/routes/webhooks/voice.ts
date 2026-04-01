/**
 * Per-tenant Voice/Telnyx webhook route.
 *
 * POST /webhook/:orgSlug/voice
 * GET  /webhook/:orgSlug/voice (Telnyx verification)
 *
 * Resolves org by slug, validates voice channel is active,
 * rate-limits per org, then routes the Telnyx event to the
 * orchestrator with orgId context.
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../../logger.js';
import type { Orchestrator } from '../../types.js';
import type { OrgResolver } from '../../services/orgResolver.js';
import type { MessageHistoryService, StoredMessage } from '../../services/messageHistory.js';
import { orgSlugMiddleware } from '../../middleware/orgSlugMiddleware.js';
import { rateLimiterMiddleware } from '../../middleware/rateLimiter.js';
import { channelHealth } from '../../services/channelHealth.js';

const logger = createLogger('webhook-voice');

// Telnyx event type → channel mapping
function channelForEvent(eventType: string): 'voice' | 'sms' {
  return eventType.startsWith('message.') ? 'sms' : 'voice';
}

export function createVoiceWebhookRouter(
  resolver: OrgResolver,
  getOrchestrator: () => Orchestrator | undefined,
  messageHistory?: MessageHistoryService,
): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    orgSlugMiddleware(resolver, 'voice'),
    rateLimiterMiddleware,
    async (req: Request, res: Response) => {
      const orchestrator = getOrchestrator();
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not ready' });
        return;
      }

      const org = req.org!;
      const event = req.body;
      const eventType = event?.data?.event_type;

      if (!eventType) {
        res.status(400).json({ error: 'Invalid webhook payload' });
        return;
      }

      // Acknowledge immediately — process asynchronously
      res.status(200).json({ received: true });

      const payload = event.data.payload ?? {};
      const channel = channelForEvent(eventType);
      const from = payload.from ?? 'unknown';
      const to = payload.to ?? 'unknown';

      // Track channel health for all voice events
      channelHealth.recordMessage(org.orgId, channel);

      // For transcription events and SMS, create a message for the orchestrator.
      if (eventType === 'call.transcription' || eventType === 'message.received') {
        const text = (payload.text as string) ?? '';
        if (!text.trim()) return;

        const messageId = uuid();
        const timestamp = event.data.occurred_at ?? new Date().toISOString();

        const message = {
          id: messageId,
          tenant_id: org.orgId,
          number_id: to,
          channel,
          direction: 'inbound' as const,
          from,
          to,
          text,
          timestamp,
          call_metadata: channel === 'voice'
            ? {
                call_id: payload.call_control_id ?? '',
                duration_seconds: 0,
                transcript: text,
              }
            : undefined,
          metadata: {
            source: 'webhook',
            org_slug: req.params.orgSlug,
            event_type: eventType,
          },
        };

        // Save to message history (fire-and-forget)
        if (messageHistory) {
          const stored: StoredMessage = {
            id: messageId,
            orgId: org.orgId,
            channel,
            direction: 'inbound',
            content: text,
            from,
            timestamp,
            metadata: { event_type: eventType },
          };
          messageHistory.addMessage(org.orgId, stored).catch(err =>
            logger.error({ err }, 'Failed to save voice message to history'),
          );
        }

        const queueId = await orchestrator.handleMessage(message);
        logger.info(
          { orgId: org.orgId, slug: req.params.orgSlug, eventType, queueId },
          'Voice webhook routed',
        );
      } else {
        logger.info(
          { orgId: org.orgId, eventType, callId: payload.call_control_id },
          'Voice event received (no message created)',
        );
      }
    },
  );

  // GET handler for Telnyx verification
  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  return router;
}
