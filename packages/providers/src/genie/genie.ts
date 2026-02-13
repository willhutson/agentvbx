/**
 * Model Genie — the intelligent recommendation engine.
 *
 * The Genie understands the full AI tool landscape and recommends the right tools
 * based on user intent. It doesn't solve problems — it recommends tools, helps
 * purchase them (via affiliate), and walks users through building agents/recipes.
 *
 * Recommendation logic:
 * 1. Parse user intent into tool categories
 * 2. Filter by user's connected accounts (prefer tools they already have)
 * 3. Score remaining options by capability match, cost, and quality
 * 4. Apply promoted provider boost (transparent, never fabricates relevance)
 * 5. Return ranked recommendations with reasoning
 */

import { createLogger } from '../logger.js';
import type { Provider, ProviderRegistry, ToolCategory } from '../registry/index.js';

const logger = createLogger('model-genie');

export interface GenieRecommendation {
  provider: Provider;
  score: number;
  reasoning: string;
  is_promoted: boolean;
  user_has_account: boolean;
  affiliate_url?: string;
}

export interface GenieQuery {
  text: string;
  intent?: ToolCategory;
  user_tools: string[];  // IDs of tools the user already has connected
  prefer_free: boolean;
  language?: string;
}

// Intent keywords mapped to tool categories
const INTENT_MAP: Record<string, ToolCategory> = {
  // Think
  reason: 'think', write: 'think', analyze: 'think', summarize: 'think',
  explain: 'think', code: 'think', chat: 'think', brainstorm: 'think',

  // Search
  search: 'search', find: 'search', research: 'search', lookup: 'search',
  scrape: 'search', crawl: 'search', extract: 'search',

  // Build
  build: 'build', website: 'build', app: 'build', prototype: 'build',
  landing: 'build', deploy: 'build',

  // Create
  image: 'create', video: 'create', music: 'create', audio: 'create',
  generate: 'create', design: 'create', animate: 'create', voice: 'create',

  // Connect
  email: 'connect', calendar: 'connect', drive: 'connect', slack: 'connect',
  notion: 'connect', github: 'connect', spreadsheet: 'connect',

  // Work
  manage: 'work', project: 'work', task: 'work', automate: 'work',
  workflow: 'work', kanban: 'work',

  // Talk
  call: 'talk', phone: 'talk', sms: 'talk', whatsapp: 'talk',
  voiceover: 'talk', clone: 'talk', telephony: 'talk',
};

export class ModelGenie {
  private registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  /**
   * Get recommendations for a user query.
   */
  recommend(query: GenieQuery): GenieRecommendation[] {
    const intent = query.intent ?? this.detectIntent(query.text);
    if (!intent) {
      logger.info({ text: query.text }, 'Could not detect intent from query');
      return [];
    }

    logger.info({ text: query.text, intent }, 'Generating recommendations');

    // Get all providers in the detected category
    const candidates = this.registry.byCategory(intent);
    if (candidates.length === 0) {
      return [];
    }

    // Score each candidate
    const scored = candidates.map((provider) => {
      const score = this.scoreProvider(provider, query, intent);
      const userHasAccount = query.user_tools.includes(provider.id);

      return {
        provider,
        score: score.total,
        reasoning: score.reasoning,
        is_promoted: provider.metadata?.promoted === true,
        user_has_account: userHasAccount,
        affiliate_url: provider.affiliate?.program_url,
      } satisfies GenieRecommendation;
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Promoted providers get a visibility boost but only within the organic candidate set
    // (they were already included because they match the category)
    const result = this.applyPromotedBoost(scored);

    logger.info({
      intent,
      recommendations: result.map((r) => ({
        id: r.provider.id,
        score: r.score,
        promoted: r.is_promoted,
      })),
    }, 'Recommendations generated');

    return result;
  }

  /**
   * Detect tool category intent from user text.
   */
  detectIntent(text: string): ToolCategory | null {
    const words = text.toLowerCase().split(/\s+/);
    const scores: Record<string, number> = {};

    for (const word of words) {
      const category = INTENT_MAP[word];
      if (category) {
        scores[category] = (scores[category] ?? 0) + 1;
      }
    }

    const entries = Object.entries(scores);
    if (entries.length === 0) return null;

    entries.sort(([, a], [, b]) => b - a);
    return entries[0][0] as ToolCategory;
  }

  /**
   * Score a provider for a given query.
   */
  private scoreProvider(
    provider: Provider,
    query: GenieQuery,
    _intent: ToolCategory,
  ): { total: number; reasoning: string } {
    let total = 0;
    const reasons: string[] = [];

    // User already has this tool — strong preference
    if (query.user_tools.includes(provider.id)) {
      total += 0.4;
      reasons.push('already connected');
    }

    // Capability keyword matching
    const queryLower = query.text.toLowerCase();
    for (const cap of provider.capabilities) {
      if (queryLower.includes(cap.toLowerCase().replace(/_/g, ' '))) {
        total += 0.15;
        reasons.push(`capability: ${cap}`);
      }
    }

    // Free tier preference
    if (query.prefer_free) {
      const hasFree = provider.tiers.some(
        (t) => t.name.toLowerCase().includes('free') || t.price === '$0',
      );
      if (hasFree) {
        total += 0.15;
        reasons.push('has free tier');
      }
    }

    // Language support
    if (query.language && provider.supported_languages?.includes(query.language)) {
      total += 0.1;
      reasons.push(`supports ${query.language}`);
    }

    // Provider priority (lower = better)
    total += Math.max(0, 0.2 - provider.priority * 0.02);

    // Provider health / availability
    if (this.registry.isAvailable(provider.id)) {
      total += 0.1;
    } else {
      total -= 0.3;
      reasons.push('currently unavailable');
    }

    return {
      total: Math.min(total, 1.0),
      reasoning: reasons.join(', ') || 'general match',
    };
  }

  /**
   * Apply promoted provider boost — reorders within the organic set.
   * Promoted providers move up at most 2 positions.
   * This is ALWAYS transparent (is_promoted = true in the result).
   */
  private applyPromotedBoost(recommendations: GenieRecommendation[]): GenieRecommendation[] {
    const result = [...recommendations];

    for (let i = 0; i < result.length; i++) {
      if (result[i].is_promoted && i > 0) {
        // Move up at most 2 positions
        const newPos = Math.max(0, i - 2);
        const [item] = result.splice(i, 1);
        result.splice(newPos, 0, item);
      }
    }

    return result;
  }
}
