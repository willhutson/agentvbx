/**
 * Analytics engine — usage metrics, cost tracking, and dashboards.
 *
 * Tracks all system activity and provides aggregated views for:
 * - Per-tenant usage (messages, recipes, tokens, costs)
 * - Provider cost breakdown
 * - System-wide metrics
 * - Time-series data for dashboard charts
 */

import { createLogger } from '../logger.js';

const logger = createLogger('analytics');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UsageEvent {
  type: 'message' | 'recipe' | 'browser_task' | 'integration' | 'artifact';
  tenant_id: string;
  provider?: string;
  agent?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  timestamp: string;
}

export interface TenantUsageSummary {
  tenant_id: string;
  period: { from: string; to: string };
  messages: { total: number; by_channel: Record<string, number> };
  recipes: { total: number; completed: number; failed: number };
  tokens: { input: number; output: number; total: number };
  costs: { total_usd: number; by_provider: Record<string, number> };
  browser_tasks: number;
  artifacts_generated: number;
}

export interface AnalyticsOverview {
  total_tenants: number;
  total_messages_today: number;
  total_recipes_today: number;
  total_cost_today_usd: number;
  active_browser_sessions: number;
  top_providers: Array<{ provider: string; usage: number; cost_usd: number }>;
  top_agents: Array<{ agent: string; messages: number }>;
  system_health: {
    queue_depth: number;
    avg_latency_ms: number;
    error_rate: number;
  };
}

export interface CostBreakdown {
  period: { from: string; to: string };
  total_usd: number;
  by_provider: Record<string, { calls: number; tokens: number; cost_usd: number }>;
  by_tenant: Record<string, number>;
  daily: Array<{ date: string; cost_usd: number }>;
}

// ─── Provider Cost Rates (per 1K tokens) ────────────────────────────────────

const COST_RATES: Record<string, { input: number; output: number }> = {
  anthropic: { input: 0.003, output: 0.015 },
  openai: { input: 0.005, output: 0.015 },
  deepseek: { input: 0.0003, output: 0.0012 },
  ollama: { input: 0, output: 0 },
  gemini: { input: 0.00125, output: 0.005 },
  perplexity: { input: 0.001, output: 0.001 },
};

// ─── Analytics Engine ────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private events: UsageEvent[] = [];
  private maxEvents = 100000;

  /**
   * Record a usage event.
   */
  track(event: UsageEvent): void {
    // Calculate cost if not provided
    if (event.cost_usd === undefined && event.provider && (event.tokens_in || event.tokens_out)) {
      const rates = COST_RATES[event.provider];
      if (rates) {
        event.cost_usd =
          ((event.tokens_in ?? 0) / 1000) * rates.input +
          ((event.tokens_out ?? 0) / 1000) * rates.output;
      }
    }

    this.events.push(event);

    // Trim old events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Get system-wide analytics overview.
   */
  getOverview(): AnalyticsOverview {
    const today = new Date().toISOString().split('T')[0];
    const todayEvents = this.events.filter((e) => e.timestamp.startsWith(today));

    const providerUsage = new Map<string, { usage: number; cost: number }>();
    const agentUsage = new Map<string, number>();

    for (const event of todayEvents) {
      if (event.provider) {
        const p = providerUsage.get(event.provider) ?? { usage: 0, cost: 0 };
        p.usage++;
        p.cost += event.cost_usd ?? 0;
        providerUsage.set(event.provider, p);
      }
      if (event.agent) {
        agentUsage.set(event.agent, (agentUsage.get(event.agent) ?? 0) + 1);
      }
    }

    const totalCost = todayEvents.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);
    const latencies = todayEvents.filter((e) => e.duration_ms).map((e) => e.duration_ms!);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    const tenantIds = new Set(this.events.map((e) => e.tenant_id));

    return {
      total_tenants: tenantIds.size,
      total_messages_today: todayEvents.filter((e) => e.type === 'message').length,
      total_recipes_today: todayEvents.filter((e) => e.type === 'recipe').length,
      total_cost_today_usd: Math.round(totalCost * 10000) / 10000,
      active_browser_sessions: todayEvents.filter((e) => e.type === 'browser_task').length,
      top_providers: Array.from(providerUsage.entries())
        .map(([provider, data]) => ({
          provider,
          usage: data.usage,
          cost_usd: Math.round(data.cost * 10000) / 10000,
        }))
        .sort((a, b) => b.usage - a.usage)
        .slice(0, 10),
      top_agents: Array.from(agentUsage.entries())
        .map(([agent, messages]) => ({ agent, messages }))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 10),
      system_health: {
        queue_depth: 0,
        avg_latency_ms: avgLatency,
        error_rate: 0,
      },
    };
  }

  /**
   * Get usage summary for a specific tenant.
   */
  getTenantUsage(tenantId: string, from?: string, to?: string): TenantUsageSummary {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 86400000 * 30);
    const toDate = to ? new Date(to) : new Date();

    const events = this.events.filter(
      (e) =>
        e.tenant_id === tenantId &&
        new Date(e.timestamp) >= fromDate &&
        new Date(e.timestamp) <= toDate,
    );

    const channelCounts: Record<string, number> = {};
    const providerCosts: Record<string, number> = {};
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let recipesCompleted = 0;
    let recipesFailed = 0;
    let totalCost = 0;

    for (const event of events) {
      if (event.provider) {
        providerCosts[event.provider] = (providerCosts[event.provider] ?? 0) + (event.cost_usd ?? 0);
      }
      totalTokensIn += event.tokens_in ?? 0;
      totalTokensOut += event.tokens_out ?? 0;
      totalCost += event.cost_usd ?? 0;
    }

    return {
      tenant_id: tenantId,
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      messages: {
        total: events.filter((e) => e.type === 'message').length,
        by_channel: channelCounts,
      },
      recipes: {
        total: events.filter((e) => e.type === 'recipe').length,
        completed: recipesCompleted,
        failed: recipesFailed,
      },
      tokens: {
        input: totalTokensIn,
        output: totalTokensOut,
        total: totalTokensIn + totalTokensOut,
      },
      costs: {
        total_usd: Math.round(totalCost * 10000) / 10000,
        by_provider: Object.fromEntries(
          Object.entries(providerCosts).map(([k, v]) => [k, Math.round(v * 10000) / 10000]),
        ),
      },
      browser_tasks: events.filter((e) => e.type === 'browser_task').length,
      artifacts_generated: events.filter((e) => e.type === 'artifact').length,
    };
  }

  /**
   * Get cost breakdown.
   */
  getCostBreakdown(days = 30): CostBreakdown {
    const fromDate = new Date(Date.now() - 86400000 * days);
    const events = this.events.filter((e) => new Date(e.timestamp) >= fromDate);

    const byProvider: Record<string, { calls: number; tokens: number; cost_usd: number }> = {};
    const byTenant: Record<string, number> = {};
    const dailyCosts: Record<string, number> = {};

    for (const event of events) {
      const cost = event.cost_usd ?? 0;
      const day = event.timestamp.split('T')[0];

      if (event.provider) {
        const p = byProvider[event.provider] ?? { calls: 0, tokens: 0, cost_usd: 0 };
        p.calls++;
        p.tokens += (event.tokens_in ?? 0) + (event.tokens_out ?? 0);
        p.cost_usd += cost;
        byProvider[event.provider] = p;
      }

      byTenant[event.tenant_id] = (byTenant[event.tenant_id] ?? 0) + cost;
      dailyCosts[day] = (dailyCosts[day] ?? 0) + cost;
    }

    const totalCost = Object.values(byTenant).reduce((a, b) => a + b, 0);

    return {
      period: { from: fromDate.toISOString(), to: new Date().toISOString() },
      total_usd: Math.round(totalCost * 10000) / 10000,
      by_provider: Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [
          k,
          { ...v, cost_usd: Math.round(v.cost_usd * 10000) / 10000 },
        ]),
      ),
      by_tenant: Object.fromEntries(
        Object.entries(byTenant).map(([k, v]) => [k, Math.round(v * 10000) / 10000]),
      ),
      daily: Object.entries(dailyCosts)
        .map(([date, cost]) => ({ date, cost_usd: Math.round(cost * 10000) / 10000 }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
