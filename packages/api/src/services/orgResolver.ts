/**
 * Org Resolver — resolves org slugs to full org config via spokestack-core.
 *
 * Calls GET ${SPOKESTACK_CORE_URL}/api/v1/organizations/by-slug/:slug
 * and caches results in-process with a configurable TTL (default 5 minutes).
 */

import { createLogger } from '../logger.js';

const logger = createLogger('org-resolver');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OrgConfig {
  orgId: string;
  channels: Record<string, boolean>;
  active: boolean;
}

interface CacheEntry {
  data: OrgConfig;
  expiresAt: number;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export class OrgResolver {
  private cache = new Map<string, CacheEntry>();
  private coreUrl: string;
  private ttlMs: number;

  constructor(coreUrl?: string, ttlSeconds?: number) {
    this.coreUrl = coreUrl ?? process.env.SPOKESTACK_CORE_URL ?? 'https://spokestack-core.vercel.app';
    this.ttlMs = (ttlSeconds ?? parseInt(process.env.ORG_RESOLVER_CACHE_TTL_SECONDS ?? '300', 10)) * 1000;
  }

  /**
   * Resolve an org slug to its config. Returns null if not found.
   */
  async resolveBySlug(slug: string): Promise<OrgConfig | null> {
    // Check cache first
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug({ slug }, 'Org resolved from cache');
      return cached.data;
    }

    // Cache miss — call spokestack-core
    try {
      const url = `${this.coreUrl}/api/v1/organizations/by-slug/${encodeURIComponent(slug)}`;
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 404) {
        logger.info({ slug }, 'Org not found');
        return null;
      }

      if (!res.ok) {
        logger.error({ slug, status: res.status }, 'Org lookup failed');
        return null;
      }

      const body = (await res.json()) as Record<string, unknown>;
      const orgConfig: OrgConfig = {
        orgId: String(body.orgId ?? body.id ?? ''),
        channels: (body.channels as Record<string, boolean>) ?? {},
        active: body.active !== false,
      };

      // Cache the result
      this.cache.set(slug, {
        data: orgConfig,
        expiresAt: Date.now() + this.ttlMs,
      });

      logger.info({ slug, orgId: orgConfig.orgId }, 'Org resolved from spokestack-core');
      return orgConfig;
    } catch (err) {
      logger.error({ err, slug }, 'Org resolver network error');
      return null;
    }
  }

  /**
   * Invalidate a cached entry (e.g., after config change).
   */
  invalidate(slug: string): void {
    this.cache.delete(slug);
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}
