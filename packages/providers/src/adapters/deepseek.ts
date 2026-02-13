/**
 * DeepSeek API adapter.
 *
 * DeepSeek uses an OpenAI-compatible API, making this a thin wrapper.
 * Supports DeepSeek-V3, DeepSeek-R1 (reasoning), and DeepSeek-Coder.
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';

const logger = createLogger('deepseek-adapter');

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
}

export class DeepSeekAdapter implements ProviderAdapter {
  readonly id = 'deepseek';
  readonly name = 'DeepSeek';
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://api.deepseek.com';

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-chat';
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn('DeepSeek API key invalid or API unreachable');
    } else {
      logger.info({ model: this.model }, 'DeepSeek adapter initialized');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const model = (request.metadata?.model as string) ?? this.model;

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system_prompt) {
      messages.push({ role: 'system', content: request.system_prompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: request.max_tokens ?? 4096,
          temperature: request.temperature ?? 0.7,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`DeepSeek API error ${res.status}: ${errorText}`);
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
      logger.error({ err, model }, 'DeepSeek request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {}
}
