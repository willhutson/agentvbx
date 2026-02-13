/**
 * Agent step handler — executes recipe steps that invoke an AI agent.
 *
 * This is the core handler that connects recipe steps to provider adapters.
 * When a recipe step has type "agent", this handler:
 * 1. Resolves the agent blueprint
 * 2. Builds the prompt from step input and context
 * 3. Sends to the adapter manager with fallback
 * 4. Returns the agent's response as the step output
 */

import { createLogger } from '../logger.js';
import type { RecipeStep } from '../types.js';
import type { StepHandler } from '../recipe/engine.js';
import type { RecipeExecution } from '../recipe/engine.js';

const logger = createLogger('agent-step-handler');

export interface AgentStepDeps {
  adapterManager: {
    sendWithFallback(
      request: { prompt: string; system_prompt?: string; temperature?: number; max_tokens?: number; metadata?: Record<string, unknown> },
      providerPriority: string[],
    ): Promise<{ text: string; provider_id: string; model?: string; tokens_used?: number; latency_ms: number; fallbacks_tried: string[] }>;
  };
  getAgentBlueprint: (name: string) => { system_prompt: string; provider_priority: string[]; temperature: number } | undefined;
}

export class AgentStepHandler implements StepHandler {
  constructor(private deps: AgentStepDeps) {}

  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown> {
    const agentName = step.agent ?? 'default';
    const blueprint = this.deps.getAgentBlueprint(agentName);

    if (!blueprint) {
      throw new Error(`Agent blueprint not found: ${agentName}`);
    }

    // Build prompt from step input
    const input = context._input;
    const prompt = typeof input === 'string'
      ? input
      : Array.isArray(input)
        ? (input as unknown[]).map(String).join('\n\n')
        : JSON.stringify(input);

    // Merge step params into prompt if present
    const params = context._params as Record<string, unknown> | undefined;
    const fullPrompt = params?.instruction
      ? `${params.instruction}\n\n${prompt}`
      : prompt;

    logger.info({
      execution_id: execution.id,
      step: step.name,
      agent: agentName,
      prompt_preview: fullPrompt.substring(0, 100),
    }, 'Executing agent step');

    const providerPriority = step.provider
      ? [step.provider, ...blueprint.provider_priority.filter((p) => p !== step.provider)]
      : blueprint.provider_priority;

    const response = await this.deps.adapterManager.sendWithFallback(
      {
        prompt: fullPrompt,
        system_prompt: blueprint.system_prompt,
        temperature: blueprint.temperature,
        max_tokens: (params?.max_tokens as number) ?? 4096,
        metadata: { agent: agentName, step: step.name },
      },
      providerPriority,
    );

    logger.info({
      execution_id: execution.id,
      step: step.name,
      provider: response.provider_id,
      tokens: response.tokens_used,
      latency: response.latency_ms,
      fallbacks: response.fallbacks_tried,
    }, 'Agent step completed');

    return {
      text: response.text,
      provider: response.provider_id,
      model: response.model,
      tokens_used: response.tokens_used,
      latency_ms: response.latency_ms,
    };
  }
}
