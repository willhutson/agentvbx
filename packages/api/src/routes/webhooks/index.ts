/**
 * Per-tenant webhook router.
 *
 * Mounts channel-specific webhook routes under /:orgSlug/<channel>.
 *
 *   POST /webhook/:orgSlug/whatsapp
 *   GET  /webhook/:orgSlug/whatsapp  (Meta verification)
 *   POST /webhook/:orgSlug/voice
 *   GET  /webhook/:orgSlug/voice     (Telnyx verification)
 */

import { Router } from 'express';
import { OrgResolver } from '../../services/orgResolver.js';
import { MessageHistoryService } from '../../services/messageHistory.js';
import { createWhatsAppWebhookRouter } from './whatsapp.js';
import { createVoiceWebhookRouter } from './voice.js';
import type { Orchestrator } from '../../types.js';

export function createWebhookRouter(
  getOrchestrator: () => Orchestrator | undefined,
  messageHistory?: MessageHistoryService,
): Router {
  const router = Router();
  const resolver = new OrgResolver();

  router.use(
    '/:orgSlug/whatsapp',
    createWhatsAppWebhookRouter(resolver, getOrchestrator, messageHistory),
  );

  router.use(
    '/:orgSlug/voice',
    createVoiceWebhookRouter(resolver, getOrchestrator, messageHistory),
  );

  return router;
}

export { OrgResolver } from '../../services/orgResolver.js';
export { orgSlugMiddleware } from '../../middleware/orgSlugMiddleware.js';
