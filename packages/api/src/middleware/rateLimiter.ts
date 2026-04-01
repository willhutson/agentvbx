/**
 * Webhook-layer rate limiter — token bucket per org, enforced before Redis queue.
 *
 * In-memory per-process. For horizontal scaling, swap the Map for Redis
 * token buckets — the middleware interface stays the same.
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('rate-limiter');

// ─── Types ──────────────────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

// ─── Tier Limits (messages per minute) ──────────────────────────────────────

const TIER_LIMITS: Record<string, number> = {
  FREE: 30,
  STARTER: 60,
  PRO: 120,
  BUSINESS: 300,
};
const DEFAULT_LIMIT = 60;

// ─── State ──────────────────────────────────────────────────────────────────

const buckets = new Map<string, TokenBucket>();

// ─── Internals ──────────────────────────────────────────────────────────────

function getLimit(tier?: string): number {
  if (!tier) return DEFAULT_LIMIT;
  return TIER_LIMITS[tier.toUpperCase()] ?? DEFAULT_LIMIT;
}

function refillBucket(bucket: TokenBucket, limitPerMinute: number): TokenBucket {
  const now = Date.now();
  const elapsedMs = now - bucket.lastRefill;
  const tokensToAdd = (elapsedMs / 60_000) * limitPerMinute;
  return {
    tokens: Math.min(limitPerMinute, bucket.tokens + tokensToAdd),
    lastRefill: now,
  };
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Rate limiter middleware. Must run after orgSlugMiddleware so req.org is set.
 * Returns 429 with Retry-After header when the org's bucket is empty.
 */
export function rateLimiterMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const orgId: string | undefined = req.org?.orgId;
  const tier: string | undefined = req.org?.tier;

  if (!orgId) {
    next();
    return;
  }

  const limitPerMinute = getLimit(tier);
  const now = Date.now();

  let bucket = buckets.get(orgId);
  if (!bucket) {
    bucket = { tokens: limitPerMinute, lastRefill: now };
  } else {
    bucket = refillBucket(bucket, limitPerMinute);
  }

  if (bucket.tokens < 1) {
    const msPerToken = 60_000 / limitPerMinute;
    const retryAfterSeconds = Math.ceil(msPerToken / 1000);
    buckets.set(orgId, bucket);

    res.set('Retry-After', String(retryAfterSeconds));
    res.set('X-RateLimit-Limit', String(limitPerMinute));
    res.set('X-RateLimit-Remaining', '0');

    logger.warn({ orgId, tier, limitPerMinute }, 'Rate limit exceeded');
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfterSeconds,
      limitPerMinute,
    });
    return;
  }

  bucket.tokens -= 1;
  buckets.set(orgId, bucket);

  res.set('X-RateLimit-Limit', String(limitPerMinute));
  res.set('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));

  next();
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

export function resetBuckets(): void {
  buckets.clear();
}

export function getBucketState(orgId: string): TokenBucket | undefined {
  return buckets.get(orgId);
}

export { TIER_LIMITS, DEFAULT_LIMIT };
