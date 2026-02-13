import { describe, it, expect, beforeEach } from 'vitest';
import { MarketplaceCatalog } from '../src/marketplace/catalog.js';

describe('MarketplaceCatalog', () => {
  let catalog: MarketplaceCatalog;

  beforeEach(() => {
    catalog = new MarketplaceCatalog();
  });

  it('publishes a recipe', () => {
    const entry = catalog.publish({
      recipe: {
        name: 'test-recipe',
        description: 'A test recipe',
        steps: [
          { name: 'step1', type: 'agent', agent: 'writer', input: 'prompt', output: 'result' },
        ],
      },
      creator: 'test-user',
      title: 'Test Recipe',
      description: 'A test marketplace recipe',
      category: 'automation',
      tags: ['test', 'example'],
    });

    expect(entry.marketplace.id).toBeTruthy();
    expect(entry.marketplace.title).toBe('Test Recipe');
    expect(entry.marketplace.version).toBe('1.0.0');
    expect(entry.marketplace.required_tools).toContain('writer');
    expect(entry.marketplace.pricing.type).toBe('free');
  });

  it('installs a recipe for a tenant', () => {
    const entry = catalog.publish({
      recipe: { name: 'r1', description: '', steps: [{ name: 's1', input: '', output: '' }] },
      creator: 'me',
      title: 'R1',
      description: '',
      category: 'general',
      tags: [],
    });

    const recipe = catalog.install(entry.marketplace.id, 'tenant-1');
    expect(recipe).toBeTruthy();
    expect(recipe!.name).toBe('r1');

    const updated = catalog.get(entry.marketplace.id);
    expect(updated!.installed_by).toContain('tenant-1');
    expect(updated!.marketplace.stats!.deployments).toBe(1);
  });

  it('rates a recipe and updates average', () => {
    const entry = catalog.publish({
      recipe: { name: 'r', description: '', steps: [] },
      creator: 'c',
      title: 'R',
      description: '',
      category: 'g',
      tags: [],
    });

    catalog.rate(entry.marketplace.id, 5);
    catalog.rate(entry.marketplace.id, 3);

    const updated = catalog.get(entry.marketplace.id);
    expect(updated!.marketplace.stats!.reviews).toBe(2);
    expect(updated!.marketplace.stats!.avg_rating).toBe(4);
  });

  it('searches recipes by category and query', () => {
    catalog.publish({
      recipe: { name: 'a', description: '', steps: [] },
      creator: 'c',
      title: 'Marketing Automation',
      description: 'Automate campaigns',
      category: 'marketing',
      tags: ['ads'],
    });

    catalog.publish({
      recipe: { name: 'b', description: '', steps: [] },
      creator: 'c',
      title: 'Dev Pipeline',
      description: 'CI/CD helper',
      category: 'dev',
      tags: ['ci'],
    });

    const marketing = catalog.search('marketing');
    expect(marketing).toHaveLength(1);
    expect(marketing[0].marketplace.title).toBe('Marketing Automation');

    const ciResults = catalog.search(undefined, undefined, 'CI/CD');
    expect(ciResults).toHaveLength(1);
    expect(ciResults[0].marketplace.title).toBe('Dev Pipeline');
  });

  it('forks a recipe', () => {
    const original = catalog.publish({
      recipe: { name: 'orig', description: '', steps: [] },
      creator: 'alice',
      title: 'Original',
      description: 'Original recipe',
      category: 'general',
      tags: ['template'],
    });

    const fork = catalog.fork(original.marketplace.id, 'bob');
    expect(fork).toBeTruthy();
    expect(fork!.marketplace.creator).toBe('bob');
    expect(fork!.marketplace.tags).toContain('fork');
    expect(fork!.recipe.name).toBe('orig-fork');
  });

  it('returns stats', () => {
    catalog.publish({
      recipe: { name: 'a', description: '', steps: [] },
      creator: 'c',
      title: 'A',
      description: '',
      category: 'cat1',
      tags: [],
    });
    catalog.publish({
      recipe: { name: 'b', description: '', steps: [] },
      creator: 'c',
      title: 'B',
      description: '',
      category: 'cat2',
      tags: [],
    });

    const stats = catalog.getStats();
    expect(stats.total_recipes).toBe(2);
    expect(stats.categories.cat1).toBe(1);
    expect(stats.categories.cat2).toBe(1);
  });
});
