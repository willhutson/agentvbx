/**
 * Anthropic Claude API adapter.
 *
 * Uses the Anthropic Messages API directly via fetch.
 * Supports Claude 4.5 Sonnet/Opus, system prompts, and attachments.
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';

const logger = createLogger('anthropic-adapter');

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'claude-sonnet-4-5-20250929';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.maxTokens = config.maxTokens ?? 4096;
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn('Anthropic API key invalid or API unreachable');
    } else {
      logger.info({ model: this.model }, 'Anthropic adapter initialized');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      // Light check — just verify the API responds
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      // 200 or 400 (validation) means API is reachable
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const model = (request.metadata?.model as string) ?? this.model;

    const messages: Array<{ role: string; content: unknown }> = [];

    // Build content blocks for user message
    const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [
      { type: 'text', text: request.prompt },
    ];

    // Add image attachments if present
    if (request.attachments) {
      for (const attachment of request.attachments) {
        if (attachment.type.startsWith('image/')) {
          const base64 = Buffer.isBuffer(attachment.data)
            ? attachment.data.toString('base64')
            : attachment.data;
          contentBlocks.unshift({
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.type,
              data: base64,
            },
          });
        }
      }
    }

    messages.push({ role: 'user', content: contentBlocks });

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.max_tokens ?? this.maxTokens,
      messages,
    };

    if (request.system_prompt) {
      body.system = request.system_prompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
      }

      const data = await res.json() as {
        content: Array<{ type: string; text?: string }>;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      const text = data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      return {
        text,
        provider_id: this.id,
        model: data.model,
        tokens_used: data.usage.input_tokens + data.usage.output_tokens,
        latency_ms: Date.now() - startMs,
      };
    } catch (err) {
      logger.error({ err, model }, 'Anthropic request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    // No persistent resources
  }
}
