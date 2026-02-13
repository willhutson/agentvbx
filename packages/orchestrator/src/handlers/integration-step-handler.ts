/**
 * Integration step handlers — read from and write to external platforms.
 *
 * Handles recipe steps of type "integration_read" and "integration_write".
 * Connects to platform adapters (Google Drive, Monday.com, Notion, GitHub)
 * to read context or persist outputs.
 */

import { createLogger } from '../logger.js';
import type { RecipeStep } from '../types.js';
import type { StepHandler, RecipeExecution } from '../recipe/engine.js';

const logger = createLogger('integration-step-handler');

export interface IntegrationStepDeps {
  getAdapter: (platformId: string) => {
    list(params?: Record<string, unknown>): Promise<unknown[]>;
    read(id: string): Promise<unknown>;
    create(data: Record<string, unknown>): Promise<unknown>;
    update(id: string, data: Record<string, unknown>): Promise<unknown>;
  } | undefined;
}

/**
 * Reads data from an integration platform.
 */
export class IntegrationReadHandler implements StepHandler {
  constructor(private deps: IntegrationStepDeps) {}

  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown> {
    const platform = step.integration;
    if (!platform) throw new Error('integration field is required for integration_read steps');

    const adapter = this.deps.getAdapter(platform);
    if (!adapter) throw new Error(`Integration adapter not found: ${platform}`);

    const action = step.action ?? 'list';
    const params = {
      ...(step.params ?? {}),
      ...(context._params as Record<string, unknown> ?? {}),
    };

    logger.info({
      execution_id: execution.id,
      step: step.name,
      platform,
      action,
    }, 'Reading from integration');

    switch (action) {
      case 'list':
        return adapter.list(params);
      case 'read': {
        const id = params.id as string ?? context._input as string;
        if (!id) throw new Error('id is required for read action');
        return adapter.read(id);
      }
      default:
        throw new Error(`Unknown integration_read action: ${action}`);
    }
  }
}

/**
 * Writes data to an integration platform.
 */
export class IntegrationWriteHandler implements StepHandler {
  constructor(private deps: IntegrationStepDeps) {}

  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown> {
    const platform = step.integration;
    if (!platform) throw new Error('integration field is required for integration_write steps');

    const adapter = this.deps.getAdapter(platform);
    if (!adapter) throw new Error(`Integration adapter not found: ${platform}`);

    const action = step.action ?? 'create';
    const params = {
      ...(step.params ?? {}),
      ...(context._params as Record<string, unknown> ?? {}),
    };

    const input = context._input;

    logger.info({
      execution_id: execution.id,
      step: step.name,
      platform,
      action,
    }, 'Writing to integration');

    switch (action) {
      case 'create': {
        const name = params.name as string ?? step.name;
        const content = typeof input === 'string' ? input
          : typeof input === 'object' && input && 'text' in (input as Record<string, unknown>)
            ? (input as Record<string, unknown>).text as string
            : JSON.stringify(input);

        return adapter.create({
          name,
          content,
          parent_id: params.parent_id as string,
          mime_type: params.mime_type as string,
          fields: params,
        });
      }
      case 'update': {
        const id = params.id as string;
        if (!id) throw new Error('id is required for update action');
        const data = typeof input === 'object' ? (input as Record<string, unknown>) : { value: input };
        return adapter.update(id, data);
      }
      default:
        throw new Error(`Unknown integration_write action: ${action}`);
    }
  }
}
