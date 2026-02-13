/**
 * Re-authentication flow manager.
 *
 * When a browser session's cookies expire or auth fails, this module
 * coordinates the re-auth process:
 *
 * 1. Detect auth failure (via health monitor or task runner)
 * 2. Notify the user via their preferred channel (WhatsApp/app/desktop)
 * 3. If desktop: open the browser session in a visible window for manual login
 * 4. If remote: generate a secure, time-limited re-auth link
 * 5. Wait for auth completion
 * 6. Validate new session and resume pending tasks
 */

import { createLogger } from './logger.js';
import type { SessionManager, SessionConfig, BrowserSession } from './session-manager.js';

const logger = createLogger('reauth-flow');

// ─── Types ──────────────────────────────────────────────────────────────────

export type ReauthMethod = 'manual_browser' | 'reauth_link' | 'stored_credentials';

export type ReauthStatus = 'pending' | 'awaiting_user' | 'in_progress' | 'completed' | 'failed' | 'expired';

export interface ReauthRequest {
  id: string;
  session_id: string;
  tenant_id: string;
  provider_id: string;
  method: ReauthMethod;
  status: ReauthStatus;
  reauth_url?: string;
  created_at: string;
  expires_at: string;
  completed_at?: string;
  error?: string;
  notified_via?: string[];
}

export interface ReauthConfig {
  /** How long a re-auth request is valid (ms) */
  expiry_ms: number;
  /** Channels to notify user through */
  notification_channels: string[];
  /** Preferred re-auth method */
  default_method: ReauthMethod;
  /** Max concurrent re-auth requests per tenant */
  max_concurrent: number;
}

export type ReauthEventHandler = (event: {
  type: 'reauth:requested' | 'reauth:completed' | 'reauth:failed' | 'reauth:expired';
  request: ReauthRequest;
}) => void;

const DEFAULT_CONFIG: ReauthConfig = {
  expiry_ms: 600000,              // 10 minutes
  notification_channels: ['app'],
  default_method: 'manual_browser',
  max_concurrent: 3,
};

// ─── Re-auth Flow Manager ────────────────────────────────────────────────────

export class ReauthFlowManager {
  private config: ReauthConfig;
  private requests: Map<string, ReauthRequest> = new Map();
  private eventHandlers: ReauthEventHandler[] = [];
  private expiryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private sessionManager: SessionManager,
    config?: Partial<ReauthConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initiate a re-authentication flow for an expired session.
   */
  async requestReauth(
    tenantId: string,
    providerId: string,
    method?: ReauthMethod,
  ): Promise<ReauthRequest> {
    const sessionId = `${tenantId}:${providerId}`;

    // Check for existing pending request
    const existing = this.getActiveRequest(sessionId);
    if (existing) {
      logger.info({ sessionId }, 'Re-auth already in progress');
      return existing;
    }

    // Check concurrent limit
    const activeTenantRequests = Array.from(this.requests.values()).filter(
      (r) => r.tenant_id === tenantId && (r.status === 'pending' || r.status === 'awaiting_user'),
    );
    if (activeTenantRequests.length >= this.config.max_concurrent) {
      throw new Error(`Max concurrent re-auth requests (${this.config.max_concurrent}) reached for tenant`);
    }

    const now = Date.now();
    const requestId = `reauth_${now}_${Math.random().toString(36).slice(2, 8)}`;

    const request: ReauthRequest = {
      id: requestId,
      session_id: sessionId,
      tenant_id: tenantId,
      provider_id: providerId,
      method: method ?? this.config.default_method,
      status: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.config.expiry_ms).toISOString(),
      notified_via: [],
    };

    // Generate re-auth URL for link-based method
    if (request.method === 'reauth_link') {
      request.reauth_url = this.generateReauthUrl(requestId, tenantId, providerId);
    }

    this.requests.set(requestId, request);

    // Set expiry timer
    const timer = setTimeout(() => {
      this.expireRequest(requestId);
    }, this.config.expiry_ms);
    this.expiryTimers.set(requestId, timer);

    request.status = 'awaiting_user';

    logger.info({ requestId, sessionId, method: request.method }, 'Re-auth requested');

    this.emit({
      type: 'reauth:requested',
      request,
    });

    return request;
  }

  /**
   * Complete a re-authentication — called after user has logged in.
   */
  async completeReauth(
    requestId: string,
    sessionConfig?: SessionConfig,
  ): Promise<ReauthRequest> {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Re-auth request not found: ${requestId}`);
    }

    if (request.status === 'expired' || request.status === 'failed') {
      throw new Error(`Re-auth request is ${request.status}`);
    }

    request.status = 'in_progress';

    try {
      // If session config provided, create new session
      if (sessionConfig) {
        const session = await this.sessionManager.createSession(sessionConfig);
        if (session.status === 'expired' || !session.cookies_valid) {
          request.status = 'failed';
          request.error = 'Session still expired after re-auth attempt';
          this.emit({ type: 'reauth:failed', request });
          return request;
        }
      }

      // Verify the session is now valid
      const session = this.sessionManager.getSession(request.tenant_id, request.provider_id);
      if (!session || session.status === 'expired') {
        request.status = 'failed';
        request.error = 'Session validation failed after re-auth';
        this.emit({ type: 'reauth:failed', request });
        return request;
      }

      request.status = 'completed';
      request.completed_at = new Date().toISOString();

      // Clean up
      const timer = this.expiryTimers.get(requestId);
      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(requestId);
      }

      logger.info({ requestId, session_id: request.session_id }, 'Re-auth completed');
      this.emit({ type: 'reauth:completed', request });

      return request;
    } catch (err) {
      request.status = 'failed';
      request.error = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'reauth:failed', request });
      return request;
    }
  }

  /**
   * Get active re-auth request for a session.
   */
  getActiveRequest(sessionId: string): ReauthRequest | undefined {
    return Array.from(this.requests.values()).find(
      (r) =>
        r.session_id === sessionId &&
        (r.status === 'pending' || r.status === 'awaiting_user' || r.status === 'in_progress'),
    );
  }

  /**
   * Get all re-auth requests for a tenant.
   */
  getTenantRequests(tenantId: string): ReauthRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.tenant_id === tenantId);
  }

  /**
   * Register event handler.
   */
  onEvent(handler: ReauthEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Clean up completed/expired requests.
   */
  cleanup(): void {
    const cutoff = Date.now() - 3600000; // 1 hour
    for (const [id, request] of this.requests) {
      if (
        (request.status === 'completed' || request.status === 'expired' || request.status === 'failed') &&
        new Date(request.created_at).getTime() < cutoff
      ) {
        this.requests.delete(id);
        const timer = this.expiryTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.expiryTimers.delete(id);
        }
      }
    }
  }

  /**
   * Stop all timers.
   */
  destroy(): void {
    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private expireRequest(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.status === 'completed') return;

    request.status = 'expired';
    this.expiryTimers.delete(requestId);

    logger.info({ requestId }, 'Re-auth request expired');
    this.emit({ type: 'reauth:expired', request });
  }

  private generateReauthUrl(requestId: string, tenantId: string, providerId: string): string {
    // In production, this would generate a signed, time-limited URL
    // that opens the browser session in the desktop app or web UI
    const token = Buffer.from(`${requestId}:${tenantId}:${providerId}`).toString('base64url');
    return `/reauth/${token}`;
  }

  private emit(event: { type: string; request: ReauthRequest }): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event as Parameters<ReauthEventHandler>[0]);
      } catch (err) {
        logger.error({ err, event_type: event.type }, 'Re-auth event handler error');
      }
    }
  }
}
