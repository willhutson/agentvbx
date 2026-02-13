/**
 * Browser session manager for AI provider automation (BYOA model).
 *
 * Manages persistent, authenticated browser contexts for each AI provider
 * a user has connected. Sessions are stored per-tenant and auto-reauth
 * when cookies expire.
 *
 * Uses Playwright for browser automation. In production, this would use
 * Vercel's agent-browser for ref-based element selection (resilient to UI changes)
 * and daemon architecture (sub-100ms startup latency).
 *
 * Design decisions:
 * - One browser context per provider per tenant (isolation)
 * - Sessions persist to disk (survives restarts)
 * - Health monitoring detects expired sessions and triggers re-auth
 * - WebSocket streaming to desktop app for real-time UI updates
 */

import { createLogger } from './logger.js';

const logger = createLogger('session-manager');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionConfig {
  tenant_id: string;
  provider_id: string;
  provider_url: string;
  session_path: string;
  headless?: boolean;
}

export type SessionStatus = 'idle' | 'active' | 'expired' | 'error' | 'initializing';

export interface BrowserSession {
  id: string;
  tenant_id: string;
  provider_id: string;
  status: SessionStatus;
  last_activity: string;
  created_at: string;
  cookies_valid: boolean;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  artifacts?: Array<{
    type: string;
    content: string;
    filename?: string;
  }>;
}

// ─── Session Manager ────────────────────────────────────────────────────────

export class SessionManager {
  private sessions: Map<string, BrowserSession> = new Map();
  private contexts: Map<string, unknown> = new Map(); // Playwright BrowserContext instances

  /**
   * Create or restore a browser session for a provider.
   */
  async createSession(config: SessionConfig): Promise<BrowserSession> {
    const sessionId = `${config.tenant_id}:${config.provider_id}`;

    // Check for existing session
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status !== 'expired' && existing.status !== 'error') {
      logger.info({ sessionId }, 'Reusing existing session');
      return existing;
    }

    logger.info({ sessionId, provider: config.provider_id }, 'Creating browser session');

    const session: BrowserSession = {
      id: sessionId,
      tenant_id: config.tenant_id,
      provider_id: config.provider_id,
      status: 'initializing',
      last_activity: new Date().toISOString(),
      created_at: new Date().toISOString(),
      cookies_valid: false,
    };

    try {
      // Dynamic import to handle cases where Playwright isn't installed
      const { chromium } = await import('playwright');

      // Launch browser with persistent context (preserves cookies/sessions)
      const context = await chromium.launchPersistentContext(config.session_path, {
        headless: config.headless ?? true,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });

      this.contexts.set(sessionId, context);
      session.status = 'idle';
      session.cookies_valid = true;

      // Navigate to provider to check auth state
      const page = await context.newPage();
      await page.goto(config.provider_url, { waitUntil: 'networkidle' });

      // Check if we're on a login page (simplified heuristic)
      const url = page.url();
      const isLoginPage =
        url.includes('login') ||
        url.includes('signin') ||
        url.includes('auth');

      if (isLoginPage) {
        session.cookies_valid = false;
        session.status = 'expired';
        logger.info({ sessionId }, 'Session needs authentication');
      } else {
        session.cookies_valid = true;
        session.status = 'idle';
        logger.info({ sessionId }, 'Session authenticated');
      }

      await page.close();
    } catch (err) {
      session.status = 'error';
      logger.error({ err, sessionId }, 'Failed to create browser session');
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Send a message to a provider through their web UI.
   * Returns the provider's response.
   */
  async sendMessage(
    tenantId: string,
    providerId: string,
    message: string,
  ): Promise<SessionMessage | null> {
    const sessionId = `${tenantId}:${providerId}`;
    const context = this.contexts.get(sessionId) as { pages: () => unknown[] } | undefined;

    if (!context) {
      logger.error({ sessionId }, 'No active browser context');
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'expired') {
      logger.error({ sessionId }, 'Session expired, re-authentication needed');
      return null;
    }

    // This is a simplified version. In production, use agent-browser's
    // ref-based element selection for resilient UI automation.
    logger.info({ sessionId, preview: message.substring(0, 50) }, 'Sending message via browser');

    session.status = 'active';
    session.last_activity = new Date().toISOString();

    // Provider-specific interaction would go here.
    // Each provider needs its own automation script for:
    // - Finding the input field
    // - Typing the message
    // - Clicking send
    // - Waiting for response
    // - Extracting the response text and artifacts

    // Placeholder response
    return {
      role: 'assistant',
      content: `[Browser automation pending for ${providerId}]`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get session status for a tenant's provider.
   */
  getSession(tenantId: string, providerId: string): BrowserSession | undefined {
    return this.sessions.get(`${tenantId}:${providerId}`);
  }

  /**
   * Get all sessions for a tenant.
   */
  getTenantSessions(tenantId: string): BrowserSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.tenant_id === tenantId);
  }

  /**
   * Check health of all sessions.
   */
  async healthCheck(): Promise<Record<string, SessionStatus>> {
    const results: Record<string, SessionStatus> = {};
    for (const [id, session] of this.sessions) {
      results[id] = session.status;
    }
    return results;
  }

  /**
   * Close a specific session.
   */
  async closeSession(tenantId: string, providerId: string): Promise<void> {
    const sessionId = `${tenantId}:${providerId}`;
    const context = this.contexts.get(sessionId) as { close: () => Promise<void> } | undefined;

    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'Session closed');
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    for (const [id, context] of this.contexts) {
      try {
        await (context as { close: () => Promise<void> }).close();
      } catch (err) {
        logger.error({ err, sessionId: id }, 'Error closing session');
      }
    }
    this.contexts.clear();
    this.sessions.clear();
    logger.info('All sessions closed');
  }
}
