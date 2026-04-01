/**
 * Tests for the webhook-layer rate limiter.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rateLimiterMiddleware, resetBuckets, getBucketState, TIER_LIMITS, DEFAULT_LIMIT } from '../src/middleware/rateLimiter.js';
import type { Request, Response, NextFunction } from 'express';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function mockReq(orgId: string, tier = 'STARTER'): Partial<Request> {
  return {
    org: { orgId, tier, channels: {}, active: true },
  } as Partial<Request>;
}

function mockRes(): {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const res: any = { headers: {} };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn((k: string, v: string) => { res.headers[k] = v; return res; });
  return res;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('rateLimiterMiddleware', () => {
  beforeEach(() => {
    resetBuckets();
  });

  it('allows requests within the limit', () => {
    const req = mockReq('org1', 'STARTER');
    const res = mockRes();
    const next = vi.fn();

    rateLimiterMiddleware(req as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  it('sets rate limit headers on allowed requests', () => {
    const req = mockReq('org1', 'STARTER');
    const res = mockRes();
    const next = vi.fn();

    rateLimiterMiddleware(req as Request, res as unknown as Response, next);
    expect(res.headers['X-RateLimit-Limit']).toBe('60');
    expect(res.headers['X-RateLimit-Remaining']).toBeDefined();
  });

  it('returns 429 when bucket is exhausted', () => {
    const req = mockReq('org2', 'FREE'); // 30/min
    const next = vi.fn();

    // Drain the bucket
    for (let i = 0; i < 30; i++) {
      rateLimiterMiddleware(req as Request, mockRes() as unknown as Response, vi.fn());
    }

    // Next request should be rate limited
    const res = mockRes();
    rateLimiterMiddleware(req as Request, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers['Retry-After']).toBeDefined();
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('FREE tier has lower limit than BUSINESS tier', () => {
    const freeReq = mockReq('org-free', 'FREE');
    const bizReq = mockReq('org-biz', 'BUSINESS');

    // Drain FREE (30)
    for (let i = 0; i < 30; i++) {
      rateLimiterMiddleware(freeReq as Request, mockRes() as unknown as Response, vi.fn());
    }
    const freeNext = vi.fn();
    rateLimiterMiddleware(freeReq as Request, mockRes() as unknown as Response, freeNext);
    expect(freeNext).not.toHaveBeenCalled(); // should be rate limited

    // BUSINESS (300) should still have tokens after 30 requests
    for (let i = 0; i < 30; i++) {
      rateLimiterMiddleware(bizReq as Request, mockRes() as unknown as Response, vi.fn());
    }
    const bizNext = vi.fn();
    rateLimiterMiddleware(bizReq as Request, mockRes() as unknown as Response, bizNext);
    expect(bizNext).toHaveBeenCalled(); // should NOT be rate limited
  });

  it('proceeds without rate limiting when no org on request', () => {
    const req = {} as Request;
    const res = mockRes();
    const next = vi.fn();

    rateLimiterMiddleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('uses DEFAULT_LIMIT for unknown tier', () => {
    const req = mockReq('org-unknown', 'ENTERPRISE'); // not in TIER_LIMITS
    const res = mockRes();
    const next = vi.fn();

    rateLimiterMiddleware(req as Request, res as unknown as Response, next);
    expect(res.headers['X-RateLimit-Limit']).toBe(String(DEFAULT_LIMIT));
  });

  it('tracks separate buckets per org', () => {
    const req1 = mockReq('org-a', 'FREE');
    const req2 = mockReq('org-b', 'FREE');

    // Drain org-a
    for (let i = 0; i < 30; i++) {
      rateLimiterMiddleware(req1 as Request, mockRes() as unknown as Response, vi.fn());
    }

    // org-b should still be fine
    const next = vi.fn();
    rateLimiterMiddleware(req2 as Request, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('exposes tier limits with correct values', () => {
    expect(TIER_LIMITS.FREE).toBe(30);
    expect(TIER_LIMITS.STARTER).toBe(60);
    expect(TIER_LIMITS.PRO).toBe(120);
    expect(TIER_LIMITS.BUSINESS).toBe(300);
  });

  it('getBucketState returns bucket after first request', () => {
    const req = mockReq('org-state', 'PRO');
    rateLimiterMiddleware(req as Request, mockRes() as unknown as Response, vi.fn());

    const state = getBucketState('org-state');
    expect(state).toBeDefined();
    expect(state!.tokens).toBe(119); // 120 - 1
  });
});
