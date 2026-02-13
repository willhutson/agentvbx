import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from '../src/registry/registry.js';
import type { Provider } from '../src/registry/registry.js';

const mockProviders: Provider[] = [
  {
    id: 'claude-max',
    name: 'Claude Max',
    company: 'Anthropic',
    url: 'https://claude.ai',
    category: 'think',
    subcategory: 'reasoning',
    integration_method: 'browser',
    capabilities: ['reasoning', 'coding', 'writing', 'artifacts'],
    tiers: [{ name: 'Free', limits: 'Limited' }, { name: 'Max', limits: '20x' }],
    priority: 1,
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    company: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    category: 'think',
    integration_method: 'browser',
    capabilities: ['reasoning', 'coding', 'chain_of_thought'],
    tiers: [{ name: 'Free', limits: 'Unlimited' }],
    priority: 3,
    enabled: true,
  },
  {
    id: 'kling',
    name: 'Kling',
    company: 'Kuaishou',
    url: 'https://kling.ai',
    category: 'create',
    subcategory: 'video_generation',
    integration_method: 'browser',
    capabilities: ['text_to_video', 'image_to_video', 'multi_shot_storyboard'],
    tiers: [{ name: 'Free', limits: '66/day' }],
    priority: 1,
    enabled: true,
  },
  {
    id: 'exa',
    name: 'Exa',
    company: 'Exa',
    url: 'https://exa.ai',
    category: 'search',
    integration_method: 'api',
    capabilities: ['semantic_search', 'content_discovery'],
    tiers: [{ name: 'Free', limits: '1000/month' }],
    priority: 2,
    enabled: true,
  },
  {
    id: 'disabled-provider',
    name: 'Disabled',
    company: 'Test',
    url: 'https://test.com',
    category: 'think',
    integration_method: 'api',
    capabilities: ['test'],
    tiers: [],
    priority: 99,
    enabled: false,
  },
];

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
    for (const p of mockProviders) {
      registry.register(p);
    }
  });

  it('should register and retrieve providers', () => {
    const claude = registry.get('claude-max');
    expect(claude).toBeDefined();
    expect(claude?.name).toBe('Claude Max');
    expect(claude?.category).toBe('think');
  });

  it('should filter by category (excluding disabled)', () => {
    const thinkProviders = registry.byCategory('think');
    expect(thinkProviders).toHaveLength(2); // claude + deepseek (disabled excluded)
    expect(thinkProviders[0].id).toBe('claude-max'); // sorted by priority
  });

  it('should filter by capability', () => {
    const coders = registry.byCapability('coding');
    expect(coders).toHaveLength(2); // claude + deepseek
  });

  it('should filter by integration method', () => {
    const apiProviders = registry.byIntegrationMethod('api');
    expect(apiProviders).toHaveLength(1); // exa (disabled excluded)
    expect(apiProviders[0].id).toBe('exa');
  });

  it('should search by text query', () => {
    const results = registry.search('video');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('kling');
  });

  it('should search by company name', () => {
    const results = registry.search('anthropic');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('claude-max');
  });

  it('should return all providers sorted by priority', () => {
    const all = registry.listAll();
    expect(all).toHaveLength(5); // includes disabled
    expect(all[0].priority).toBeLessThanOrEqual(all[1].priority);
  });

  it('should track provider health', () => {
    registry.updateHealth({
      id: 'claude-max',
      available: false,
      last_checked: new Date().toISOString(),
      error: 'Rate limited',
    });

    expect(registry.isAvailable('claude-max')).toBe(false);
    expect(registry.isAvailable('deepseek')).toBe(true); // No health data = available
  });

  it('should return category counts', () => {
    const counts = registry.getCategoryCounts();
    expect(counts.think).toBe(3); // claude + deepseek + disabled
    expect(counts.create).toBe(1);
    expect(counts.search).toBe(1);
  });
});
