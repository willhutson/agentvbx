/**
 * House Channel — AGENTVBX's system-level WhatsApp presence.
 *
 * Every user gets a dedicated WhatsApp contact from day one.
 * The House Channel handles:
 * - 2FA verification (signup, login, sensitive actions)
 * - Personalized broadcasts (new models, trending recipes, platform updates)
 * - Discovery (users message it to ask questions, get recommendations)
 * - Re-engagement (gentle nudges for dormant users)
 *
 * Broadcasts run through a relevance filter — no spam.
 */

import { createLogger } from './logger.js';

const logger = createLogger('house-channel');

// ─── Types ──────────────────────────────────────────────────────────────────

export type BroadcastCategory =
  | 'model_alert'
  | 'trending_recipe'
  | 'gap_recommendation'
  | 'platform_update'
  | 'community_highlight'
  | 're_engagement';

export interface UserProfile {
  id: string;
  phone_number: string;
  connected_tools: string[];
  deployed_recipes: string[];
  tier: string;
  usage_frequency: 'daily' | 'weekly' | 'monthly' | 'dormant';
  category_affinity: Record<string, number>; // category → weight
  muted_categories: BroadcastCategory[];
  max_messages_per_week: number;
  quiet_hours: { start: number; end: number; timezone: string };
  messages_sent_this_week: number;
  full_mute: boolean;
}

export interface Broadcast {
  id: string;
  category: BroadcastCategory;
  title: string;
  body: string;
  is_promoted: boolean;
  promoted_provider?: string;
  relevance_tags: string[];
  required_tools?: string[];
  target_tiers?: string[];
}

export interface BroadcastResult {
  broadcast_id: string;
  user_id: string;
  sent: boolean;
  reason?: string;
  relevance_score: number;
}

// ─── House Channel ──────────────────────────────────────────────────────────

export class HouseChannel {
  private sender?: (to: string, message: string) => Promise<void>;

  /**
   * Set the message sender function (WhatsApp client or Telnyx WABA).
   */
  setSender(sender: (to: string, message: string) => Promise<void>): void {
    this.sender = sender;
  }

  /**
   * Send a 2FA verification code.
   */
  async sendVerification(phoneNumber: string, code: string): Promise<void> {
    if (!this.sender) throw new Error('House Channel sender not configured');

    const message = [
      `Your AGENTVBX verification code: ${code}`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request this, ignore this message.',
    ].join('\n');

    await this.sender(phoneNumber, message);
    logger.info({ to: phoneNumber }, 'Verification code sent');
  }

  /**
   * Send a personalized broadcast to a user.
   * Returns whether the message was sent and the relevance score.
   */
  async sendBroadcast(broadcast: Broadcast, user: UserProfile): Promise<BroadcastResult> {
    const score = this.scoreRelevance(broadcast, user);
    const result: BroadcastResult = {
      broadcast_id: broadcast.id,
      user_id: user.id,
      sent: false,
      relevance_score: score,
    };

    // Filter checks
    if (user.full_mute) {
      result.reason = 'user has full mute enabled';
      return result;
    }

    if (user.muted_categories.includes(broadcast.category)) {
      result.reason = `category ${broadcast.category} muted by user`;
      return result;
    }

    if (user.messages_sent_this_week >= user.max_messages_per_week) {
      result.reason = 'weekly message cap reached';
      return result;
    }

    if (score < 30) {
      result.reason = `relevance score ${score} below threshold`;
      return result;
    }

    if (this.isQuietHours(user)) {
      result.reason = 'quiet hours';
      return result;
    }

    // Build the message
    const message = this.formatBroadcast(broadcast, user);

    if (!this.sender) {
      result.reason = 'sender not configured';
      return result;
    }

    try {
      await this.sender(user.phone_number, message);
      result.sent = true;
      logger.info({
        broadcast: broadcast.id,
        user: user.id,
        score,
        promoted: broadcast.is_promoted,
      }, 'Broadcast sent');
    } catch (err) {
      result.reason = `send failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error({ err, broadcast: broadcast.id, user: user.id }, 'Failed to send broadcast');
    }

    return result;
  }

  /**
   * Score relevance (0-100) for a broadcast × user pair.
   */
  scoreRelevance(broadcast: Broadcast, user: UserProfile): number {
    let score = 0;

    // Tool overlap — user's tools vs broadcast's relevance tags
    const toolOverlap = broadcast.relevance_tags.filter((t) =>
      user.connected_tools.includes(t),
    ).length;
    score += Math.min(toolOverlap * 15, 40);

    // Category affinity
    for (const tag of broadcast.relevance_tags) {
      score += (user.category_affinity[tag] ?? 0) * 10;
    }

    // Usage frequency bonus
    const freqBonus: Record<string, number> = { daily: 20, weekly: 15, monthly: 5, dormant: 0 };
    score += freqBonus[user.usage_frequency] ?? 0;

    // Re-engagement gets a boost for dormant users
    if (broadcast.category === 're_engagement' && user.usage_frequency === 'dormant') {
      score += 25;
    }

    // Tier targeting
    if (broadcast.target_tiers && !broadcast.target_tiers.includes(user.tier)) {
      score -= 20;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Format a broadcast message with user personalization.
   */
  private formatBroadcast(broadcast: Broadcast, user: UserProfile): string {
    const lines: string[] = [];

    // Promoted label (always transparent)
    if (broadcast.is_promoted && broadcast.promoted_provider) {
      lines.push(`[Featured Partner: ${broadcast.promoted_provider}]`);
      lines.push('');
    }

    lines.push(broadcast.title);
    lines.push('');
    lines.push(broadcast.body);

    // Add tools the user already has
    if (broadcast.required_tools) {
      const has = broadcast.required_tools.filter((t) => user.connected_tools.includes(t));
      const missing = broadcast.required_tools.filter((t) => !user.connected_tools.includes(t));

      if (has.length > 0) {
        lines.push('');
        lines.push(`Tools you have: ${has.join(', ')}`);
      }
      if (missing.length > 0) {
        lines.push(`Tools needed: ${missing.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Check if it's currently quiet hours for the user.
   */
  private isQuietHours(user: UserProfile): boolean {
    // Simplified — in production this would use timezone-aware date math
    const now = new Date();
    const hour = now.getHours(); // TODO: convert to user timezone
    return hour >= user.quiet_hours.start || hour < user.quiet_hours.end;
  }
}
