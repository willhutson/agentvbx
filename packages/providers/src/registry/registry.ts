/**
 * Provider registry — maintains the catalog of all AI tools and services.
 *
 * Providers are organized by the tool taxonomy:
 * Think, Search, Build, Create, Connect, Work, Talk
 *
 * Each provider has capabilities, tiers, integration method, and availability status.
 * The registry is populated from YAML configs and can be extended at runtime
 * (e.g., when providers submit through the inbound pipeline).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import YAML from 'yaml';
import { createLogger } from '../logger.js';

const logger = createLogger('provider-registry');

export type ToolCategory = 'think' | 'search' | 'build' | 'create' | 'connect' | 'work' | 'talk';
export type IntegrationMethod = 'browser' | 'api' | 'sdk' | 'local';

export interface ProviderTier {
  name: string;
  limits: string;
  price?: string;
}

export interface ProviderAffiliate {
  program_url?: string;
  commission_type?: 'one-time' | 'recurring';
  has_existing_program: boolean;
}

export interface Provider {
  id: string;
  name: string;
  company: string;
  url: string;
  category: ToolCategory;
  subcategory?: string;
  integration_method: IntegrationMethod;
  capabilities: string[];
  supported_languages?: string[];
  tiers: ProviderTier[];
  priority: number;
  enabled: boolean;
  affiliate?: ProviderAffiliate;
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  id: string;
  available: boolean;
  latency_ms?: number;
  last_checked: string;
  error?: string;
}

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private health: Map<string, ProviderHealth> = new Map();

  /**
   * Load providers from a YAML directory.
   */
  loadFromDirectory(dirPath: string): number {
    if (!existsSync(dirPath)) {
      logger.warn({ path: dirPath }, 'Provider directory not found');
      return 0;
    }

    let count = 0;
    const files = readdirSync(dirPath);

    for (const file of files) {
      const ext = extname(file);
      if (ext !== '.yaml' && ext !== '.yml') continue;

      try {
        const content = readFileSync(join(dirPath, file), 'utf-8');
        const provider = YAML.parse(content) as Provider;

        if (!provider.id) {
          provider.id = basename(file, ext);
        }

        this.register(provider);
        count++;
      } catch (err) {
        logger.error({ err, file }, 'Failed to load provider config');
      }
    }

    logger.info({ count, dir: dirPath }, 'Providers loaded from directory');
    return count;
  }

  /**
   * Register a single provider.
   */
  register(provider: Provider): void {
    this.providers.set(provider.id, provider);
    logger.debug({ id: provider.id, name: provider.name, category: provider.category }, 'Provider registered');
  }

  /**
   * Get a provider by ID.
   */
  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /**
   * Find providers by category.
   */
  byCategory(category: ToolCategory): Provider[] {
    return Array.from(this.providers.values())
      .filter((p) => p.category === category && p.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find providers by capability.
   */
  byCapability(capability: string): Provider[] {
    return Array.from(this.providers.values())
      .filter((p) => p.enabled && p.capabilities.includes(capability))
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find providers by integration method.
   */
  byIntegrationMethod(method: IntegrationMethod): Provider[] {
    return Array.from(this.providers.values())
      .filter((p) => p.enabled && p.integration_method === method)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Search providers by text query (matches name, capabilities, category).
   */
  search(query: string): Provider[] {
    const q = query.toLowerCase();
    return Array.from(this.providers.values())
      .filter((p) => {
        if (!p.enabled) return false;
        return (
          p.name.toLowerCase().includes(q) ||
          p.company.toLowerCase().includes(q) ||
          p.category.includes(q) ||
          (p.subcategory?.toLowerCase().includes(q) ?? false) ||
          p.capabilities.some((c) => c.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Update provider health status.
   */
  updateHealth(health: ProviderHealth): void {
    this.health.set(health.id, health);
  }

  /**
   * Get provider health.
   */
  getHealth(id: string): ProviderHealth | undefined {
    return this.health.get(id);
  }

  /**
   * Check if a provider is currently available.
   */
  isAvailable(id: string): boolean {
    const h = this.health.get(id);
    return !h || h.available; // Optimistic — no data means assume available
  }

  /**
   * Get all registered provider IDs.
   */
  listAll(): Provider[] {
    return Array.from(this.providers.values()).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get count of providers per category.
   */
  getCategoryCounts(): Record<ToolCategory, number> {
    const counts: Record<string, number> = {};
    for (const p of this.providers.values()) {
      counts[p.category] = (counts[p.category] ?? 0) + 1;
    }
    return counts as Record<ToolCategory, number>;
  }
}
