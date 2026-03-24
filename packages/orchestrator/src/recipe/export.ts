/**
 * Export a VBX Recipe to a format the ERP can import as a Canvas template.
 * Called by the API when ERP requests recipe sync (Contract E1).
 */

import { randomUUID } from 'node:crypto';
import type { Recipe, RecipeStep, RecipeStepType, Channel } from '../types.js';

// ─── Canvas Export Types ────────────────────────────────────────────────────

export interface CanvasNode {
  id: string;
  type: string;
  label: string;
  agentType?: string;
  integration?: string;
  action?: string;
  prompt?: string;
  requiresReview: boolean;
  channel?: Channel;
}

export interface CanvasEdge {
  source: number;
  target: number;
}

export interface CanvasParameter {
  key: string;
  label: string;
  type: string;
  required: boolean;
  nodeIndex: number;
}

export interface CanvasExport {
  name: string;
  description: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  parameters: CanvasParameter[];
}

// ─── Export Function ────────────────────────────────────────────────────────

/**
 * Convert a VBX Recipe to Canvas format for ERP import.
 */
export function exportRecipeAsCanvas(recipe: Recipe): CanvasExport {
  const nodes: CanvasNode[] = recipe.steps.map((step) => ({
    id: randomUUID(),
    type: mapStepTypeToCanvasNode(step),
    label: step.name,
    agentType: step.agent,
    integration: step.integration,
    action: step.action,
    prompt: (step.params?.prompt ?? step.params?.instruction) as string | undefined,
    requiresReview: step.gate === 'human_approval',
    channel: step.channel,
  }));

  // VBX recipes are sequential — linear edge chain
  const edges: CanvasEdge[] = nodes.slice(0, -1).map((_, i) => ({
    source: i,
    target: i + 1,
  }));

  return {
    name: recipe.name,
    description: recipe.description,
    nodes,
    edges,
    parameters: extractParameters(recipe),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapStepTypeToCanvasNode(step: RecipeStep): string {
  const stepType = step.type as RecipeStepType | undefined;

  if (stepType === 'agent' || (!stepType && step.agent)) {
    return mapAgentToNodeType(step.agent);
  }
  if (stepType === 'integration_read' || stepType === 'integration_write') return 'Integration';
  if (stepType === 'artifact_delivery') return 'Publish';
  if (stepType === 'notification') return 'Notification';
  return 'External';
}

function mapAgentToNodeType(agent?: string): string {
  if (!agent) return 'Agent';
  // Map known agent names to canvas node types
  const agentMap: Record<string, string> = {
    researcher: 'Research',
    writer: 'Generate',
    strategist: 'Analyze',
    assistant: 'Agent',
    'creative-director': 'Review',
  };
  return agentMap[agent] ?? 'Agent';
}

function extractParameters(recipe: Recipe): CanvasParameter[] {
  const params: CanvasParameter[] = [];

  recipe.steps.forEach((step, i) => {
    // Steps that take user_input or initial input are parameter sources
    const input = Array.isArray(step.input) ? step.input : [step.input];
    for (const inp of input) {
      if (inp === 'user_input' || inp === 'event_data' || inp === 'voice_audio') {
        params.push({
          key: inp,
          label: inp.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          type: inp === 'voice_audio' ? 'audio' : 'text',
          required: true,
          nodeIndex: i,
        });
      }
    }
  });

  return params;
}
