/**
 * Rate limiter for multi-tenant scaling.
 *
 * Token-bucket algorithm with per-tenant limits based on tier.
 * Tracks usage, enforces quotas, and provides usage analytics.
 */

import { createLogger } from '../logger.js';
import type { TenantConfig } from '../types.js';

const logger = createLogger('rate-limiter');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TierLimits {
  messages_per_minute: number;
  messages_per_day: number;
  recipes_per_hour: number;
  browser_sessions: number;
  api_calls_per_minute: number;
  storage_mb: number;
}

export interface UsageBucket {
  tenant_id: string;
  messages_minute: number;
  messages_day: number;
  recipes_hour: number;
  api_calls_minute: number;
  active_sessions: number;
  storage_used_mb: number;
  last_reset_minute: number;
  last_reset_day: number;
  last_reset_hour: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  reset_at: string;
  resource: string;
}

// ─── Tier Limits ────────────────────────────────────────────────────────────

export const TIER_LIMITS: Record<string, TierLimits> = {
  free: {
    messages_per_minute: 5,
    messages_per_day: 50,
    recipes_per_hour: 3,
    browser_sessions: 1,
    api_calls_per_minute: 30,
    storage_mb: 100,
  },
  starter: {
    messages_per_minute: 20,
    messages_per_day: 500,
    recipes_per_hour: 20,
    browser_sessions: 3,
    api_calls_per_minute: 120,
    storage_mb: 1000,
  },
  pro: {
    messages_per_minute: 60,
    messages_per_day: 5000,
    recipes_per_hour: 100,
    browser_sessions: 10,
    api_calls_per_minute: 600,
    storage_mb: 10000,
  },
  business: {
    messages_per_minute: 200,
    messages_per_day: 50000,
    recipes_per_hour: 500,
    browser_sessions: 50,
    api_calls_per_minute: 3000,
    storage_mb: 100000,
  },
  agency: {
    messages_per_minute: 1000,
    messages_per_day: 500000,
    recipes_per_hour: 5000,
    browser_sessions: 200,
    api_calls_per_minute: 10000,
    storage_mb: 1000000,
  },
};

// ─── Rate Limiter ───────────────────────────────────────────────────────────

export class RateLimiter {
  private buckets: Map<string, UsageBucket> = new Map();

  /**
   * Check and consume a rate limit for a specific resource.
   */
  check(tenantId: string, tier: string, resource: 'message' | 'recipe' | 'api_call'): RateLimitResult {
    const limits = TIER_LIMITS[tier] ?? TIER_LIMITS.free;
    const bucket = this.getOrCreateBucket(tenantId);
    this.resetExpiredWindows(bucket);

    switch (resource) {
      case 'message': {
        // Check both minute and daily limits
        if (bucket.messages_minute >= limits.messages_per_minute) {
          return {
            allowed: false,
            remaining: 0,
            limit: limits.messages_per_minute,
            reset_at: this.getNextMinuteReset(),
            resource: 'messages_per_minute',
          };
        }
        if (bucket.messages_day >= limits.messages_per_day) {
          return {
            allowed: false,
            remaining: 0,
            limit: limits.messages_per_day,
            reset_at: this.getNextDayReset(),
            resource: 'messages_per_day',
          };
        }
        bucket.messages_minute++;
        bucket.messages_day++;
        return {
          allowed: true,
          remaining: Math.min(
            limits.messages_per_minute - bucket.messages_minute,
            limits.messages_per_day - bucket.messages_day,
          ),
          limit: limits.messages_per_minute,
          reset_at: this.getNextMinuteReset(),
          resource: 'message',
        };
      }

      case 'recipe': {
        if (bucket.recipes_hour >= limits.recipes_per_hour) {
          return {
            allowed: false,
            remaining: 0,
            limit: limits.recipes_per_hour,
            reset_at: this.getNextHourReset(),
            resource: 'recipes_per_hour',
          };
        }
        bucket.recipes_hour++;
        return {
          allowed: true,
          remaining: limits.recipes_per_hour - bucket.recipes_hour,
          limit: limits.recipes_per_hour,
          reset_at: this.getNextHourReset(),
          resource: 'recipe',
        };
      }

      case 'api_call': {
        if (bucket.api_calls_minute >= limits.api_calls_per_minute) {
          return {
            allowed: false,
            remaining: 0,
            limit: limits.api_calls_per_minute,
            reset_at: this.getNextMinuteReset(),
            resource: 'api_calls_per_minute',
          };
        }
        bucket.api_calls_minute++;
        return {
          allowed: true,
          remaining: limits.api_calls_per_minute - bucket.api_calls_minute,
          limit: limits.api_calls_per_minute,
          reset_at: this.getNextMinuteReset(),
          resource: 'api_call',
        };
      }
    }
  }

  /**
   * Check if a tenant can have more browser sessions.
   */
  checkSessionLimit(tenantId: string, tier: string): boolean {
    const limits = TIER_LIMITS[tier] ?? TIER_LIMITS.free;
    const bucket = this.getOrCreateBucket(tenantId);
    return bucket.active_sessions < limits.browser_sessions;
  }

  /**
   * Track a session open/close.
   */
  trackSession(tenantId: string, delta: 1 | -1): void {
    const bucket = this.getOrCreateBucket(tenantId);
    bucket.active_sessions = Math.max(0, bucket.active_sessions + delta);
  }

  /**
   * Get usage for a tenant.
   */
  getUsage(tenantId: string): UsageBucket | undefined {
    const bucket = this.buckets.get(tenantId);
    if (bucket) this.resetExpiredWindows(bucket);
    return bucket;
  }

  /**
   * Get limits for a tier.
   */
  getLimits(tier: string): TierLimits {
    return TIER_LIMITS[tier] ?? TIER_LIMITS.free;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private getOrCreateBucket(tenantId: string): UsageBucket {
    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      const now = Date.now();
      bucket = {
        tenant_id: tenantId,
        messages_minute: 0,
        messages_day: 0,
        recipes_hour: 0,
        api_calls_minute: 0,
        active_sessions: 0,
        storage_used_mb: 0,
        last_reset_minute: now,
        last_reset_day: now,
        last_reset_hour: now,
      };
      this.buckets.set(tenantId, bucket);
    }
    return bucket;
  }

  private resetExpiredWindows(bucket: UsageBucket): void {
    const now = Date.now();

    if (now - bucket.last_reset_minute >= 60000) {
      bucket.messages_minute = 0;
      bucket.api_calls_minute = 0;
      bucket.last_reset_minute = now;
    }

    if (now - bucket.last_reset_hour >= 3600000) {
      bucket.recipes_hour = 0;
      bucket.last_reset_hour = now;
    }

    if (now - bucket.last_reset_day >= 86400000) {
      bucket.messages_day = 0;
      bucket.last_reset_day = now;
    }
  }

  private getNextMinuteReset(): string {
    const d = new Date();
    d.setSeconds(d.getSeconds() + 60);
    return d.toISOString();
  }

  private getNextHourReset(): string {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 60);
    return d.toISOString();
  }

  private getNextDayReset(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
}
