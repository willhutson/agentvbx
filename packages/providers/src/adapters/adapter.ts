/**
 * Unified provider adapter interface.
 *
 * All provider interactions go through this interface, whether they're
 * browser-automated (Claude, ChatGPT), API-based (Exa, Deepgram), or
 * local (Ollama). This ensures consistent error handling, logging,
 * and fallback behavior across all providers.
 */

import { createLogger } from '../logger.js';

const logger = createLogger('provider-adapter');

// ─── Adapter Interface ──────────────────────────────────────────────────────

export interface AdapterRequest {
  prompt: string;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
  attachments?: Array<{ type: string; data: string | Buffer; filename?: string }>;
  metadata?: Record<string, unknown>;
}

export interface AdapterResponse {
  text: string;
  provider_id: string;
  model?: string;
  tokens_used?: number;
  latency_ms: number;
  artifacts?: Array<{
    type: string;
    data: string | Buffer;
    filename?: string;
    mime_type?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  /** Unique provider ID (matches registry). */
  readonly id: string;

  /** Human-readable name. */
  readonly name: string;

  /** Check if the provider is currently available. */
  isAvailable(): Promise<boolean>;

  /** Send a request and get a response. */
  send(request: AdapterRequest): Promise<AdapterResponse>;

  /** Initialize the adapter (e.g., start browser session, verify API key). */
  initialize(): Promise<void>;

  /** Clean up resources (e.g., close browser, disconnect). */
  destroy(): Promise<void>;
}

// ─── Ollama Adapter ─────────────────────────────────────────────────────────

export interface OllamaConfig {
  host: string;
  port: number;
  defaultModel: string;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama (Local)';
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: OllamaConfig) {
    this.baseUrl = `http://${config.host}:${config.port}`;
    this.defaultModel = config.defaultModel;
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn('Ollama is not running. Local model routing will be unavailable.');
    } else {
      logger.info({ model: this.defaultModel }, 'Ollama adapter initialized');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const model = (request.metadata?.model as string) ?? this.defaultModel;

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            ...(request.system_prompt
              ? [{ role: 'system', content: request.system_prompt }]
              : []),
            { role: 'user', content: request.prompt },
          ],
          stream: false,
          options: {
            temperature: request.temperature ?? 0.7,
            num_predict: request.max_tokens ?? 2048,
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as {
        message: { content: string };
        eval_count?: number;
        prompt_eval_count?: number;
      };

      return {
        text: data.message.content,
        provider_id: this.id,
        model,
        tokens_used: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
        latency_ms: Date.now() - startMs,
      };
    } catch (err) {
      logger.error({ err, model }, 'Ollama request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    // Nothing to clean up for Ollama
  }

  /**
   * List available models from Ollama.
   */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json() as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Generate embeddings using Ollama.
   */
  async embed(text: string, model = 'nomic-embed-text'): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }
}

// ─── Provider Gap (Demand Driver) ───────────────────────────────────────────

/**
 * Represents a provider a user needs but doesn't have connected.
 * This is the demand driver — when a recipe or fallback chain requires a
 * provider the user hasn't set up, this surfaces the signup opportunity.
 */
export interface ProviderGap {
  /** The provider ID that was needed (e.g., 'session:claude'). */
  provider_id: string;
  /** Why it was needed. */
  reason: 'recipe_requirement' | 'fallback_exhausted' | 'preferred_unavailable';
  /** Signup URL (with affiliate tracking). */
  signup_url?: string;
  /** The fallback provider that was used instead (if any). */
  fell_back_to?: string;
}

export type GapEventHandler = (gap: ProviderGap) => void;

// ─── Adapter Manager ────────────────────────────────────────────────────────

/**
 * Manages all provider adapters and handles fallback between them.
 *
 * Extended with provider gap detection for the demand driver layer:
 * when a session-based provider is unavailable (user hasn't connected it),
 * the gap is recorded and surfaced to the UI so the user can sign up
 * via affiliate link or connect their existing subscription.
 */
export class AdapterManager {
  private adapters: Map<string, ProviderAdapter> = new Map();
  private gapHandlers: GapEventHandler[] = [];
  private recentGaps: ProviderGap[] = [];

  /**
   * Register a provider adapter.
   */
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
    logger.info({ id: adapter.id, name: adapter.name }, 'Adapter registered');
  }

  /**
   * Get an adapter by provider ID.
   */
  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Subscribe to provider gap events (for demand driver / affiliate hooks).
   */
  onProviderGap(handler: GapEventHandler): void {
    this.gapHandlers.push(handler);
  }

  /**
   * Get recent provider gaps (for UI display).
   */
  getRecentGaps(): ProviderGap[] {
    return [...this.recentGaps];
  }

  /**
   * Clear recorded gaps (e.g., after user connects a provider).
   */
  clearGaps(): void {
    this.recentGaps = [];
  }

  /**
   * Check which providers from a list are missing / unavailable.
   * Used by marketplace to show "this recipe needs X" before install.
   */
  async detectGaps(requiredProviders: string[]): Promise<ProviderGap[]> {
    const gaps: ProviderGap[] = [];

    for (const providerId of requiredProviders) {
      const adapter = this.adapters.get(providerId);

      if (!adapter) {
        gaps.push({
          provider_id: providerId,
          reason: 'recipe_requirement',
          signup_url: this.getSignupUrl(providerId),
        });
        continue;
      }

      try {
        const available = await adapter.isAvailable();
        if (!available) {
          gaps.push({
            provider_id: providerId,
            reason: 'recipe_requirement',
            signup_url: this.getSignupUrl(providerId),
          });
        }
      } catch {
        gaps.push({
          provider_id: providerId,
          reason: 'recipe_requirement',
          signup_url: this.getSignupUrl(providerId),
        });
      }
    }

    return gaps;
  }

  /**
   * Send a request to a provider with automatic fallback.
   * Tries each provider in the priority list until one succeeds.
   * Records provider gaps when session-based providers are unavailable.
   */
  async sendWithFallback(
    request: AdapterRequest,
    providerPriority: string[],
  ): Promise<AdapterResponse & { fallbacks_tried: string[]; provider_gaps: ProviderGap[] }> {
    const tried: string[] = [];
    const gaps: ProviderGap[] = [];

    for (const providerId of providerPriority) {
      const adapter = this.adapters.get(providerId);
      if (!adapter) {
        // Provider not registered at all — record as gap if it's a session provider
        if (providerId.startsWith('session:')) {
          const gap: ProviderGap = {
            provider_id: providerId,
            reason: 'preferred_unavailable',
            signup_url: this.getSignupUrl(providerId),
          };
          gaps.push(gap);
          this.recordGap(gap);
        }
        logger.debug({ providerId }, 'Adapter not found, skipping');
        continue;
      }

      try {
        const available = await adapter.isAvailable();
        if (!available) {
          tried.push(providerId);

          // Record gap for session providers (user needs to log in or sign up)
          if (providerId.startsWith('session:')) {
            const gap: ProviderGap = {
              provider_id: providerId,
              reason: 'preferred_unavailable',
              signup_url: this.getSignupUrl(providerId),
            };
            gaps.push(gap);
            this.recordGap(gap);
          }

          logger.info({ providerId }, 'Provider unavailable, trying next');
          continue;
        }

        const response = await adapter.send(request);

        // If we had gaps, note what we fell back to
        for (const gap of gaps) {
          gap.fell_back_to = providerId;
        }

        return { ...response, fallbacks_tried: tried, provider_gaps: gaps };
      } catch (err) {
        tried.push(providerId);
        logger.warn({ err, providerId }, 'Provider failed, trying next');
      }
    }

    // All failed — record the entire chain as exhausted
    if (gaps.length === 0) {
      for (const providerId of providerPriority) {
        if (providerId.startsWith('session:')) {
          const gap: ProviderGap = {
            provider_id: providerId,
            reason: 'fallback_exhausted',
            signup_url: this.getSignupUrl(providerId),
          };
          gaps.push(gap);
          this.recordGap(gap);
        }
      }
    }

    throw new Error(`All providers failed: ${providerPriority.join(', ')}. Tried: ${tried.join(', ')}`);
  }

  /**
   * Initialize all registered adapters.
   */
  async initializeAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.initialize();
      } catch (err) {
        logger.error({ err, id }, 'Failed to initialize adapter');
      }
    }
  }

  /**
   * Destroy all registered adapters.
   */
  async destroyAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.destroy();
      } catch (err) {
        logger.error({ err, id }, 'Failed to destroy adapter');
      }
    }
  }

  /**
   * Get all registered adapter IDs.
   */
  listAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all session-based adapter IDs (connected subscriptions).
   */
  listSessionAdapters(): string[] {
    return Array.from(this.adapters.keys()).filter((id) => id.startsWith('session:'));
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private recordGap(gap: ProviderGap): void {
    // Dedupe by provider_id
    if (!this.recentGaps.some((g) => g.provider_id === gap.provider_id)) {
      this.recentGaps.push(gap);
    }

    for (const handler of this.gapHandlers) {
      try {
        handler(gap);
      } catch (err) {
        logger.error({ err }, 'Gap event handler error');
      }
    }
  }

  /**
   * Map provider IDs to signup URLs with affiliate tracking.
   */
  private getSignupUrl(providerId: string): string | undefined {
    const signupUrls: Record<string, string> = {
      'session:chatgpt': 'https://chatgpt.com/#pricing',
      'session:claude': 'https://claude.ai/upgrade',
      'session:gemini': 'https://one.google.com/about/ai-premium',
      'session:perplexity': 'https://perplexity.ai/pro',
    };
    return signupUrls[providerId];
  }
}
