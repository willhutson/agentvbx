/**
 * SpokeStack entity event webhook receiver.
 *
 * POST /api/webhooks/spokestack-events
 *
 * Receives entity event payloads from spokestack-core's event system
 * and routes them to the appropriate notification recipe.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../logger.js';
import { eventStream } from '../../services/eventStream.js';

const logger = createLogger('spokestack-events');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EntityEvent {
  entityType: string;
  entityId: string;
  action: string;
  organizationId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

// ─── Recipe Resolver ────────────────────────────────────────────────────────

/**
 * Map an entity event to the matching VBX notification recipe name.
 * Returns null if no recipe matches.
 */
export function resolveRecipe(
  entityType: string,
  action: string,
  metadata?: Record<string, unknown>,
): string | null {
  if (entityType === 'Project' && action === 'status_changed' && metadata?.toStatus === 'COMPLETED') {
    return 'project-completed-notification';
  }
  if (entityType === 'Brief' && action === 'updated' && Array.isArray(metadata?.changedFields) && (metadata.changedFields as string[]).includes('assigneeId')) {
    return 'brief-assigned-notification';
  }
  if (entityType === 'Client' && action === 'created') {
    return 'client-created-notification';
  }
  if (entityType === 'Order' && action === 'created') {
    return 'order-created-notification';
  }
  if (entityType === 'Integration' && action === 'sync_completed') {
    return 'integration-sync-notification';
  }
  return null;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createSpokeStackEventsRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    // Verify webhook secret if configured
    const webhookSecret = process.env.SPOKESTACK_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-spokestack-signature'] as string;
      if (!signature) {
        res.status(401).json({ error: 'Missing webhook signature' });
        return;
      }
      const { createHmac } = await import('node:crypto');
      const expected = createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (signature !== expected) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    const event = req.body as EntityEvent;
    const { entityType, entityId, action, organizationId, metadata } = event;

    if (!entityType || !action) {
      res.status(400).json({ error: 'Missing entityType or action' });
      return;
    }

    logger.info(
      { entityType, entityId, action, orgId: organizationId },
      'SpokeStack entity event received',
    );

    // Publish to SSE event stream for Mission Control
    if (organizationId) {
      eventStream.publish({
        orgId: organizationId,
        action: `entity.${action}`,
        entityType: entityType.toUpperCase(),
        entityId,
        channel: 'platform',
        timestamp: event.timestamp ?? new Date().toISOString(),
        metadata,
      });
    }

    // Resolve to a notification recipe
    const recipeName = resolveRecipe(entityType, action, metadata);
    if (!recipeName) {
      res.json({ ok: true, skipped: true, reason: 'No matching recipe' });
      return;
    }

    logger.info(
      { entityType, action, recipeName, orgId: organizationId },
      'Entity event matched to recipe',
    );

    // Return the matched recipe name — the orchestrator handles actual execution.
    // The caller (spokestack-core) can use this to verify which recipe was triggered.
    res.json({
      ok: true,
      recipe: recipeName,
      entityType,
      action,
      entityId,
    });
  });

  return router;
}
