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

// ─── Creative Review Notification Templates ─────────────────────────────────

interface CreativeReviewData {
  nodeTitle?: string;
  clientName?: string;
  reviewUrl?: string;
  previewUrl?: string;
  editorUrl?: string;
  playerUrl?: string;
  numVariants?: number;
  duration?: number;
  aspectRatio?: string;
  sceneCount?: number;
  slideCount?: number;
}

const CREATIVE_REVIEW_TEMPLATES: Record<string, (data: CreativeReviewData) => string> = {
  image_variants: (data) =>
    `🎨 ${data.nodeTitle ?? 'Image Review'}\n\n` +
    `${data.numVariants ?? 3} image options are ready for ${data.clientName ?? 'review'}.\n` +
    `👀 Review here: ${data.reviewUrl ?? ''}\n\n` +
    `Reply with the number (1-${data.numVariants ?? 3}) to select, or REVISE for new options.`,

  video_ready: (data) =>
    `🎬 Video ready: ${data.nodeTitle ?? 'Video Review'}\n\n` +
    `📱 ${data.duration ?? '?'}s ${data.aspectRatio ?? '16:9'} video for ${data.clientName ?? 'review'}\n` +
    `▶️ Preview: ${data.previewUrl ?? ''}\n\n` +
    `Reply APPROVE to publish, REVISE for changes, or SKIP.`,

  composition_ready: (data) =>
    `🎥 Final cut ready: ${data.nodeTitle ?? 'Composition Review'}\n\n` +
    `${data.sceneCount ?? '?'} scenes, ${data.duration ?? '?'}s total\n` +
    `🎵 Music + voiceover included\n` +
    `▶️ Preview: ${data.previewUrl ?? ''}\n\n` +
    `Reply APPROVE, REVISE, or SKIP.`,

  deck_ready: (data) =>
    `📊 Presentation ready: ${data.nodeTitle ?? 'Deck Review'}\n\n` +
    `${data.slideCount ?? '?'} slides for ${data.clientName ?? 'review'}\n` +
    `✏️ Edit: ${data.editorUrl ?? ''}\n` +
    `👁️ View: ${data.playerUrl ?? ''}\n\n` +
    `Reply APPROVE or REVISE.`,
};

/**
 * Format a creative review notification using the appropriate template.
 * Falls back to raw text if no matching template or asset_type.
 */
export function formatCreativeReview(
  assetType: string,
  data: CreativeReviewData,
): string | null {
  const template = CREATIVE_REVIEW_TEMPLATES[assetType];
  if (!template) return null;
  return template(data);
}

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
      const decision = this.parseReviewDecision(message.text, meta);
      const variantSelection = this.parseVariantSelection(message.text);
      let notes = decision === 'REVISION_REQUESTED' ? message.text : undefined;
      if (variantSelection !== null) {
        notes = `selected_variant:${variantSelection}`;
      }

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
   * Supports variant selection (e.g., "1", "2", "3") for creative reviews.
   */
  parseReviewDecision(text: string, meta?: Record<string, unknown>): string {
    const trimmed = text.trim();

    // Check for variant selection (numeric reply for creative reviews)
    if (meta?.asset_type && /^\d+$/.test(trimmed)) {
      return 'APPROVED';
    }

    for (const [decision, pattern] of REVIEW_PATTERNS) {
      if (pattern.test(trimmed)) {
        return decision;
      }
    }
    // Default: long messages are revision notes, short ones are approval
    return trimmed.length > 20 ? 'REVISION_REQUESTED' : 'APPROVED';
  }

  /**
   * Extract the selected variant number from a numeric reply.
   */
  parseVariantSelection(text: string): number | null {
    const match = text.trim().match(/^(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
}
