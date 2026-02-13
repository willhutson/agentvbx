/**
 * Tenant manager — creates, loads, and manages tenant directories and configs.
 * Multi-tenant isolation is a directory boundary: each tenant gets their own folder.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import type { TenantConfig, TenantTranscription, ArtifactDestinations } from '../types.js';

const logger = createLogger('tenant-manager');

const DEFAULT_TRANSCRIPTION: TenantTranscription = {
  live_calls: {
    engine: 'telnyx',
    model: 'telnyx-native',
  },
  voice_notes: {
    engine: 'auto',
    fallback: 'local_whisper',
    privacy_mode: false,
  },
  local_whisper: {
    enabled: true,
    model: 'whisper-large-v3',
    max_audio_length: 300,
  },
};

const DEFAULT_ARTIFACT_DESTINATIONS: ArtifactDestinations = {
  defaults: {
    documents: 'google_drive',
    spreadsheets: 'google_drive',
    presentations: 'google_drive',
    images: 'google_drive',
    videos: 'google_drive',
    audio: 'google_drive',
    code: 'github',
    notes: 'notion',
  },
  notifications: {
    primary: 'whatsapp',
    include_thumbnail: true,
    include_preview_link: true,
  },
};

export class TenantManager {
  private tenants: Map<string, TenantConfig> = new Map();
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = join(basePath, 'tenants');
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  /**
   * Create a new tenant with default configuration.
   */
  create(name: string, tier: TenantConfig['tier'] = 'free'): TenantConfig {
    const id = uuid();
    const now = new Date().toISOString();

    const config: TenantConfig = {
      id,
      name,
      tier,
      numbers: [],
      transcription: DEFAULT_TRANSCRIPTION,
      artifact_destinations: DEFAULT_ARTIFACT_DESTINATIONS,
      integrations: [],
      created_at: now,
      updated_at: now,
    };

    // Create directory structure
    const tenantDir = join(this.basePath, id);
    const subdirs = [
      '', 'agents', 'recipes', 'artifacts', 'artifacts/files',
      'sessions', 'integrations', 'channels', 'numbers',
      'data-sources', 'tools', 'vector-store',
    ];

    for (const sub of subdirs) {
      mkdirSync(join(tenantDir, sub), { recursive: true });
    }

    // Write config
    writeFileSync(join(tenantDir, 'config.yaml'), YAML.stringify(config));

    // Write artifact destinations config
    writeFileSync(
      join(tenantDir, 'artifact-destinations.yaml'),
      YAML.stringify(config.artifact_destinations),
    );

    // Write transcription config
    writeFileSync(
      join(tenantDir, 'transcription.yaml'),
      YAML.stringify(config.transcription),
    );

    this.tenants.set(id, config);
    logger.info({ id, name, tier }, 'Tenant created');
    return config;
  }

  /**
   * Load a tenant config from disk.
   */
  load(tenantId: string): TenantConfig | null {
    const cached = this.tenants.get(tenantId);
    if (cached) return cached;

    const configPath = join(this.basePath, tenantId, 'config.yaml');
    if (!existsSync(configPath)) {
      logger.warn({ tenantId }, 'Tenant config not found');
      return null;
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const config = YAML.parse(content) as TenantConfig;
      this.tenants.set(tenantId, config);
      return config;
    } catch (err) {
      logger.error({ err, tenantId }, 'Failed to load tenant config');
      return null;
    }
  }

  /**
   * Update a tenant configuration and persist to disk.
   */
  update(tenantId: string, updates: Partial<TenantConfig>): TenantConfig | null {
    const config = this.load(tenantId);
    if (!config) return null;

    const updated = { ...config, ...updates, updated_at: new Date().toISOString() };
    const configPath = join(this.basePath, tenantId, 'config.yaml');
    writeFileSync(configPath, YAML.stringify(updated));
    this.tenants.set(tenantId, updated);

    logger.info({ tenantId }, 'Tenant config updated');
    return updated;
  }

  /**
   * Get the filesystem path for a tenant.
   */
  getTenantPath(tenantId: string): string {
    return join(this.basePath, tenantId);
  }

  /**
   * Get the artifacts directory for a tenant.
   */
  getArtifactsPath(tenantId: string): string {
    return join(this.basePath, tenantId, 'artifacts', 'files');
  }

  /**
   * Check if a tenant exists.
   */
  exists(tenantId: string): boolean {
    return existsSync(join(this.basePath, tenantId, 'config.yaml'));
  }

  /**
   * List all tenant IDs.
   */
  list(): string[] {
    if (!existsSync(this.basePath)) return [];
    const { readdirSync } = require('node:fs');
    return readdirSync(this.basePath, { withFileTypes: true })
      .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
      .map((d: { name: string }) => d.name)
      .filter((id: string) => existsSync(join(this.basePath, id, 'config.yaml')));
  }
}
