import { describe, it, expect, beforeEach } from 'vitest';
import { AnalyticsEngine } from '../src/analytics/engine.js';

describe('AnalyticsEngine', () => {
  let engine: AnalyticsEngine;

  beforeEach(() => {
    engine = new AnalyticsEngine();
  });

  it('tracks usage events', () => {
    engine.track({
      type: 'message',
      tenant_id: 't1',
      provider: 'anthropic',
      agent: 'writer',
      tokens_in: 100,
      tokens_out: 500,
      duration_ms: 1200,
      timestamp: new Date().toISOString(),
    });

    const overview = engine.getOverview();
    expect(overview.total_messages_today).toBe(1);
    expect(overview.total_tenants).toBe(1);
  });

  it('calculates costs from token counts', () => {
    engine.track({
      type: 'message',
      tenant_id: 't1',
      provider: 'anthropic',
      tokens_in: 1000,
      tokens_out: 1000,
      timestamp: new Date().toISOString(),
    });

    const costs = engine.getCostBreakdown();
    expect(costs.total_usd).toBeGreaterThan(0);
    expect(costs.by_provider.anthropic).toBeDefined();
    expect(costs.by_provider.anthropic.cost_usd).toBeGreaterThan(0);
  });

  it('returns tenant usage summary', () => {
    engine.track({
      type: 'message',
      tenant_id: 't1',
      provider: 'openai',
      tokens_in: 500,
      tokens_out: 2000,
      timestamp: new Date().toISOString(),
    });

    engine.track({
      type: 'recipe',
      tenant_id: 't1',
      timestamp: new Date().toISOString(),
    });

    engine.track({
      type: 'message',
      tenant_id: 't2',
      timestamp: new Date().toISOString(),
    });

    const usage = engine.getTenantUsage('t1');
    expect(usage.tenant_id).toBe('t1');
    expect(usage.messages.total).toBe(1);
    expect(usage.recipes.total).toBe(1);
    expect(usage.tokens.input).toBe(500);
    expect(usage.tokens.output).toBe(2000);
  });

  it('shows top providers and agents in overview', () => {
    for (let i = 0; i < 5; i++) {
      engine.track({
        type: 'message',
        tenant_id: 't1',
        provider: 'anthropic',
        agent: 'writer',
        tokens_in: 100,
        tokens_out: 200,
        timestamp: new Date().toISOString(),
      });
    }

    for (let i = 0; i < 3; i++) {
      engine.track({
        type: 'message',
        tenant_id: 't1',
        provider: 'openai',
        agent: 'coder',
        tokens_in: 200,
        tokens_out: 400,
        timestamp: new Date().toISOString(),
      });
    }

    const overview = engine.getOverview();
    expect(overview.top_providers[0].provider).toBe('anthropic');
    expect(overview.top_providers[0].usage).toBe(5);
    expect(overview.top_agents[0].agent).toBe('writer');
    expect(overview.top_agents[0].messages).toBe(5);
  });

  it('ollama costs are zero', () => {
    engine.track({
      type: 'message',
      tenant_id: 't1',
      provider: 'ollama',
      tokens_in: 10000,
      tokens_out: 50000,
      timestamp: new Date().toISOString(),
    });

    const costs = engine.getCostBreakdown();
    expect(costs.by_provider.ollama?.cost_usd).toBe(0);
  });
});
