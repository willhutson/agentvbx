/**
 * Event subscription helper — registers VBX as a webhook subscriber
 * in spokestack-core's event system.
 *
 * Called per-org during setup (not at boot) to subscribe to entity
 * events that trigger VBX notification recipes.
 */

import { createLogger } from './logger.js';

const logger = createLogger('event-subscriber');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EventSubscriptionConfig {
  entityType: string;
  action: string;
  conditions?: Record<string, unknown>;
  description: string;
}

export interface EventSubscriptionResult {
  id: string;
  entityType: string;
  action: string;
  handler: string;
  enabled: boolean;
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register a single event webhook subscription in spokestack-core.
 */
export async function registerEventWebhook(
  coreUrl: string,
  apiKey: string,
  orgId: string,
  webhookUrl: string,
  config: EventSubscriptionConfig,
): Promise<EventSubscriptionResult> {
  const res = await fetch(`${coreUrl}/api/v1/events/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-Org-Id': orgId,
    },
    body: JSON.stringify({
      entityType: config.entityType,
      action: config.action,
      handler: `webhook:${webhookUrl}`,
      config: {
        conditions: config.conditions,
        description: config.description,
      },
      enabled: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, entityType: config.entityType, action: config.action }, 'Failed to register event webhook');
    throw new Error(`Failed to register event webhook: ${res.status} ${text}`);
  }

  const result = (await res.json()) as EventSubscriptionResult;
  logger.info(
    { id: result.id, entityType: config.entityType, action: config.action },
    'Event webhook registered',
  );
  return result;
}

// ─── VBX Event Recipes ──────────────────────────────────────────────────────

/** All event subscriptions VBX needs for its notification recipes. */
export const VBX_EVENT_SUBSCRIPTIONS: EventSubscriptionConfig[] = [
  {
    entityType: 'Project',
    action: 'status_changed',
    conditions: { toStatus: 'COMPLETED' },
    description: 'VBX: Project completed notification',
  },
  {
    entityType: 'Brief',
    action: 'updated',
    description: 'VBX: Brief assignment notification',
  },
  {
    entityType: 'Client',
    action: 'created',
    description: 'VBX: New client notification',
  },
  {
    entityType: 'Order',
    action: 'created',
    description: 'VBX: New order notification',
  },
  {
    entityType: 'Integration',
    action: 'sync_completed',
    description: 'VBX: Sync completed notification',
  },
];

/**
 * Register all VBX event recipe subscriptions for an org.
 * Call this during org onboarding or from an admin setup flow.
 */
export async function registerAllVBXSubscriptions(
  coreUrl: string,
  apiKey: string,
  orgId: string,
  vbxWebhookBaseUrl: string,
): Promise<EventSubscriptionResult[]> {
  const webhookUrl = `${vbxWebhookBaseUrl}/api/webhooks/spokestack-events`;
  const results: EventSubscriptionResult[] = [];

  for (const config of VBX_EVENT_SUBSCRIPTIONS) {
    const result = await registerEventWebhook(coreUrl, apiKey, orgId, webhookUrl, config);
    results.push(result);
  }

  logger.info({ orgId, count: results.length }, 'All VBX event subscriptions registered');
  return results;
}
