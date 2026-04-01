/**
 * Tests for the event subscriber utility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerEventWebhook,
  registerAllVBXSubscriptions,
  VBX_EVENT_SUBSCRIPTIONS,
} from '../src/event-subscriber.js';

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerEventWebhook', () => {
  it('sends correct POST request to core API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub_123',
        entityType: 'Project',
        action: 'status_changed',
        handler: 'webhook:https://vbx.example.com/api/webhooks/spokestack-events',
        enabled: true,
      }),
    });

    const result = await registerEventWebhook(
      'https://core.example.com',
      'api-key-123',
      'org_456',
      'https://vbx.example.com/api/webhooks/spokestack-events',
      {
        entityType: 'Project',
        action: 'status_changed',
        conditions: { toStatus: 'COMPLETED' },
        description: 'VBX: Project completed',
      },
    );

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://core.example.com/api/v1/events/subscriptions');
    expect(options.method).toBe('POST');
    expect(options.headers['X-API-Key']).toBe('api-key-123');
    expect(options.headers['X-Org-Id']).toBe('org_456');

    const body = JSON.parse(options.body);
    expect(body.entityType).toBe('Project');
    expect(body.action).toBe('status_changed');
    expect(body.handler).toBe('webhook:https://vbx.example.com/api/webhooks/spokestack-events');
    expect(body.config.conditions.toStatus).toBe('COMPLETED');
    expect(body.enabled).toBe(true);

    expect(result.id).toBe('sub_123');
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    await expect(
      registerEventWebhook(
        'https://core.example.com',
        'key',
        'org',
        'https://vbx.example.com/hook',
        { entityType: 'X', action: 'y', description: 'test' },
      ),
    ).rejects.toThrow('Failed to register event webhook: 400 Bad Request');
  });
});

describe('registerAllVBXSubscriptions', () => {
  it('registers all 5 VBX event subscriptions', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          id: `sub_${callCount}`,
          entityType: VBX_EVENT_SUBSCRIPTIONS[callCount - 1]?.entityType,
          action: VBX_EVENT_SUBSCRIPTIONS[callCount - 1]?.action,
          handler: 'webhook:...',
          enabled: true,
        }),
      };
    });

    const results = await registerAllVBXSubscriptions(
      'https://core.example.com',
      'key',
      'org_789',
      'https://vbx.example.com',
    );

    expect(results).toHaveLength(5);
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Verify all webhook URLs point to the events endpoint
    for (const [, options] of mockFetch.mock.calls) {
      const body = JSON.parse(options.body);
      expect(body.handler).toBe('webhook:https://vbx.example.com/api/webhooks/spokestack-events');
    }
  });
});

describe('VBX_EVENT_SUBSCRIPTIONS', () => {
  it('contains 5 subscription configs', () => {
    expect(VBX_EVENT_SUBSCRIPTIONS).toHaveLength(5);
  });

  it('covers all expected entity types', () => {
    const types = VBX_EVENT_SUBSCRIPTIONS.map(s => s.entityType);
    expect(types).toContain('Project');
    expect(types).toContain('Brief');
    expect(types).toContain('Client');
    expect(types).toContain('Order');
    expect(types).toContain('Integration');
  });

  it('all configs have description', () => {
    for (const sub of VBX_EVENT_SUBSCRIPTIONS) {
      expect(sub.description).toBeTruthy();
      expect(sub.description.startsWith('VBX:')).toBe(true);
    }
  });
});
