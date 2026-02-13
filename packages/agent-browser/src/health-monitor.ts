/**
 * Session health monitor — periodic health checks for all browser sessions.
 *
 * Responsibilities:
 * - Poll all active sessions on an interval
 * - Detect expired sessions (auth failures, cookie expiry)
 * - Emit events for re-auth flows and dashboard updates
 * - Track session uptime and error rates
 * - Auto-close zombie sessions (idle > max_idle_time)
 */

import { createLogger } from './logger.js';
import type { SessionManager, BrowserSession, SessionStatus } from './session-manager.js';

const logger = createLogger('health-monitor');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  session_id: string;
  tenant_id: string;
  provider_id: string;
  status: SessionStatus;
  cookies_valid: boolean;
  last_activity: string;
  idle_seconds: number;
  needs_reauth: boolean;
  error?: string;
}

export interface MonitorConfig {
  check_interval_ms: number;
  max_idle_seconds: number;
  auto_close_expired: boolean;
  reauth_cooldown_ms: number;
}

export interface HealthEvent {
  type: 'session:healthy' | 'session:expired' | 'session:idle' | 'session:error' | 'session:closed';
  session_id: string;
  data: HealthCheckResult;
  timestamp: string;
}

export type HealthEventHandler = (event: HealthEvent) => void;

const DEFAULT_CONFIG: MonitorConfig = {
  check_interval_ms: 30000,      // Check every 30 seconds
  max_idle_seconds: 1800,        // 30 minutes max idle
  auto_close_expired: true,
  reauth_cooldown_ms: 300000,    // 5-minute cooldown between re-auth attempts
};

// ─── Health Monitor ─────────────────────────────────────────────────────────

export class HealthMonitor {
  private config: MonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: HealthEventHandler[] = [];
  private lastReauthAttempt: Map<string, number> = new Map();
  private running = false;

  constructor(
    private sessionManager: SessionManager,
    config?: Partial<MonitorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the health monitoring loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    logger.info({
      interval_ms: this.config.check_interval_ms,
      max_idle_s: this.config.max_idle_seconds,
    }, 'Health monitor started');

    this.timer = setInterval(() => {
      this.checkAll().catch((err) => {
        logger.error({ err }, 'Health check cycle failed');
      });
    }, this.config.check_interval_ms);

    // Run immediately
    this.checkAll().catch((err) => {
      logger.error({ err }, 'Initial health check failed');
    });
  }

  /**
   * Stop the health monitoring loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('Health monitor stopped');
  }

  /**
   * Register an event handler for health events.
   */
  onEvent(handler: HealthEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Run a health check on all sessions.
   */
  async checkAll(): Promise<HealthCheckResult[]> {
    const health = await this.sessionManager.healthCheck();
    const results: HealthCheckResult[] = [];

    for (const [sessionId, status] of Object.entries(health)) {
      const [tenantId, providerId] = sessionId.split(':');
      const session = this.sessionManager.getSession(tenantId, providerId);

      if (!session) continue;

      const result = this.evaluateSession(session, status);
      results.push(result);

      // Emit appropriate event
      await this.handleResult(result);
    }

    return results;
  }

  /**
   * Check a single session by ID.
   */
  async checkSession(tenantId: string, providerId: string): Promise<HealthCheckResult | null> {
    const session = this.sessionManager.getSession(tenantId, providerId);
    if (!session) return null;

    const result = this.evaluateSession(session, session.status);
    await this.handleResult(result);
    return result;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private evaluateSession(session: BrowserSession, status: SessionStatus): HealthCheckResult {
    const idleMs = Date.now() - new Date(session.last_activity).getTime();
    const idleSeconds = Math.floor(idleMs / 1000);

    const needsReauth =
      status === 'expired' ||
      !session.cookies_valid ||
      (status === 'error' && !session.cookies_valid);

    return {
      session_id: session.id,
      tenant_id: session.tenant_id,
      provider_id: session.provider_id,
      status,
      cookies_valid: session.cookies_valid,
      last_activity: session.last_activity,
      idle_seconds: idleSeconds,
      needs_reauth: needsReauth,
    };
  }

  private async handleResult(result: HealthCheckResult): Promise<void> {
    const { session_id: sessionId } = result;

    if (result.needs_reauth) {
      // Check cooldown
      const lastAttempt = this.lastReauthAttempt.get(sessionId) ?? 0;
      if (Date.now() - lastAttempt < this.config.reauth_cooldown_ms) {
        return; // Still in cooldown
      }
      this.lastReauthAttempt.set(sessionId, Date.now());

      this.emit({
        type: 'session:expired',
        session_id: sessionId,
        data: result,
        timestamp: new Date().toISOString(),
      });

      if (this.config.auto_close_expired) {
        await this.sessionManager.closeSession(result.tenant_id, result.provider_id);
        this.emit({
          type: 'session:closed',
          session_id: sessionId,
          data: { ...result, status: 'expired' },
          timestamp: new Date().toISOString(),
        });
      }
    } else if (result.idle_seconds > this.config.max_idle_seconds) {
      this.emit({
        type: 'session:idle',
        session_id: sessionId,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } else if (result.status === 'error') {
      this.emit({
        type: 'session:error',
        session_id: sessionId,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.emit({
        type: 'session:healthy',
        session_id: sessionId,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private emit(event: HealthEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error({ err, event_type: event.type }, 'Health event handler error');
      }
    }
  }
}
