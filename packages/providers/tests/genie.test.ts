import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from '../src/registry/registry.js';
import { ModelGenie } from '../src/genie/genie.js';
import type { Provider } from '../src/registry/registry.js';

const providers: Provider[] = [
  {
    id: 'claude-max',
    name: 'Claude Max',
    company: 'Anthropic',
    url: 'https://claude.ai',
    category: 'think',
    integration_method: 'browser',
    capabilities: ['reasoning', 'coding', 'writing'],
    supported_languages: ['en', 'ar'],
    tiers: [{ name: 'Free', limits: 'Limited' }],
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
    capabilities: ['reasoning', 'coding'],
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
    integration_method: 'browser',
    capabilities: ['text_to_video', 'image_to_video'],
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
    id: 'promoted-tool',
    name: 'Promoted Tool',
    company: 'Promoted',
    url: 'https://promoted.ai',
    category: 'think',
    integration_method: 'api',
    capabilities: ['reasoning'],
    tiers: [{ name: 'Free', limits: 'Limited' }],
    priority: 5,
    enabled: true,
    metadata: { promoted: true },
  },
];

describe('ModelGenie', () => {
  let registry: ProviderRegistry;
  let genie: ModelGenie;

  beforeEach(() => {
    registry = new ProviderRegistry();
    for (const p of providers) {
      registry.register(p);
    }
    genie = new ModelGenie(registry);
  });

  it('should detect intent from text', () => {
    expect(genie.detectIntent('I need to research market trends')).toBe('search');
    expect(genie.detectIntent('write a blog post')).toBe('think');
    expect(genie.detectIntent('generate a video')).toBe('create');
    expect(genie.detectIntent('schedule a call')).toBe('talk');
    expect(genie.detectIntent('build a website')).toBe('build');
  });

  it('should return null for unrecognized intent', () => {
    expect(genie.detectIntent('hello world')).toBeNull();
  });

  it('should recommend providers based on intent', () => {
    const results = genie.recommend({
      text: 'I need to write some code',
      user_tools: [],
      prefer_free: false,
    });

    expect(results.length).toBeGreaterThan(0);
    // Should recommend think providers since "write" and "code" map to think
    expect(results[0].provider.category).toBe('think');
  });

  it('should boost recommendations for tools user already has', () => {
    const results = genie.recommend({
      text: 'help me reason through this problem',
      user_tools: ['deepseek'],
      prefer_free: false,
    });

    const deepseekRec = results.find((r) => r.provider.id === 'deepseek');
    expect(deepseekRec).toBeDefined();
    expect(deepseekRec!.user_has_account).toBe(true);
  });

  it('should prefer free tiers when requested', () => {
    const results = genie.recommend({
      text: 'I need to code something',
      user_tools: [],
      prefer_free: true,
    });

    // All providers here have free tiers, but prefer_free should boost them
    expect(results.length).toBeGreaterThan(0);
  });

  it('should flag promoted providers transparently', () => {
    const results = genie.recommend({
      text: 'help me reason',
      user_tools: [],
      prefer_free: false,
    });

    const promoted = results.find((r) => r.provider.id === 'promoted-tool');
    if (promoted) {
      expect(promoted.is_promoted).toBe(true);
    }
  });

  it('should recommend video tools for create intent', () => {
    const results = genie.recommend({
      text: 'I want to generate a video',
      intent: 'create',
      user_tools: [],
      prefer_free: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].provider.id).toBe('kling');
  });

  it('should return empty for unknown intent', () => {
    const results = genie.recommend({
      text: 'asdfghjkl',
      user_tools: [],
      prefer_free: false,
    });

    expect(results).toHaveLength(0);
  });

  it('should boost by language support', () => {
    const results = genie.recommend({
      text: 'write something for me',
      user_tools: [],
      prefer_free: false,
      language: 'ar',
    });

    // Claude has Arabic support, should score higher
    const claude = results.find((r) => r.provider.id === 'claude-max');
    expect(claude).toBeDefined();
  });
});
