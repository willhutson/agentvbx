/**
 * YAML configuration loader for agent blueprints, recipes, and tenant configs.
 * Watches the filesystem for changes and hot-reloads configs.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import YAML from 'yaml';
import { createLogger } from '../logger.js';
import type { AgentBlueprint, Recipe, TenantConfig, ProviderConfig } from '../types.js';

const logger = createLogger('config-loader');

export class ConfigLoader {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Load all agent blueprints from a directory.
   */
  loadAgents(dirPath?: string): AgentBlueprint[] {
    const dir = dirPath ?? join(this.basePath, 'agents');
    return this.loadYamlDir<AgentBlueprint>(dir, 'agent');
  }

  /**
   * Load all recipes from a directory.
   */
  loadRecipes(dirPath?: string): Recipe[] {
    const dir = dirPath ?? join(this.basePath, 'recipes');
    return this.loadYamlDir<Recipe>(dir, 'recipe');
  }

  /**
   * Load all provider configs from a directory.
   */
  loadProviders(dirPath?: string): ProviderConfig[] {
    const dir = dirPath ?? join(this.basePath, 'providers');
    return this.loadYamlDir<ProviderConfig>(dir, 'provider');
  }

  /**
   * Load a single tenant config.
   */
  loadTenantConfig(tenantId: string): TenantConfig | null {
    const configPath = join(this.basePath, 'tenants', tenantId, 'config.yaml');
    return this.loadYamlFile<TenantConfig>(configPath, `tenant:${tenantId}`);
  }

  /**
   * Load a single YAML file and parse it.
   */
  loadYamlFile<T>(filePath: string, label?: string): T | null {
    try {
      if (!existsSync(filePath)) {
        logger.warn({ path: filePath, label }, 'Config file not found');
        return null;
      }
      const content = readFileSync(filePath, 'utf-8');
      const parsed = YAML.parse(content) as T;
      logger.debug({ path: filePath, label }, 'Loaded config');
      return parsed;
    } catch (err) {
      logger.error({ err, path: filePath, label }, 'Failed to load config');
      return null;
    }
  }

  /**
   * Load all YAML files from a directory.
   */
  private loadYamlDir<T>(dirPath: string, type: string): T[] {
    if (!existsSync(dirPath)) {
      logger.info({ path: dirPath, type }, 'Directory not found, creating');
      mkdirSync(dirPath, { recursive: true });
      return [];
    }

    const results: T[] = [];
    const files = readdirSync(dirPath);

    for (const file of files) {
      const ext = extname(file);
      if (ext !== '.yaml' && ext !== '.yml') continue;

      const fullPath = join(dirPath, file);
      if (!statSync(fullPath).isFile()) continue;

      const parsed = this.loadYamlFile<T>(fullPath, `${type}:${basename(file, ext)}`);
      if (parsed) {
        results.push(parsed);
      }
    }

    logger.info({ count: results.length, type, dir: dirPath }, 'Loaded configs');
    return results;
  }

  /**
   * Ensure tenant directory structure exists.
   */
  ensureTenantDir(tenantId: string): string {
    const tenantDir = join(this.basePath, 'tenants', tenantId);
    const subdirs = [
      '', 'agents', 'recipes', 'artifacts', 'artifacts/files',
      'sessions', 'integrations', 'channels',
    ];

    for (const sub of subdirs) {
      const dir = join(tenantDir, sub);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    logger.info({ tenantId, path: tenantDir }, 'Tenant directory ensured');
    return tenantDir;
  }
}
