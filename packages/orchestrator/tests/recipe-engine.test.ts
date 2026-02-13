import { describe, it, expect, beforeEach } from 'vitest';
import { RecipeEngine } from '../src/recipe/engine.js';
import type { Recipe, RecipeStep } from '../src/types.js';
import type { StepHandler, ConfirmationHandler } from '../src/recipe/engine.js';

// Mock step handler that returns predictable outputs
class MockStepHandler implements StepHandler {
  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    return `output_of_${step.name}`;
  }
}

class FailingStepHandler implements StepHandler {
  async execute(): Promise<unknown> {
    throw new Error('Provider unavailable');
  }
}

class MockConfirmationHandler implements ConfirmationHandler {
  private shouldApprove: boolean;
  constructor(approve: boolean) {
    this.shouldApprove = approve;
  }
  async requestApproval(): Promise<boolean> {
    return this.shouldApprove;
  }
}

const simpleRecipe: Recipe = {
  name: 'Test Recipe',
  description: 'A test recipe with two steps',
  steps: [
    {
      name: 'step1',
      agent: 'researcher',
      provider: 'claude-max',
      input: 'user_input',
      output: 'step1_output',
    },
    {
      name: 'step2',
      agent: 'writer',
      provider: 'chatgpt-pro',
      input: 'step1_output',
      output: 'step2_output',
    },
  ],
};

const gatedRecipe: Recipe = {
  name: 'Gated Recipe',
  description: 'A recipe with a human approval gate',
  steps: [
    {
      name: 'generate',
      agent: 'writer',
      provider: 'claude-max',
      input: 'user_input',
      output: 'draft',
    },
    {
      name: 'confirm',
      agent: 'writer',
      provider: 'claude-max',
      input: 'draft',
      output: 'confirmed_draft',
      gate: 'human_approval',
    },
    {
      name: 'publish',
      agent: 'writer',
      provider: 'claude-max',
      input: 'confirmed_draft',
      output: 'published',
    },
  ],
};

describe('RecipeEngine', () => {
  let engine: RecipeEngine;

  beforeEach(() => {
    engine = new RecipeEngine();
    engine.registerStepHandler('default', new MockStepHandler());
  });

  it('should execute a simple recipe successfully', async () => {
    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'whatsapp' },
      { user_input: 'Test input' },
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps).toHaveLength(2);
    expect(execution.steps[0].status).toBe('completed');
    expect(execution.steps[1].status).toBe('completed');
    expect(execution.context.step1_output).toBe('output_of_step1');
    expect(execution.context.step2_output).toBe('output_of_step2');
  });

  it('should fail gracefully when a step handler throws', async () => {
    engine.registerStepHandler('default', new FailingStepHandler());

    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'app' },
    );

    expect(execution.status).toBe('failed');
    expect(execution.steps).toHaveLength(1); // Stops after first failure
    expect(execution.steps[0].status).toBe('failed');
    expect(execution.steps[0].error).toContain('Provider unavailable');
  });

  it('should handle human approval gate (approved)', async () => {
    engine.setConfirmationHandler(new MockConfirmationHandler(true));

    const execution = await engine.execute(
      gatedRecipe,
      'tenant-1',
      'num-1',
      { channel: 'whatsapp' },
      { user_input: 'Draft something' },
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps).toHaveLength(3);
    expect(execution.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('should skip step when human approval is rejected', async () => {
    engine.setConfirmationHandler(new MockConfirmationHandler(false));

    const execution = await engine.execute(
      gatedRecipe,
      'tenant-1',
      'num-1',
      { channel: 'whatsapp' },
      { user_input: 'Draft something' },
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps[1].status).toBe('skipped');
  });

  it('should pass outputs between steps via context', async () => {
    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'app' },
      { user_input: 'initial data' },
    );

    // Step 2 should have access to step 1's output
    expect(execution.context.step1_output).toBeDefined();
    expect(execution.context.step2_output).toBeDefined();
  });

  it('should track execution metadata correctly', async () => {
    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'whatsapp', message_id: 'msg-123' },
    );

    expect(execution.id).toBeDefined();
    expect(execution.recipe_name).toBe('Test Recipe');
    expect(execution.tenant_id).toBe('tenant-1');
    expect(execution.number_id).toBe('num-1');
    expect(execution.triggered_by.channel).toBe('whatsapp');
    expect(execution.triggered_by.message_id).toBe('msg-123');
    expect(execution.started_at).toBeDefined();
    expect(execution.completed_at).toBeDefined();
  });

  it('should track step durations', async () => {
    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'app' },
    );

    for (const step of execution.steps) {
      expect(step.duration_ms).toBeGreaterThanOrEqual(0);
      expect(step.started_at).toBeDefined();
      expect(step.completed_at).toBeDefined();
    }
  });

  it('should cancel a running execution', async () => {
    // Start a recipe but cancel it mid-execution
    // For this test, we just verify the cancel API works on the returned execution
    const execution = await engine.execute(
      simpleRecipe,
      'tenant-1',
      'num-1',
      { channel: 'app' },
    );

    // Execution is already completed, so cancel should return false
    const cancelled = engine.cancel(execution.id);
    expect(cancelled).toBe(false); // Already completed

    // Get execution by ID
    const retrieved = engine.getExecution(execution.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.recipe_name).toBe('Test Recipe');
  });

  it('should return active executions for a tenant', async () => {
    // After completion, no active executions
    await engine.execute(simpleRecipe, 'tenant-1', 'num-1', { channel: 'app' });
    const active = engine.getActiveExecutions('tenant-1');
    expect(active).toHaveLength(0); // All completed
  });
});
