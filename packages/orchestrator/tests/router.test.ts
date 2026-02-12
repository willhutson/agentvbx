import { describe, it, expect, beforeEach } from 'vitest';
import { MessageRouter } from '../src/routing/router.js';
import type { AgentBlueprint, Message } from '../src/types.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    tenant_id: 'tenant-1',
    number_id: 'num-1',
    channel: 'whatsapp',
    direction: 'inbound',
    from: '+1234567890',
    to: '+0987654321',
    text: 'Hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const researcherBlueprint: AgentBlueprint = {
  name: 'Researcher',
  description: 'Research agent',
  provider_priority: ['claude-max', 'deepseek', 'ollama/qwen2.5'],
  tools: ['exa', 'firecrawl'],
  channels: ['whatsapp', 'app', 'voice'],
  routing_keywords: ['research', 'find', 'search', 'compare'],
  temperature: 0.7,
  system_prompt: 'You are a researcher.',
};

const writerBlueprint: AgentBlueprint = {
  name: 'Writer',
  description: 'Writing agent',
  provider_priority: ['claude-max', 'chatgpt-pro'],
  tools: [],
  channels: ['whatsapp', 'app'],
  routing_keywords: ['write', 'draft', 'compose', 'email'],
  temperature: 0.8,
  system_prompt: 'You are a writer.',
};

const schedulerBlueprint: AgentBlueprint = {
  name: 'Scheduler',
  description: 'Scheduling agent',
  provider_priority: ['ollama/qwen2.5', 'chatgpt-pro'],
  tools: ['gcal'],
  channels: ['whatsapp', 'voice', 'sms'],
  routing_keywords: ['schedule', 'meeting', 'calendar', 'call'],
  temperature: 0.4,
  voice_settings: { voice: 'Telnyx.NaturalHD.Estelle', style: 'warm' },
  system_prompt: 'You are a scheduler.',
};

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
    router.registerAgent(researcherBlueprint);
    router.registerAgent(writerBlueprint);
    router.registerAgent(schedulerBlueprint);
  });

  it('should register agents and list them', () => {
    const agents = router.getRegisteredAgents();
    expect(agents).toContain('researcher');
    expect(agents).toContain('writer');
    expect(agents).toContain('scheduler');
    expect(agents).toHaveLength(3);
  });

  it('should route by explicit agent name', () => {
    const msg = makeMessage({ agent: 'Writer', text: 'anything' });
    const decision = router.route(msg);
    expect(decision.agent).toBe('Writer');
    expect(decision.confidence).toBe(1.0);
    expect(decision.provider).toBe('claude-max');
  });

  it('should route by keyword matching', () => {
    const msg = makeMessage({ text: 'Can you research AI trends for me?' });
    const decision = router.route(msg);
    expect(decision.agent).toBe('Researcher');
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('should route writing requests to writer', () => {
    const msg = makeMessage({ text: 'Please write an email to the client' });
    const decision = router.route(msg);
    expect(decision.agent).toBe('Writer');
  });

  it('should route scheduling requests to scheduler', () => {
    const msg = makeMessage({ text: 'Schedule a meeting for Tuesday' });
    const decision = router.route(msg);
    expect(decision.agent).toBe('Scheduler');
  });

  it('should filter agents by channel support', () => {
    // SMS channel — only Scheduler supports SMS
    const msg = makeMessage({ channel: 'sms', text: 'schedule a call' });
    const decision = router.route(msg);
    expect(decision.agent).toBe('Scheduler');
  });

  it('should use fallback providers when primary is unavailable', () => {
    router.updateProviderStatus({
      id: 'claude-max',
      available: false,
      last_checked: new Date().toISOString(),
    });

    const msg = makeMessage({ agent: 'Researcher' });
    const decision = router.route(msg);
    expect(decision.provider).toBe('deepseek');
    expect(decision.fallback_providers).toContain('ollama/qwen2.5');
  });

  it('should return low confidence for default fallback routing', () => {
    const msg = makeMessage({ text: 'hello there' }); // No keywords match
    const decision = router.route(msg);
    // Should still route to some agent (default), but with low confidence
    expect(decision.confidence).toBeLessThanOrEqual(0.3);
  });

  it('should handle tool mention boosting', () => {
    const msg = makeMessage({ text: 'use exa to find companies' });
    const decision = router.route(msg);
    // Researcher has 'exa' in tools AND 'find' in keywords
    expect(decision.agent).toBe('Researcher');
    expect(decision.confidence).toBeGreaterThan(0.3);
  });

  it('should retrieve a specific agent blueprint', () => {
    const agent = router.getAgent('researcher');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('Researcher');
    expect(agent?.provider_priority).toHaveLength(3);
  });

  it('should return undefined for unknown agent', () => {
    const agent = router.getAgent('nonexistent');
    expect(agent).toBeUndefined();
  });
});
