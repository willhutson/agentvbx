/**
 * Notification step handler — sends notifications via channels.
 *
 * Handles recipe steps of type "notification".
 * Can send via WhatsApp, SMS, or app notifications.
 */

import { createLogger } from '../logger.js';
import type { RecipeStep, Channel } from '../types.js';
import type { StepHandler, RecipeExecution } from '../recipe/engine.js';

const logger = createLogger('notification-handler');

export type NotificationSender = (
  channel: Channel,
  to: string,
  message: string,
  metadata?: Record<string, unknown>,
) => Promise<void>;

export class NotificationStepHandler implements StepHandler {
  constructor(private sender: NotificationSender) {}

  async execute(
    step: RecipeStep,
    context: Record<string, unknown>,
    execution: RecipeExecution,
  ): Promise<unknown> {
    const channel = step.channel ?? 'whatsapp';
    const params = context._params as Record<string, unknown> ?? {};
    const input = context._input;

    // Build notification text
    let text: string;
    if (typeof input === 'string') {
      text = input;
    } else if (typeof input === 'object' && input && 'text' in (input as Record<string, unknown>)) {
      text = (input as Record<string, unknown>).text as string;
    } else {
      text = `Recipe "${execution.recipe_name}" step "${step.name}" completed.`;
    }

    // Template substitution
    if (params.template) {
      text = (params.template as string).replace(/\{input\}/g, text);
    }

    const to = params.to as string ?? 'tenant_default';

    logger.info({
      execution_id: execution.id,
      step: step.name,
      channel,
      to,
      preview: text.substring(0, 100),
    }, 'Sending notification');

    await this.sender(channel, to, text, {
      recipe: execution.recipe_name,
      step: step.name,
      execution_id: execution.id,
    });

    return { sent: true, channel, to, text_preview: text.substring(0, 200) };
  }
}
