/**
 * Recipe execution engine.
 *
 * Recipes are multi-step, multi-tool workflows defined in YAML.
 * The engine executes steps sequentially, passing outputs between steps,
 * and supports confirmation gates (human-in-the-loop).
 *
 * Design decisions:
 * - Steps execute sequentially (not parallel) because most recipes have data dependencies
 * - Each step can use a different agent/provider
 * - Confirmation gates pause execution until the user approves
 * - Failed steps trigger provider fallback within the step's agent
 * - The full execution context is logged for debugging and Genie intelligence
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import type { Recipe, RecipeStep, Message, Channel } from '../types.js';

const logger = createLogger('recipe-engine');

// ─── Execution Types ────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
  step_name: string;
  status: StepStatus;
  output?: unknown;
  error?: string;
  provider_used?: string;
  duration_ms: number;
  started_at: string;
  completed_at?: string;
}

export interface RecipeExecution {
  id: string;
  recipe_name: string;
  tenant_id: string;
  number_id: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  steps: StepResult[];
  context: Record<string, unknown>;
  started_at: string;
  completed_at?: string;
  triggered_by: {
    channel: Channel;
    message_id?: string;
  };
}

// ─── Step Handler Interface ─────────────────────────────────────────────────

export interface StepHandler {
  /**
   * Execute a recipe step with the given context.
   * Returns the step output that becomes available to subsequent steps.
   */
  execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown>;
}

export interface ConfirmationHandler {
  /**
   * Request human approval for a gated step.
   * Returns true if approved, false if rejected.
   */
  requestApproval(
    step: RecipeStep,
    data: unknown,
    execution: RecipeExecution,
  ): Promise<boolean>;
}

export interface NotificationHandler {
  /**
   * Send a notification about recipe progress or completion.
   */
  notify(
    message: string,
    execution: RecipeExecution,
    channel?: Channel,
  ): Promise<void>;
}

// ─── Recipe Engine ──────────────────────────────────────────────────────────

export class RecipeEngine {
  private executions: Map<string, RecipeExecution> = new Map();
  private stepHandlers: Map<string, StepHandler> = new Map();
  private confirmationHandler?: ConfirmationHandler;
  private notificationHandler?: NotificationHandler;

  /**
   * Register a step handler for a specific step type or agent.
   */
  registerStepHandler(type: string, handler: StepHandler): void {
    this.stepHandlers.set(type, handler);
    logger.info({ type }, 'Step handler registered');
  }

  /**
   * Set the confirmation handler for human-in-the-loop gates.
   */
  setConfirmationHandler(handler: ConfirmationHandler): void {
    this.confirmationHandler = handler;
  }

  /**
   * Set the notification handler for progress updates.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Execute a recipe from start to finish.
   */
  async execute(
    recipe: Recipe,
    tenantId: string,
    numberId: string,
    triggeredBy: { channel: Channel; message_id?: string },
    initialInput?: Record<string, unknown>,
  ): Promise<RecipeExecution> {
    const execution: RecipeExecution = {
      id: uuid(),
      recipe_name: recipe.name,
      tenant_id: tenantId,
      number_id: numberId,
      status: 'running',
      steps: [],
      context: { ...initialInput },
      started_at: new Date().toISOString(),
      triggered_by: triggeredBy,
    };

    this.executions.set(execution.id, execution);
    logger.info({ id: execution.id, recipe: recipe.name, tenant: tenantId }, 'Recipe execution started');

    try {
      for (const step of recipe.steps) {
        const result = await this.executeStep(step, execution);
        execution.steps.push(result);

        if (result.status === 'failed') {
          execution.status = 'failed';
          logger.error({ id: execution.id, step: step.name, error: result.error }, 'Recipe step failed');
          await this.notificationHandler?.notify(
            `Recipe "${recipe.name}" failed at step "${step.name}": ${result.error}`,
            execution,
          );
          break;
        }

        // Store step output in context for subsequent steps
        if (result.output !== undefined) {
          execution.context[step.output] = result.output;
        }
      }

      if (execution.status === 'running') {
        execution.status = 'completed';
        execution.completed_at = new Date().toISOString();
        logger.info({ id: execution.id, recipe: recipe.name }, 'Recipe execution completed');
        await this.notificationHandler?.notify(
          `Recipe "${recipe.name}" completed successfully`,
          execution,
        );
      }
    } catch (err) {
      execution.status = 'failed';
      execution.completed_at = new Date().toISOString();
      logger.error({ err, id: execution.id, recipe: recipe.name }, 'Recipe execution error');
    }

    return execution;
  }

  /**
   * Execute a single recipe step.
   */
  private async executeStep(step: RecipeStep, execution: RecipeExecution): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    logger.info({ execution_id: execution.id, step: step.name }, 'Executing step');

    // Resolve inputs from execution context
    const resolvedInput = this.resolveInput(step.input, execution.context);

    // Check for confirmation gate BEFORE execution
    if (step.gate === 'human_approval' && this.confirmationHandler) {
      execution.status = 'paused';
      const approved = await this.confirmationHandler.requestApproval(step, resolvedInput, execution);
      execution.status = 'running';

      if (!approved) {
        return {
          step_name: step.name,
          status: 'skipped',
          duration_ms: Date.now() - startMs,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        };
      }
    }

    // Find the appropriate handler
    const handlerKey = step.type ?? step.agent ?? 'default';
    const handler = this.stepHandlers.get(handlerKey) ?? this.stepHandlers.get('default');

    if (!handler) {
      return {
        step_name: step.name,
        status: 'failed',
        error: `No handler registered for step type: ${handlerKey}`,
        duration_ms: Date.now() - startMs,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    }

    try {
      // Inject resolved input into context for the handler
      const stepContext = { ...execution.context, _input: resolvedInput, _params: step.params };
      const output = await handler.execute(step, stepContext, execution);

      return {
        step_name: step.name,
        status: 'completed',
        output,
        provider_used: step.provider,
        duration_ms: Date.now() - startMs,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        step_name: step.name,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        provider_used: step.provider,
        duration_ms: Date.now() - startMs,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    }
  }

  /**
   * Resolve step input references from the execution context.
   * Input can be a string key or array of keys referencing previous step outputs.
   */
  private resolveInput(input: string | string[], context: Record<string, unknown>): unknown {
    if (Array.isArray(input)) {
      return input.map((key) => context[key]);
    }
    return context[input] ?? input;
  }

  /**
   * Get execution status by ID.
   */
  getExecution(id: string): RecipeExecution | undefined {
    return this.executions.get(id);
  }

  /**
   * Get all active executions for a tenant.
   */
  getActiveExecutions(tenantId: string): RecipeExecution[] {
    return Array.from(this.executions.values()).filter(
      (e) => e.tenant_id === tenantId && (e.status === 'running' || e.status === 'paused'),
    );
  }

  /**
   * Cancel a running execution.
   */
  cancel(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'running') return false;
    execution.status = 'cancelled';
    execution.completed_at = new Date().toISOString();
    logger.info({ id: executionId }, 'Recipe execution cancelled');
    return true;
  }
}
