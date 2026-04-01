/**
 * Per-tenant WhatsApp webhook route.
 *
 * POST /webhook/:orgSlug/whatsapp
 *
 * Resolves org by slug, validates WhatsApp channel is active,
 * then normalizes the payload and routes to the orchestrator with orgId context.
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../../logger.js';
import type { Orchestrator } from '../../types.js';
import type { OrgResolver } from '../../services/orgResolver.js';
import { orgSlugMiddleware } from '../../middleware/orgSlugMiddleware.js';

const logger = createLogger('webhook-whatsapp');

export function createWhatsAppWebhookRouter(
  resolver: OrgResolver,
  getOrchestrator: () => Orchestrator | undefined,
): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    orgSlugMiddleware(resolver, 'whatsapp'),
    async (req: Request, res: Response) => {
      const orchestrator = getOrchestrator();
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not ready' });
        return;
      }

      const org = req.org!;
      const body = req.body;

      // Normalize the inbound WhatsApp payload into a Message.
      // Supports Meta webhook format (messages[0]) and flat format.
      const entry = body.entry?.[0]?.changes?.[0]?.value;
      const waMsg = entry?.messages?.[0];

      const from = waMsg?.from ?? body.from ?? 'unknown';
      const to = waMsg?.metadata?.display_phone_number ?? body.to ?? 'unknown';
      const text = waMsg?.text?.body ?? body.text ?? body.body ?? '';
      const timestamp = waMsg?.timestamp
        ? new Date(Number(waMsg.timestamp) * 1000).toISOString()
        : new Date().toISOString();

      const message = {
        id: uuid(),
        tenant_id: org.orgId,
        number_id: body.number_id ?? to,
        channel: 'whatsapp' as const,
        direction: 'inbound' as const,
        from,
        to,
        text,
        timestamp,
        metadata: {
          source: 'webhook',
          org_slug: req.params.orgSlug,
          has_media: !!(waMsg?.image ?? waMsg?.video ?? waMsg?.audio ?? waMsg?.document),
        },
      };

      const queueId = await orchestrator.handleMessage(message);

      logger.info(
        { orgId: org.orgId, slug: req.params.orgSlug, from, queueId },
        'WhatsApp webhook routed',
      );

      res.status(200).json({ received: true, queue_id: queueId });
    },
  );

  // GET handler for Meta webhook verification
  router.get(
    '/',
    (req: Request, res: Response) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      // Verify token should be per-org in production;
      // for now, check against env var
      const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
      if (mode === 'subscribe' && token === verifyToken) {
        logger.info({ slug: req.params.orgSlug }, 'WhatsApp webhook verified');
        res.status(200).send(challenge);
        return;
      }

      res.status(403).json({ error: 'Verification failed' });
    },
  );

  return router;
}
