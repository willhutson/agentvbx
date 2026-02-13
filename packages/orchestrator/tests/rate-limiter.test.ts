import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, TIER_LIMITS } from '../src/scaling/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows messages within limits', () => {
    const result = limiter.check('t1', 'pro', 'message');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it('enforces per-minute message limit for free tier', () => {
    const freeLimit = TIER_LIMITS.free.messages_per_minute;

    for (let i = 0; i < freeLimit; i++) {
      const result = limiter.check('t1', 'free', 'message');
      expect(result.allowed).toBe(true);
    }

    const blocked = limiter.check('t1', 'free', 'message');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('different tenants have independent limits', () => {
    const freeLimit = TIER_LIMITS.free.messages_per_minute;

    for (let i = 0; i < freeLimit; i++) {
      limiter.check('t1', 'free', 'message');
    }

    // t1 is blocked
    expect(limiter.check('t1', 'free', 'message').allowed).toBe(false);

    // t2 should still work
    expect(limiter.check('t2', 'free', 'message').allowed).toBe(true);
  });

  it('enforces recipe limits', () => {
    const limit = TIER_LIMITS.free.recipes_per_hour;

    for (let i = 0; i < limit; i++) {
      expect(limiter.check('t1', 'free', 'recipe').allowed).toBe(true);
    }

    expect(limiter.check('t1', 'free', 'recipe').allowed).toBe(false);
  });

  it('enforces API call limits', () => {
    const limit = TIER_LIMITS.free.api_calls_per_minute;

    for (let i = 0; i < limit; i++) {
      expect(limiter.check('t1', 'free', 'api_call').allowed).toBe(true);
    }

    expect(limiter.check('t1', 'free', 'api_call').allowed).toBe(false);
  });

  it('checks browser session limits', () => {
    expect(limiter.checkSessionLimit('t1', 'free')).toBe(true);

    limiter.trackSession('t1', 1);
    expect(limiter.checkSessionLimit('t1', 'free')).toBe(false);

    limiter.trackSession('t1', -1);
    expect(limiter.checkSessionLimit('t1', 'free')).toBe(true);
  });

  it('pro tier has higher limits than free', () => {
    expect(TIER_LIMITS.pro.messages_per_minute).toBeGreaterThan(TIER_LIMITS.free.messages_per_minute);
    expect(TIER_LIMITS.pro.messages_per_day).toBeGreaterThan(TIER_LIMITS.free.messages_per_day);
    expect(TIER_LIMITS.pro.browser_sessions).toBeGreaterThan(TIER_LIMITS.free.browser_sessions);
  });

  it('returns usage bucket', () => {
    limiter.check('t1', 'free', 'message');
    limiter.check('t1', 'free', 'message');
    limiter.check('t1', 'free', 'recipe');

    const usage = limiter.getUsage('t1');
    expect(usage).toBeTruthy();
    expect(usage!.messages_minute).toBe(2);
    expect(usage!.recipes_hour).toBe(1);
  });
});
