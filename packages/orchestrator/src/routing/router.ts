/**
 * Message router — maps inbound messages to the right agent and provider.
 *
 * Routing logic:
 * 1. Explicit agent routing (message.agent field)
 * 2. Keyword-based routing from agent blueprints
 * 3. Channel-based routing (voice messages → agents with voice capability)
 * 4. Default agent fallback
 *
 * Provider selection follows the agent's provider_priority array,
 * falling through to the next if the current is unavailable.
 */

import { createLogger } from '../logger.js';
import type { AgentBlueprint, Message, RoutingDecision } from '../types.js';

const logger = createLogger('router');

export interface ProviderStatus {
  id: string;
  available: boolean;
  latency_ms?: number;
  last_checked: string;
}

export class MessageRouter {
  private agents: Map<string, AgentBlueprint> = new Map();
  private providerStatus: Map<string, ProviderStatus> = new Map();

  /**
   * Register an agent blueprint for routing.
   */
  registerAgent(blueprint: AgentBlueprint): void {
    this.agents.set(blueprint.name.toLowerCase(), blueprint);
    logger.info({ agent: blueprint.name, keywords: blueprint.routing_keywords }, 'Agent registered');
  }

  /**
   * Update provider availability status.
   */
  updateProviderStatus(status: ProviderStatus): void {
    this.providerStatus.set(status.id, status);
  }

  /**
   * Route a message to the best agent and provider.
   */
  route(message: Message): RoutingDecision {
    // 1. Explicit agent routing
    if (message.agent) {
      const agent = this.agents.get(message.agent.toLowerCase());
      if (agent) {
        const provider = this.selectProvider(agent);
        return {
          agent: agent.name,
          provider,
          confidence: 1.0,
          reasoning: 'Explicit agent routing',
          fallback_providers: this.getFallbacks(agent, provider),
        };
      }
      logger.warn({ requested: message.agent }, 'Requested agent not found, falling back to keyword routing');
    }

    // 2. Channel-based filtering + keyword routing
    const candidates = this.rankAgents(message);

    if (candidates.length > 0) {
      const best = candidates[0];
      const provider = this.selectProvider(best.agent);
      return {
        agent: best.agent.name,
        provider,
        confidence: best.score,
        reasoning: best.reasoning,
        fallback_providers: this.getFallbacks(best.agent, provider),
      };
    }

    // 3. Default fallback — pick first agent that supports this channel
    const defaultAgent = this.findDefaultAgent(message.channel);
    if (defaultAgent) {
      const provider = this.selectProvider(defaultAgent);
      return {
        agent: defaultAgent.name,
        provider,
        confidence: 0.3,
        reasoning: 'Default agent for channel',
        fallback_providers: this.getFallbacks(defaultAgent, provider),
      };
    }

    // No agents registered at all
    logger.error({ channel: message.channel }, 'No agents available for routing');
    return {
      agent: 'none',
      provider: 'none',
      confidence: 0,
      reasoning: 'No agents registered',
      fallback_providers: [],
    };
  }

  /**
   * Rank agents by relevance to the message.
   */
  private rankAgents(message: Message): Array<{ agent: AgentBlueprint; score: number; reasoning: string }> {
    const results: Array<{ agent: AgentBlueprint; score: number; reasoning: string }> = [];
    const textLower = message.text.toLowerCase();
    const words = textLower.split(/\s+/);

    for (const agent of this.agents.values()) {
      // Filter by channel support
      if (!agent.channels.includes(message.channel)) continue;

      let score = 0;
      const reasons: string[] = [];

      // Keyword matching
      for (const keyword of agent.routing_keywords) {
        if (words.includes(keyword.toLowerCase())) {
          score += 0.3;
          reasons.push(`keyword: ${keyword}`);
        } else if (textLower.includes(keyword.toLowerCase())) {
          score += 0.15;
          reasons.push(`partial keyword: ${keyword}`);
        }
      }

      // Tool mention boosting
      for (const tool of agent.tools) {
        if (textLower.includes(tool.toLowerCase())) {
          score += 0.2;
          reasons.push(`tool mention: ${tool}`);
        }
      }

      if (score > 0) {
        results.push({
          agent,
          score: Math.min(score, 1.0),
          reasoning: reasons.join(', '),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Select the best available provider from the agent's priority list.
   */
  private selectProvider(agent: AgentBlueprint): string {
    for (const providerId of agent.provider_priority) {
      const status = this.providerStatus.get(providerId);
      // If we have no status info, assume available (optimistic)
      if (!status || status.available) {
        return providerId;
      }
    }

    // All providers down — return first as fallback (will fail gracefully downstream)
    logger.warn({ agent: agent.name }, 'All providers unavailable, using first as fallback');
    return agent.provider_priority[0] ?? 'none';
  }

  /**
   * Get fallback providers (everything after the selected one).
   */
  private getFallbacks(agent: AgentBlueprint, selected: string): string[] {
    const idx = agent.provider_priority.indexOf(selected);
    if (idx === -1) return agent.provider_priority;
    return agent.provider_priority.slice(idx + 1);
  }

  /**
   * Find a default agent for a given channel.
   */
  private findDefaultAgent(channel: string): AgentBlueprint | undefined {
    for (const agent of this.agents.values()) {
      if (agent.channels.includes(channel as AgentBlueprint['channels'][number])) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Get all registered agent names.
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get the blueprint for a specific agent.
   */
  getAgent(name: string): AgentBlueprint | undefined {
    return this.agents.get(name.toLowerCase());
  }
}
