/**
 * Artifact delivery step handler.
 *
 * Recipe step handler that captures step output as an artifact,
 * uploads to cloud, and sends notification.
 */

import { createLogger } from '../logger.js';
import type { RecipeStep, CloudProvider, ArtifactDestinations } from '../types.js';
import type { StepHandler, RecipeExecution } from '../recipe/engine.js';
import type { ArtifactManager } from './manager.js';

const logger = createLogger('artifact-delivery');

export interface ArtifactDeliveryDeps {
  artifactManager: ArtifactManager;
  getTenantDestinations: (tenantId: string) => ArtifactDestinations | undefined;
}

export class ArtifactDeliveryHandler implements StepHandler {
  constructor(private deps: ArtifactDeliveryDeps) {}

  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown> {
    const input = context._input;
    const params = (context._params as Record<string, unknown>) ?? {};

    // Extract content from previous step output
    let content: string;
    let filename: string;

    if (typeof input === 'string') {
      content = input;
      filename = (params.filename as string) ?? `${step.name}.txt`;
    } else if (typeof input === 'object' && input) {
      const obj = input as Record<string, unknown>;
      content = (obj.text as string) ?? JSON.stringify(input, null, 2);
      filename = (params.filename as string) ?? (obj.filename as string) ?? `${step.name}.txt`;
    } else {
      content = String(input);
      filename = (params.filename as string) ?? `${step.name}.txt`;
    }

    logger.info({
      execution_id: execution.id,
      step: step.name,
      filename,
      content_length: content.length,
    }, 'Delivering artifact');

    const destinations = this.deps.getTenantDestinations(execution.tenant_id);

    const artifact = await this.deps.artifactManager.deliver(
      {
        filename,
        content,
        file_type: params.mime_type as string,
        tenant_id: execution.tenant_id,
        number_id: execution.number_id,
        recipe_id: execution.id,
        recipe_step: step.name,
        tools_used: params.tools_used as string[],
        tags: params.tags as string[],
      },
      destinations ?? {
        defaults: { documents: 'google_drive' as CloudProvider },
        notifications: { primary: 'whatsapp' as const, include_thumbnail: true, include_preview_link: true },
      },
      params.notify_to as string,
    );

    return {
      artifact_id: artifact.id,
      filename: artifact.filename,
      local_path: artifact.local_path,
      cloud_url: artifact.cloud_url,
      cloud_provider: artifact.cloud_provider,
      size_bytes: artifact.size_bytes,
    };
  }
}
