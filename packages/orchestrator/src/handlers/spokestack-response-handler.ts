/**
 * Handles inbound messages that are responses to SpokeStack review requests.
 *
 * Detection: If a message is a reply to a message with metadata.type === "review_request"
 * or metadata.type === "execution_question", route it here.
 *
 * For review requests: Parse APPROVE/REVISE/SKIP → call spokestack.sendReviewCallback()
 * For execution questions: Forward raw answer → call spokestack.sendQuestionCallback()
 */

import { createLogger } from '../logger.js';
import type { Message } from '../types.js';

const logger = createLogger('spokestack-response');

// Response patterns — order matters, first match wins
const REVIEW_PATTERNS: Array<[string, RegExp]> = [
  ['REJECTED', /\b(reject|rejected|no|nope|cancel|stop)\b|👎/i],
  ['REVISION_REQUESTED', /\b(revise|revision|change|edit|update|fix|tweak)\b/i],
  ['SKIPPED', /\b(skip|skipped|later|defer|pass)\b/i],
  ['APPROVED', /\b(approve|approved|yes|lgtm|looks good|go)\b|👍/i],
];

export interface SpokeStackAdapterLike {
  sendReviewCallback(params: {
    canvasRunId: string;
    canvasNodeId: string;
    decision: 'APPROVED' | 'REVISION_REQUESTED' | 'REJECTED' | 'SKIPPED';
    notes?: string;
    respondedVia: string;
    respondedByPhone: string;
  }): Promise<void>;

  sendQuestionCallback(params: {
    canvasRunId: string;
    canvasNodeId: string;
    answer: string;
    respondedVia: string;
    respondedByPhone: string;
  }): Promise<void>;
}

export class SpokeStackResponseHandler {
  constructor(private adapter: SpokeStackAdapterLike) {}

  /**
   * Check if a message is a reply to a SpokeStack notification.
   */
  isReplyToSpokeStack(message: Message, original: Message): boolean {
    if (!message.reply_to) return false;
    if (!original.metadata) return false;
    const metaType = String(original.metadata.type ?? '');
    return metaType === 'review_request' || metaType === 'execution_question';
  }

  /**
   * Handle the response — parse intent and callback to ERP.
   */
  async handleResponse(message: Message, originalMessage: Message): Promise<void> {
    const meta = originalMessage.metadata as Record<string, unknown>;

    if (meta.type === 'review_request') {
      const decision = this.parseReviewDecision(message.text);
      const notes = decision === 'REVISION_REQUESTED' ? message.text : undefined;

      logger.info(
        { node: meta.canvas_node_id, decision, from: message.from },
        'Routing review response to SpokeStack',
      );

      await this.adapter.sendReviewCallback({
        canvasRunId: String(meta.canvas_run_id),
        canvasNodeId: String(meta.canvas_node_id),
        decision: decision as 'APPROVED' | 'REVISION_REQUESTED' | 'REJECTED' | 'SKIPPED',
        notes,
        respondedVia: message.channel,
        respondedByPhone: message.from,
      });
    } else if (meta.type === 'execution_question') {
      logger.info(
        { node: meta.canvas_node_id, from: message.from },
        'Routing question response to SpokeStack',
      );

      await this.adapter.sendQuestionCallback({
        canvasRunId: String(meta.canvas_run_id),
        canvasNodeId: String(meta.canvas_node_id),
        answer: message.text,
        respondedVia: message.channel,
        respondedByPhone: message.from,
      });
    }
  }

  /**
   * Parse the review decision from message text.
   */
  parseReviewDecision(text: string): string {
    const trimmed = text.trim();
    for (const [decision, pattern] of REVIEW_PATTERNS) {
      if (pattern.test(trimmed)) {
        return decision;
      }
    }
    // Default: long messages are revision notes, short ones are approval
    return trimmed.length > 20 ? 'REVISION_REQUESTED' : 'APPROVED';
  }
}
