/**
 * Cross-repo integration tests for VBX — Phase 6 + 7.
 *
 * These tests simulate the actual webhook payloads that spokestack-core
 * sends to VBX, testing the full handler chain: validation → recipe
 * resolution → SSE event publishing → response format.
 *
 * Maps to cross-repo test plan:
 *   Test 1  (step 6): Client lifecycle — Client.created → recipe
 *   Test 4  (step 5): Sync worker — Integration.sync_completed → recipe
 *   Test 5  (step 2): Order created → recipe
 *   Test 6  (step 5): Project completion → recipe + SSE
 *   Test 12 (step 3): Brief assignment → recipe
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createSpokeStackEventsRouter } from '../src/routes/webhooks/spokestack-events.js';
import { eventStream } from '../src/services/eventStream.js';

// ─── Test App Setup ─────────────────────────────────────────────────────────

function createTestApp(webhookSecret?: string) {
  if (webhookSecret) {
    process.env.SPOKESTACK_WEBHOOK_SECRET = webhookSecret;
  } else {
    delete process.env.SPOKESTACK_WEBHOOK_SECRET;
  }

  const app = express();
  app.use(express.json());
  app.use('/api/webhooks/spokestack-events', createSpokeStackEventsRouter());
  return app;
}

function signPayload(body: object, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

// ─── Test 1 (Step 6): Client Lifecycle ──────────────────────────────────────

describe('Test 1: Client Lifecycle — Client.created → VBX', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(() => {
    delete process.env.SPOKESTACK_WEBHOOK_SECRET;
  });

  it('resolves Client.created to client-created-notification recipe', async () => {
    const payload = {
      entityType: 'Client',
      entityId: 'client_abc123',
      action: 'created',
      organizationId: 'org_456',
      userId: 'user_789',
      metadata: {},
      timestamp: '2026-04-01T10:00:00.000Z',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('client-created-notification');
    expect(res.body.entityType).toBe('Client');
    expect(res.body.action).toBe('created');
    expect(res.body.entityId).toBe('client_abc123');
  });

  it('publishes Client.created to SSE event stream', async () => {
    const sseCallback = vi.fn();
    const unsub = eventStream.subscribe('org_456', sseCallback);

    const payload = {
      entityType: 'Client',
      entityId: 'client_abc123',
      action: 'created',
      organizationId: 'org_456',
      timestamp: '2026-04-01T10:00:00.000Z',
    };

    await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(sseCallback).toHaveBeenCalledOnce();
    const event = sseCallback.mock.calls[0][0];
    expect(event.orgId).toBe('org_456');
    expect(event.action).toBe('entity.created');
    expect(event.entityType).toBe('CLIENT');
    expect(event.entityId).toBe('client_abc123');
    expect(event.channel).toBe('platform');

    unsub();
  });

  it('skips recipe for Client.updated (no matching recipe)', async () => {
    const payload = {
      entityType: 'Client',
      entityId: 'client_abc123',
      action: 'updated',
      organizationId: 'org_456',
      metadata: { changedFields: ['industry', 'accountManagerId'] },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toBe('No matching recipe');
  });
});

// ─── Test 4 (Step 5): Sync Worker — Integration.sync_completed ─────────────

describe('Test 4: Sync Worker — Integration.sync_completed → VBX', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('routes Integration.sync_completed to integration-sync-notification recipe', async () => {
    const payload = {
      entityType: 'Integration',
      entityId: 'integ_asana_001',
      action: 'sync_completed',
      organizationId: 'org_789',
      metadata: {
        provider: 'asana',
        providerLabel: 'Asana',
        syncResult: {
          created: 12,
          updated: 5,
          skipped: 83,
          errors: [],
        },
      },
      timestamp: '2026-04-01T09:15:00.000Z',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('integration-sync-notification');
    expect(res.body.entityType).toBe('Integration');
    expect(res.body.action).toBe('sync_completed');
  });

  it('publishes sync event to SSE with metadata', async () => {
    const sseCallback = vi.fn();
    const unsub = eventStream.subscribe('org_789', sseCallback);

    const payload = {
      entityType: 'Integration',
      entityId: 'integ_asana_001',
      action: 'sync_completed',
      organizationId: 'org_789',
      metadata: {
        provider: 'asana',
        syncResult: { created: 12, updated: 5, skipped: 83, errors: [] },
      },
    };

    await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    const event = sseCallback.mock.calls[0][0];
    expect(event.metadata.provider).toBe('asana');
    expect(event.metadata.syncResult.created).toBe(12);

    unsub();
  });
});

// ─── Test 5 (Step 2): Order Created ─────────────────────────────────────────

describe('Test 5: Order Created → VBX', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('routes Order.created to order-created-notification recipe', async () => {
    const payload = {
      entityType: 'Order',
      entityId: 'order_q2_001',
      action: 'created',
      organizationId: 'org_456',
      userId: 'user_789',
      metadata: {
        clientId: 'client_abc123',
        total: 5000,
        itemCount: 1,
      },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('order-created-notification');
    expect(res.body.entityId).toBe('order_q2_001');
  });
});

// ─── Test 6 (Step 5): Project Completion Chain ──────────────────────────────

describe('Test 6: Project Completion — status_changed → COMPLETED → VBX', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('routes Project.status_changed (COMPLETED) to project-completed-notification', async () => {
    const payload = {
      entityType: 'Project',
      entityId: 'proj_q2_campaign',
      action: 'status_changed',
      organizationId: 'org_456',
      metadata: {
        fromStatus: 'ACTIVE',
        toStatus: 'COMPLETED',
      },
      timestamp: '2026-04-01T16:30:00.000Z',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('project-completed-notification');
    expect(res.body.entityType).toBe('Project');
    expect(res.body.action).toBe('status_changed');
  });

  it('publishes Project completion to SSE with status transition metadata', async () => {
    const sseCallback = vi.fn();
    const unsub = eventStream.subscribe('org_456', sseCallback);

    const payload = {
      entityType: 'Project',
      entityId: 'proj_q2_campaign',
      action: 'status_changed',
      organizationId: 'org_456',
      metadata: { fromStatus: 'ACTIVE', toStatus: 'COMPLETED' },
    };

    await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    const event = sseCallback.mock.calls[0][0];
    expect(event.orgId).toBe('org_456');
    expect(event.action).toBe('entity.status_changed');
    expect(event.entityType).toBe('PROJECT');
    expect(event.metadata.fromStatus).toBe('ACTIVE');
    expect(event.metadata.toStatus).toBe('COMPLETED');

    unsub();
  });

  it('does NOT route Project status_changed to non-COMPLETED status', async () => {
    const payload = {
      entityType: 'Project',
      entityId: 'proj_other',
      action: 'status_changed',
      organizationId: 'org_456',
      metadata: { fromStatus: 'DRAFT', toStatus: 'ACTIVE' },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.skipped).toBe(true);
  });
});

// ─── Test 12: Brief Assignment Notification ─────────────────────────────────

describe('Test 12: Brief Assignment — Brief.updated (assigneeId) → VBX', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('routes Brief.updated with assigneeId change to brief-assigned-notification', async () => {
    const payload = {
      entityType: 'Brief',
      entityId: 'brief_social_media',
      action: 'updated',
      organizationId: 'org_456',
      userId: 'user_admin',
      metadata: {
        changedFields: ['assigneeId'],
      },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('brief-assigned-notification');
    expect(res.body.entityId).toBe('brief_social_media');
  });

  it('does NOT route Brief.updated when assigneeId is not in changedFields', async () => {
    const payload = {
      entityType: 'Brief',
      entityId: 'brief_other',
      action: 'updated',
      organizationId: 'org_456',
      metadata: {
        changedFields: ['title', 'description', 'status'],
      },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.skipped).toBe(true);
  });

  it('routes Brief.updated with assigneeId among multiple changed fields', async () => {
    const payload = {
      entityType: 'Brief',
      entityId: 'brief_multi',
      action: 'updated',
      organizationId: 'org_456',
      metadata: {
        changedFields: ['title', 'assigneeId', 'priority'],
      },
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.recipe).toBe('brief-assigned-notification');
  });
});

// ─── Webhook Signature Verification ─────────────────────────────────────────

describe('Webhook Signature Verification', () => {
  const SECRET = 'test-webhook-secret-xyz';

  afterEach(() => {
    delete process.env.SPOKESTACK_WEBHOOK_SECRET;
  });

  it('accepts valid signature', async () => {
    const app = createTestApp(SECRET);
    const payload = {
      entityType: 'Client',
      entityId: 'client_1',
      action: 'created',
      organizationId: 'org_1',
    };

    const signature = signPayload(payload, SECRET);

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .set('x-spokestack-signature', signature)
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipe).toBe('client-created-notification');
  });

  it('rejects missing signature when secret is configured', async () => {
    const app = createTestApp(SECRET);
    const payload = {
      entityType: 'Client',
      entityId: 'client_1',
      action: 'created',
      organizationId: 'org_1',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(401);

    expect(res.body.error).toBe('Missing webhook signature');
  });

  it('rejects invalid signature', async () => {
    const app = createTestApp(SECRET);
    const payload = {
      entityType: 'Client',
      entityId: 'client_1',
      action: 'created',
      organizationId: 'org_1',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .set('x-spokestack-signature', 'bad-signature')
      .send(payload)
      .expect(401);

    expect(res.body.error).toBe('Invalid webhook signature');
  });

  it('allows requests when no secret is configured', async () => {
    const app = createTestApp(); // no secret
    const payload = {
      entityType: 'Client',
      entityId: 'client_1',
      action: 'created',
      organizationId: 'org_1',
    };

    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });
});

// ─── Payload Validation ─────────────────────────────────────────────────────

describe('Payload Validation', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it('rejects payload missing entityType', async () => {
    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send({ action: 'created', organizationId: 'org_1' })
      .expect(400);

    expect(res.body.error).toBe('Missing entityType or action');
  });

  it('rejects payload missing action', async () => {
    const res = await request(app)
      .post('/api/webhooks/spokestack-events')
      .send({ entityType: 'Client', organizationId: 'org_1' })
      .expect(400);

    expect(res.body.error).toBe('Missing entityType or action');
  });

  it('does not publish SSE when organizationId is missing', async () => {
    const sseCallback = vi.fn();
    const unsub = eventStream.subscribe('undefined', sseCallback);

    await request(app)
      .post('/api/webhooks/spokestack-events')
      .send({ entityType: 'Client', entityId: 'x', action: 'created' })
      .expect(200);

    expect(sseCallback).not.toHaveBeenCalled();
    unsub();
  });
});
