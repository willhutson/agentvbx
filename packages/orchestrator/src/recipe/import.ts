/**
 * Import a Canvas template from the ERP as a VBX Recipe.
 * Called by the API when ERP pushes a recipe (Contract E2).
 */

import type { Recipe, RecipeStep, RecipeStepType, Channel } from '../types.js';
import type { CanvasExport } from './export.js';

/**
 * Convert a Canvas template into a VBX Recipe.
 */
export function importCanvasAsRecipe(canvas: CanvasExport): Recipe {
  const steps: RecipeStep[] = canvas.nodes.map((node, i) => {
    const step: RecipeStep = {
      name: node.label,
      type: mapCanvasNodeToStepType(node.type),
      input: i === 0 ? 'user_input' : `step_${i - 1}_output`,
      output: `step_${i}_output`,
    };

    if (node.agentType) step.agent = node.agentType;
    if (node.integration) step.integration = node.integration;
    if (node.action) step.action = node.action;
    if (node.channel) step.channel = node.channel as Channel;
    if (node.requiresReview) step.gate = 'human_approval';
    if (node.prompt) step.params = { prompt: node.prompt };

    return step;
  });

  return {
    name: canvas.name,
    description: canvas.description,
    steps,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapCanvasNodeToStepType(nodeType: string): RecipeStepType {
  const typeMap: Record<string, RecipeStepType> = {
    Agent: 'agent',
    Research: 'agent',
    Generate: 'agent',
    Analyze: 'agent',
    Review: 'agent',
    Integration: 'integration_read',
    Publish: 'artifact_delivery',
    Notification: 'notification',
    External: 'agent',
  };
  return typeMap[nodeType] ?? 'agent';
}
