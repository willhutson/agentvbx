/**
 * Tests for the SSE event stream service.
 */

import { describe, it, expect, vi } from 'vitest';
import { eventStream, type AgentEvent } from '../src/services/eventStream.js';

function makeEvent(orgId: string, overrides?: Partial<AgentEvent>): AgentEvent {
  return {
    orgId,
    action: 'message.received',
    entityType: 'MESSAGE',
    channel: 'whatsapp',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('EventStreamService', () => {
  it('delivers events to subscribers for the correct org', () => {
    const callback = vi.fn();
    const unsub = eventStream.subscribe('org-sse-1', callback);

    const event = makeEvent('org-sse-1');
    eventStream.publish(event);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(event);

    unsub();
  });

  it('does not deliver events to subscribers of a different org', () => {
    const callback = vi.fn();
    const unsub = eventStream.subscribe('org-sse-2', callback);

    eventStream.publish(makeEvent('org-sse-other'));

    expect(callback).not.toHaveBeenCalled();

    unsub();
  });

  it('supports multiple subscribers for the same org', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = eventStream.subscribe('org-sse-3', cb1);
    const unsub2 = eventStream.subscribe('org-sse-3', cb2);

    eventStream.publish(makeEvent('org-sse-3'));

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it('unsubscribe stops delivery', () => {
    const callback = vi.fn();
    const unsub = eventStream.subscribe('org-sse-4', callback);

    unsub();

    eventStream.publish(makeEvent('org-sse-4'));

    expect(callback).not.toHaveBeenCalled();
  });

  it('listenerCount reflects active subscribers', () => {
    const orgId = 'org-sse-count';
    expect(eventStream.listenerCount(orgId)).toBe(0);

    const unsub1 = eventStream.subscribe(orgId, () => {});
    expect(eventStream.listenerCount(orgId)).toBe(1);

    const unsub2 = eventStream.subscribe(orgId, () => {});
    expect(eventStream.listenerCount(orgId)).toBe(2);

    unsub1();
    expect(eventStream.listenerCount(orgId)).toBe(1);

    unsub2();
    expect(eventStream.listenerCount(orgId)).toBe(0);
  });

  it('publishes events with all required fields', () => {
    const callback = vi.fn();
    const unsub = eventStream.subscribe('org-sse-5', callback);

    const event = makeEvent('org-sse-5', {
      action: 'agent.responded',
      entityType: 'CALL',
      agentType: 'orchestrator',
      channel: 'voice',
      entityId: 'msg-123',
      metadata: { callId: 'call-abc' },
    });
    eventStream.publish(event);

    const received = callback.mock.calls[0][0] as AgentEvent;
    expect(received.orgId).toBe('org-sse-5');
    expect(received.action).toBe('agent.responded');
    expect(received.entityType).toBe('CALL');
    expect(received.agentType).toBe('orchestrator');
    expect(received.channel).toBe('voice');
    expect(received.entityId).toBe('msg-123');
    expect(received.metadata).toEqual({ callId: 'call-abc' });

    unsub();
  });

  it('handles publish with no subscribers gracefully', () => {
    // Should not throw
    expect(() => {
      eventStream.publish(makeEvent('org-no-listeners'));
    }).not.toThrow();
  });
});
