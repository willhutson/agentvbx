/**
 * Integration adapter interface.
 *
 * All platform integrations (Google Drive, Monday.com, Notion, GitHub, etc.)
 * implement this interface. Provides a consistent contract for reading from
 * and writing to external platforms.
 */

import { createLogger } from './logger.js';

const logger = createLogger('integration-adapter');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IntegrationCredentials {
  type: 'oauth2' | 'api_key' | 'webhook';
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  expires_at?: string;
}

export interface IntegrationFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes?: number;
  url?: string;
  parent_id?: string;
  created_at?: string;
  modified_at?: string;
  metadata?: Record<string, unknown>;
}

export interface IntegrationRecord {
  id: string;
  fields: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface UploadResult {
  id: string;
  url: string;
  name: string;
  web_view_url?: string;
  thumbnail_url?: string;
}

export interface IntegrationAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: string;

  /** Initialize the adapter with credentials. */
  initialize(credentials: IntegrationCredentials): Promise<void>;

  /** Check if the adapter is connected and credentials are valid. */
  isConnected(): Promise<boolean>;

  /** List items (files, records, pages) from the platform. */
  list(params?: Record<string, unknown>): Promise<IntegrationFile[] | IntegrationRecord[]>;

  /** Read a single item by ID. */
  read(id: string): Promise<IntegrationFile | IntegrationRecord | null>;

  /** Create/upload a new item. */
  create(data: {
    name: string;
    content?: Buffer | string;
    mime_type?: string;
    parent_id?: string;
    fields?: Record<string, unknown>;
  }): Promise<UploadResult | IntegrationRecord>;

  /** Update an existing item. */
  update(id: string, data: Record<string, unknown>): Promise<unknown>;

  /** Delete an item. */
  delete(id: string): Promise<void>;

  /** Disconnect and clean up. */
  disconnect(): Promise<void>;
}

// ─── Integration Manager ────────────────────────────────────────────────────

export class IntegrationManager {
  private adapters: Map<string, IntegrationAdapter> = new Map();

  register(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.id, adapter);
    logger.info({ id: adapter.id, platform: adapter.platform }, 'Integration adapter registered');
  }

  get(id: string): IntegrationAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  async disconnectAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch (err) {
        logger.error({ err, id }, 'Failed to disconnect adapter');
      }
    }
  }
}
