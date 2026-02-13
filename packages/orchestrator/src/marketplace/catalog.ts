/**
 * Recipe marketplace catalog.
 *
 * Manages the shared recipe marketplace where users can publish, discover,
 * install, rate, and fork recipes. Recipes are versioned and categorized.
 *
 * Storage: local YAML index + filesystem. In production, backed by a database.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import type { Recipe, RecipeMarketplace } from '../types.js';

const logger = createLogger('marketplace');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MarketplaceEntry {
  recipe: Recipe;
  marketplace: RecipeMarketplace;
  published_at: string;
  updated_at: string;
  installed_by: string[]; // tenant IDs
}

export interface PublishRequest {
  recipe: Recipe;
  creator: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  pricing?: {
    type: 'free' | 'one_time' | 'subscription';
    price?: number;
    currency?: string;
  };
}

export interface MarketplaceStats {
  total_recipes: number;
  total_installs: number;
  categories: Record<string, number>;
  top_recipes: Array<{ id: string; title: string; installs: number }>;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export class MarketplaceCatalog {
  private entries: Map<string, MarketplaceEntry> = new Map();

  /**
   * Publish a recipe to the marketplace.
   */
  publish(request: PublishRequest): MarketplaceEntry {
    const id = uuid();
    const now = new Date().toISOString();

    const marketplace: RecipeMarketplace = {
      id,
      creator: request.creator,
      title: request.title,
      description: request.description,
      category: request.category,
      tags: request.tags,
      version: '1.0.0',
      required_tools: this.extractRequiredTools(request.recipe),
      pricing: request.pricing ?? { type: 'free' },
      stats: { deployments: 0, avg_rating: 0, reviews: 0 },
    };

    const entry: MarketplaceEntry = {
      recipe: { ...request.recipe, marketplace },
      marketplace,
      published_at: now,
      updated_at: now,
      installed_by: [],
    };

    this.entries.set(id, entry);
    logger.info({ id, title: request.title, creator: request.creator }, 'Recipe published');
    return entry;
  }

  /**
   * Update an existing marketplace recipe (new version).
   */
  update(id: string, updates: Partial<PublishRequest>): MarketplaceEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    if (updates.recipe) entry.recipe = { ...entry.recipe, ...updates.recipe };
    if (updates.title) entry.marketplace.title = updates.title;
    if (updates.description) entry.marketplace.description = updates.description;
    if (updates.category) entry.marketplace.category = updates.category;
    if (updates.tags) entry.marketplace.tags = updates.tags;

    // Bump version
    const parts = entry.marketplace.version.split('.').map(Number);
    parts[2]++;
    entry.marketplace.version = parts.join('.');
    entry.updated_at = new Date().toISOString();

    logger.info({ id, version: entry.marketplace.version }, 'Recipe updated');
    return entry;
  }

  /**
   * Install a recipe for a tenant.
   */
  install(recipeId: string, tenantId: string): Recipe | null {
    const entry = this.entries.get(recipeId);
    if (!entry) return null;

    if (!entry.installed_by.includes(tenantId)) {
      entry.installed_by.push(tenantId);
      if (entry.marketplace.stats) {
        entry.marketplace.stats.deployments++;
      }
    }

    logger.info({ recipeId, tenantId }, 'Recipe installed');
    return entry.recipe;
  }

  /**
   * Fork a recipe (create a copy for modification).
   */
  fork(recipeId: string, newCreator: string): MarketplaceEntry | null {
    const original = this.entries.get(recipeId);
    if (!original) return null;

    return this.publish({
      recipe: { ...original.recipe, name: `${original.recipe.name}-fork` },
      creator: newCreator,
      title: `${original.marketplace.title} (Fork)`,
      description: original.marketplace.description,
      category: original.marketplace.category,
      tags: [...original.marketplace.tags, 'fork'],
      pricing: { type: 'free' },
    });
  }

  /**
   * Rate a recipe.
   */
  rate(recipeId: string, rating: number): boolean {
    const entry = this.entries.get(recipeId);
    if (!entry || rating < 1 || rating > 5) return false;

    const stats = entry.marketplace.stats!;
    const totalRating = stats.avg_rating * stats.reviews + rating;
    stats.reviews++;
    stats.avg_rating = Math.round((totalRating / stats.reviews) * 10) / 10;
    return true;
  }

  /**
   * Search and filter recipes.
   */
  search(category?: string, sortBy?: string, query?: string): MarketplaceEntry[] {
    let results = Array.from(this.entries.values());

    if (category) {
      results = results.filter((e) => e.marketplace.category === category);
    }

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (e) =>
          e.marketplace.title.toLowerCase().includes(q) ||
          e.marketplace.description.toLowerCase().includes(q) ||
          e.marketplace.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    switch (sortBy) {
      case 'popular':
        results.sort((a, b) => (b.marketplace.stats?.deployments ?? 0) - (a.marketplace.stats?.deployments ?? 0));
        break;
      case 'rating':
        results.sort((a, b) => (b.marketplace.stats?.avg_rating ?? 0) - (a.marketplace.stats?.avg_rating ?? 0));
        break;
      case 'newest':
        results.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
        break;
      default:
        results.sort((a, b) => (b.marketplace.stats?.deployments ?? 0) - (a.marketplace.stats?.deployments ?? 0));
    }

    return results;
  }

  /**
   * Get a single entry.
   */
  get(id: string): MarketplaceEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Get marketplace stats.
   */
  getStats(): MarketplaceStats {
    const entries = Array.from(this.entries.values());
    const categories: Record<string, number> = {};
    let totalInstalls = 0;

    for (const entry of entries) {
      categories[entry.marketplace.category] = (categories[entry.marketplace.category] ?? 0) + 1;
      totalInstalls += entry.marketplace.stats?.deployments ?? 0;
    }

    const top = entries
      .sort((a, b) => (b.marketplace.stats?.deployments ?? 0) - (a.marketplace.stats?.deployments ?? 0))
      .slice(0, 10)
      .map((e) => ({
        id: e.marketplace.id,
        title: e.marketplace.title,
        installs: e.marketplace.stats?.deployments ?? 0,
      }));

    return {
      total_recipes: entries.length,
      total_installs: totalInstalls,
      categories,
      top_recipes: top,
    };
  }

  private extractRequiredTools(recipe: Recipe): string[] {
    const tools = new Set<string>();
    for (const step of recipe.steps) {
      if (step.agent) tools.add(step.agent);
      if (step.integration) tools.add(step.integration);
      if (step.type) tools.add(step.type);
    }
    return Array.from(tools);
  }
}
