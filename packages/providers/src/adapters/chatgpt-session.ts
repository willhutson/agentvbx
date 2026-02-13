/**
 * ChatGPT session adapter — uses consumer subscription auth to call
 * ChatGPT's internal backend API (the same endpoints chatgpt.com calls).
 *
 * This is NOT the public OpenAI API (api.openai.com with sk-xxx keys).
 * This rides the user's ChatGPT Plus/Pro subscription at flat-rate pricing
 * instead of per-token enterprise metering.
 *
 * Auth model:
 * - User logs into chatgpt.com via the desktop app's embedded webview
 * - Session token is captured and stored in SessionStore
 * - All requests use that session token as a bearer token against
 *   chatgpt.com/backend-api/* endpoints
 *
 * Internal API surface:
 * - POST /backend-api/conversation — send message, get streamed response
 * - GET  /backend-api/conversations — list conversations
 * - GET  /backend-api/models — list available models for the subscription tier
 * - POST /backend-api/conversation/gen_title/:id — generate conversation title
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';
import type { SessionStore } from './session-store.js';

const logger = createLogger('chatgpt-session');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatGPTSessionConfig {
  tenant_id: string;
  session_store: SessionStore;
  /** Model to use. Defaults to subscription's best available. */
  default_model?: string;
  /** Base URL override (for testing). */
  base_url?: string;
}

interface ConversationPayload {
  action: 'next';
  messages: Array<{
    id: string;
    author: { role: 'user' };
    content: { content_type: 'text'; parts: string[] };
    metadata: Record<string, unknown>;
  }>;
  model: string;
  parent_message_id: string;
  conversation_id?: string;
  timezone_offset_min: number;
}

interface StreamMessage {
  message?: {
    id: string;
    author: { role: string };
    content: { content_type: string; parts: string[] };
    status: string;
    metadata?: {
      model_slug?: string;
      finish_details?: { type: string };
    };
  };
  conversation_id?: string;
  error?: string | null;
  is_completion?: boolean;
}

// ─── ChatGPT Session Adapter ────────────────────────────────────────────────

export class ChatGPTSessionAdapter implements ProviderAdapter {
  readonly id = 'session:chatgpt';
  readonly name = 'ChatGPT (Session)';

  private tenantId: string;
  private sessionStore: SessionStore;
  private defaultModel: string;
  private baseUrl: string;
  private currentConversationId: string | null = null;
  private lastParentMessageId: string;

  constructor(config: ChatGPTSessionConfig) {
    this.tenantId = config.tenant_id;
    this.sessionStore = config.session_store;
    this.defaultModel = config.default_model ?? 'auto';
    this.baseUrl = config.base_url ?? 'https://chatgpt.com';
    this.lastParentMessageId = this.generateId();
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn({ tenant: this.tenantId }, 'No ChatGPT session — user needs to log in');
    } else {
      // Detect available models from subscription tier
      try {
        const models = await this.listModels();
        if (models.length > 0 && this.defaultModel === 'auto') {
          // Prefer best available model
          this.defaultModel = models[0];
        }
        logger.info({ tenant: this.tenantId, model: this.defaultModel, models }, 'ChatGPT session adapter initialized');
      } catch {
        logger.info({ tenant: this.tenantId, model: this.defaultModel }, 'ChatGPT session adapter initialized (model list unavailable)');
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    const credentials = await this.sessionStore.load('chatgpt', this.tenantId);
    if (!credentials) return false;

    // Verify the session is still valid with a lightweight call
    try {
      const res = await fetch(`${this.baseUrl}/backend-api/models`, {
        headers: this.buildHeaders(credentials.auth_token),
      });

      if (res.ok) {
        await this.sessionStore.touch('chatgpt', this.tenantId);
        return true;
      }

      if (res.status === 401 || res.status === 403) {
        logger.info({ tenant: this.tenantId }, 'ChatGPT session expired');
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const credentials = await this.sessionStore.load('chatgpt', this.tenantId);

    if (!credentials) {
      throw new Error('No ChatGPT session available — user needs to log in');
    }

    const model = (request.metadata?.model as string) ?? this.defaultModel;
    const messageId = this.generateId();

    const payload: ConversationPayload = {
      action: 'next',
      messages: [
        {
          id: messageId,
          author: { role: 'user' },
          content: {
            content_type: 'text',
            parts: [request.prompt],
          },
          metadata: {},
        },
      ],
      model,
      parent_message_id: this.lastParentMessageId,
      timezone_offset_min: new Date().getTimezoneOffset(),
    };

    // Reuse existing conversation if available
    if (this.currentConversationId) {
      payload.conversation_id = this.currentConversationId;
    }

    // Add system prompt via metadata if provided
    if (request.system_prompt && !this.currentConversationId) {
      // For new conversations, prepend system context
      payload.messages[0].content.parts = [
        `${request.system_prompt}\n\n${request.prompt}`,
      ];
    }

    try {
      const res = await fetch(`${this.baseUrl}/backend-api/conversation`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(credentials.auth_token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();

        if (res.status === 401 || res.status === 403) {
          throw new Error('ChatGPT session expired — re-authentication needed');
        }

        throw new Error(`ChatGPT backend-api error ${res.status}: ${errorText}`);
      }

      // Parse the SSE stream to extract the final response
      const responseText = await this.parseSSEStream(res);

      return {
        text: responseText,
        provider_id: this.id,
        model,
        latency_ms: Date.now() - startMs,
        metadata: {
          conversation_id: this.currentConversationId,
          session_based: true,
          subscription_tier: 'consumer',
        },
      };
    } catch (err) {
      logger.error({ err, tenant: this.tenantId }, 'ChatGPT session request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.currentConversationId = null;
  }

  /**
   * Start a new conversation (clears conversation context).
   */
  resetConversation(): void {
    this.currentConversationId = null;
    this.lastParentMessageId = this.generateId();
  }

  /**
   * List models available to the user's subscription.
   */
  async listModels(): Promise<string[]> {
    const credentials = await this.sessionStore.load('chatgpt', this.tenantId);
    if (!credentials) return [];

    try {
      const res = await fetch(`${this.baseUrl}/backend-api/models`, {
        headers: this.buildHeaders(credentials.auth_token),
      });

      if (!res.ok) return [];

      const data = await res.json() as { models: Array<{ slug: string }> };
      return data.models.map((m) => m.slug);
    } catch {
      return [];
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    };
  }

  /**
   * Parse ChatGPT's Server-Sent Events stream to extract the final message.
   */
  private async parseSSEStream(res: Response): Promise<string> {
    const text = await res.text();
    const lines = text.split('\n');

    let finalContent = '';
    let lastAssistantMessageId = '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;

      try {
        const parsed = JSON.parse(data) as StreamMessage;

        if (parsed.message?.author?.role === 'assistant' && parsed.message.content?.parts) {
          finalContent = parsed.message.content.parts.join('');
          lastAssistantMessageId = parsed.message.id;

          if (parsed.conversation_id) {
            this.currentConversationId = parsed.conversation_id;
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (lastAssistantMessageId) {
      this.lastParentMessageId = lastAssistantMessageId;
    }

    return finalContent || '[No response received]';
  }

  private generateId(): string {
    return `agentvbx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
