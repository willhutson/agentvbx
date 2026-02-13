/**
 * OpenAI ChatGPT API adapter.
 *
 * Uses the OpenAI Chat Completions API directly via fetch.
 * Supports GPT-4o, GPT-4, system prompts, and vision.
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';

const logger = createLogger('openai-adapter');

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  organization?: string;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai';
  readonly name = 'OpenAI ChatGPT';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private organization?: string;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.organization = config.organization;
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn('OpenAI API key invalid or API unreachable');
    } else {
      logger.info({ model: this.model }, 'OpenAI adapter initialized');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
      };
      if (this.organization) headers['OpenAI-Organization'] = this.organization;

      const res = await fetch(`${this.baseUrl}/v1/models`, { headers });
      return res.ok;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const model = (request.metadata?.model as string) ?? this.model;

    const messages: Array<{ role: string; content: unknown }> = [];

    if (request.system_prompt) {
      messages.push({ role: 'system', content: request.system_prompt });
    }

    // Build user message with potential vision content
    if (request.attachments?.some((a) => a.type.startsWith('image/'))) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: request.prompt },
      ];

      for (const attachment of request.attachments) {
        if (attachment.type.startsWith('image/')) {
          const base64 = Buffer.isBuffer(attachment.data)
            ? attachment.data.toString('base64')
            : attachment.data;
          content.push({
            type: 'image_url',
            image_url: { url: `data:${attachment.type};base64,${base64}` },
          });
        }
      }

      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: request.prompt });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.organization) headers['OpenAI-Organization'] = this.organization;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage: { total_tokens: number };
      };

      return {
        text: data.choices[0]?.message?.content ?? '',
        provider_id: this.id,
        model: data.model,
        tokens_used: data.usage.total_tokens,
        latency_ms: Date.now() - startMs,
      };
    } catch (err) {
      logger.error({ err, model }, 'OpenAI request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    // No persistent resources
  }
}
