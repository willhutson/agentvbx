/**
 * Session store — persists provider auth tokens and cookies to disk.
 *
 * Each user's AI provider subscription (ChatGPT Plus, Claude Pro, etc.) has
 * a web session backed by cookies and tokens. This store persists those
 * credentials so the desktop app can make internal API calls on behalf of
 * the user's consumer subscription — no developer API keys needed.
 *
 * Design:
 * - One session file per provider per tenant
 * - Encrypted at rest (AES-256-GCM, key derived from machine ID)
 * - Automatic expiry detection
 * - Event hooks for re-auth flow triggers
 */

import { createLogger } from '../logger.js';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const logger = createLogger('session-store');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionCredentials {
  provider_id: string;
  tenant_id: string;
  /** Cookie string or bearer token for the provider's internal API. */
  auth_token: string;
  /** Additional cookies needed for requests. */
  cookies?: Record<string, string>;
  /** Provider-specific session data (org IDs, conversation IDs, etc.). */
  provider_data?: Record<string, unknown>;
  /** When the session was captured. */
  created_at: string;
  /** When the session was last verified as valid. */
  last_verified_at: string;
  /** When the session is expected to expire (best guess). */
  expires_at?: string;
}

export type SessionEvent = 'session:stored' | 'session:loaded' | 'session:expired' | 'session:deleted';

export type SessionEventHandler = (event: SessionEvent, providerId: string, tenantId: string) => void;

export interface SessionStoreConfig {
  /** Directory to store session files. Defaults to ~/.agentvbx/sessions */
  storage_path: string;
  /** Encryption key (derived from machine ID or user passphrase). */
  encryption_key?: string;
}

// ─── Session Store ──────────────────────────────────────────────────────────

export class SessionStore {
  private config: SessionStoreConfig;
  private cache: Map<string, SessionCredentials> = new Map();
  private eventHandlers: SessionEventHandler[] = [];
  private encryptionKey: Buffer;

  constructor(config: SessionStoreConfig) {
    this.config = config;
    // Derive a 32-byte key from whatever key material we're given
    const keyMaterial = config.encryption_key ?? 'agentvbx-default-key';
    this.encryptionKey = createHash('sha256').update(keyMaterial).digest();
  }

  /**
   * Subscribe to session events (for triggering re-auth flows, UI updates, etc.).
   */
  onEvent(handler: SessionEventHandler): void {
    this.eventHandlers.push(handler);
  }

  private emit(event: SessionEvent, providerId: string, tenantId: string): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event, providerId, tenantId);
      } catch (err) {
        logger.error({ err, event }, 'Session event handler error');
      }
    }
  }

  /**
   * Store session credentials for a provider.
   */
  async store(credentials: SessionCredentials): Promise<void> {
    const key = this.sessionKey(credentials.provider_id, credentials.tenant_id);
    this.cache.set(key, credentials);

    try {
      await mkdir(this.config.storage_path, { recursive: true });
      const filePath = this.filePath(credentials.provider_id, credentials.tenant_id);
      const encrypted = this.encrypt(JSON.stringify(credentials));
      await writeFile(filePath, encrypted);
      logger.info({ provider: credentials.provider_id, tenant: credentials.tenant_id }, 'Session stored');
      this.emit('session:stored', credentials.provider_id, credentials.tenant_id);
    } catch (err) {
      logger.error({ err }, 'Failed to persist session to disk');
    }
  }

  /**
   * Load session credentials for a provider.
   * Returns from cache if available, otherwise reads from disk.
   */
  async load(providerId: string, tenantId: string): Promise<SessionCredentials | null> {
    const key = this.sessionKey(providerId, tenantId);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      if (this.isExpired(cached)) {
        this.emit('session:expired', providerId, tenantId);
        return null;
      }
      return cached;
    }

    // Read from disk
    try {
      const filePath = this.filePath(providerId, tenantId);
      const encrypted = await readFile(filePath, 'utf-8');
      const decrypted = this.decrypt(encrypted);
      const credentials = JSON.parse(decrypted) as SessionCredentials;

      if (this.isExpired(credentials)) {
        this.emit('session:expired', providerId, tenantId);
        return null;
      }

      this.cache.set(key, credentials);
      this.emit('session:loaded', providerId, tenantId);
      return credentials;
    } catch {
      return null;
    }
  }

  /**
   * Update the last_verified_at timestamp for a session.
   */
  async touch(providerId: string, tenantId: string): Promise<void> {
    const credentials = await this.load(providerId, tenantId);
    if (credentials) {
      credentials.last_verified_at = new Date().toISOString();
      await this.store(credentials);
    }
  }

  /**
   * Delete a session (user logged out or session revoked).
   */
  async delete(providerId: string, tenantId: string): Promise<void> {
    const key = this.sessionKey(providerId, tenantId);
    this.cache.delete(key);

    try {
      const filePath = this.filePath(providerId, tenantId);
      await unlink(filePath);
    } catch {
      // File may not exist
    }

    logger.info({ provider: providerId, tenant: tenantId }, 'Session deleted');
    this.emit('session:deleted', providerId, tenantId);
  }

  /**
   * List all stored sessions for a tenant.
   */
  listSessions(tenantId: string): SessionCredentials[] {
    return Array.from(this.cache.values()).filter((s) => s.tenant_id === tenantId);
  }

  /**
   * Check if a session exists and is not expired.
   */
  async hasValidSession(providerId: string, tenantId: string): Promise<boolean> {
    const credentials = await this.load(providerId, tenantId);
    return credentials !== null;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private sessionKey(providerId: string, tenantId: string): string {
    return `${tenantId}:${providerId}`;
  }

  private filePath(providerId: string, tenantId: string): string {
    // Sanitize for filesystem
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.config.storage_path, `${safe(tenantId)}_${safe(providerId)}.session`);
  }

  private isExpired(credentials: SessionCredentials): boolean {
    if (!credentials.expires_at) return false;
    return new Date(credentials.expires_at) < new Date();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    // Format: iv:tag:ciphertext
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
  }

  private decrypt(data: string): string {
    const [ivHex, tagHex, ciphertext] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
