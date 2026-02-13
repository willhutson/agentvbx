/**
 * Claude session adapter — uses consumer subscription auth to call
 * Claude's internal conversation API (the same endpoints claude.ai calls).
 *
 * This is NOT the public Anthropic API (api.anthropic.com with sk-ant-xxx keys).
 * This rides the user's Claude Pro/Team subscription at flat-rate pricing
 * instead of per-token enterprise metering.
 *
 * Auth model:
 * - User logs into claude.ai via the desktop app's embedded webview
 * - Session cookie is captured and stored in SessionStore
 * - All requests use that session cookie against claude.ai/api/* endpoints
 *
 * Internal API surface:
 * - GET  /api/organizations — get org ID for the user's account
 * - POST /api/organizations/:org/chat_conversations — create conversation
 * - POST /api/organizations/:org/chat_conversations/:id/completion — send message
 * - GET  /api/organizations/:org/chat_conversations — list conversations
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';
import type { SessionStore } from './session-store.js';

const logger = createLogger('claude-session');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaudeSessionConfig {
  tenant_id: string;
  session_store: SessionStore;
  /** Model to use. Defaults to subscription's best available. */
  default_model?: string;
  /** Base URL override (for testing). */
  base_url?: string;
}

interface ClaudeCompletionPayload {
  prompt: string;
  timezone: string;
  attachments: Array<{
    extracted_content: string;
    file_name: string;
    file_size: number;
    file_type: string;
  }>;
  files: unknown[];
}

interface ClaudeStreamEvent {
  type: string;
  completion?: string;
  delta?: { type: string; text?: string };
  content_block?: { type: string; text?: string };
  message?: { id: string; content: Array<{ type: string; text?: string }> };
  error?: { type: string; message: string };
}

// ─── Claude Session Adapter ─────────────────────────────────────────────────

export class ClaudeSessionAdapter implements ProviderAdapter {
  readonly id = 'session:claude';
  readonly name = 'Claude (Session)';

  private tenantId: string;
  private sessionStore: SessionStore;
  private defaultModel: string;
  private baseUrl: string;
  private organizationId: string | null = null;
  private currentConversationId: string | null = null;

  constructor(config: ClaudeSessionConfig) {
    this.tenantId = config.tenant_id;
    this.sessionStore = config.session_store;
    this.defaultModel = config.default_model ?? 'claude-sonnet-4-5-20250929';
    this.baseUrl = config.base_url ?? 'https://claude.ai';
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn({ tenant: this.tenantId }, 'No Claude session — user needs to log in');
      return;
    }

    // Fetch organization ID (required for all API calls)
    try {
      await this.fetchOrganizationId();
      logger.info({ tenant: this.tenantId, org: this.organizationId, model: this.defaultModel }, 'Claude session adapter initialized');
    } catch (err) {
      logger.warn({ err, tenant: this.tenantId }, 'Claude session initialized but could not fetch org ID');
    }
  }

  async isAvailable(): Promise<boolean> {
    const credentials = await this.sessionStore.load('claude', this.tenantId);
    if (!credentials) return false;

    try {
      const res = await fetch(`${this.baseUrl}/api/organizations`, {
        headers: this.buildHeaders(credentials),
      });

      if (res.ok) {
        await this.sessionStore.touch('claude', this.tenantId);
        return true;
      }

      if (res.status === 401 || res.status === 403) {
        logger.info({ tenant: this.tenantId }, 'Claude session expired');
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const credentials = await this.sessionStore.load('claude', this.tenantId);

    if (!credentials) {
      throw new Error('No Claude session available — user needs to log in');
    }

    // Ensure we have the org ID
    if (!this.organizationId) {
      await this.fetchOrganizationId();
    }

    if (!this.organizationId) {
      throw new Error('Could not resolve Claude organization ID');
    }

    // Create a new conversation if needed
    if (!this.currentConversationId) {
      this.currentConversationId = await this.createConversation(credentials);
    }

    // Build the prompt — prepend system prompt for context
    let fullPrompt = request.prompt;
    if (request.system_prompt) {
      fullPrompt = `${request.system_prompt}\n\n${request.prompt}`;
    }

    const payload: ClaudeCompletionPayload = {
      prompt: fullPrompt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      attachments: [],
      files: [],
    };

    // Handle file attachments
    if (request.attachments) {
      for (const attachment of request.attachments) {
        if (typeof attachment.data === 'string') {
          payload.attachments.push({
            extracted_content: attachment.data,
            file_name: attachment.filename ?? 'attachment',
            file_size: attachment.data.length,
            file_type: attachment.type,
          });
        }
      }
    }

    try {
      const url = `${this.baseUrl}/api/organizations/${this.organizationId}/chat_conversations/${this.currentConversationId}/completion`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(credentials),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();

        if (res.status === 401 || res.status === 403) {
          throw new Error('Claude session expired — re-authentication needed');
        }

        throw new Error(`Claude internal API error ${res.status}: ${errorText}`);
      }

      const responseText = await this.parseSSEStream(res);

      return {
        text: responseText,
        provider_id: this.id,
        model: this.defaultModel,
        latency_ms: Date.now() - startMs,
        metadata: {
          conversation_id: this.currentConversationId,
          organization_id: this.organizationId,
          session_based: true,
          subscription_tier: 'consumer',
        },
      };
    } catch (err) {
      logger.error({ err, tenant: this.tenantId }, 'Claude session request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.currentConversationId = null;
    this.organizationId = null;
  }

  /**
   * Start a new conversation (clears conversation context).
   */
  resetConversation(): void {
    this.currentConversationId = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async fetchOrganizationId(): Promise<void> {
    const credentials = await this.sessionStore.load('claude', this.tenantId);
    if (!credentials) return;

    // Check if org ID is cached in provider_data
    if (credentials.provider_data?.organization_id) {
      this.organizationId = credentials.provider_data.organization_id as string;
      return;
    }

    const res = await fetch(`${this.baseUrl}/api/organizations`, {
      headers: this.buildHeaders(credentials),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch organizations: ${res.status}`);
    }

    const orgs = await res.json() as Array<{ uuid: string; name: string }>;
    if (orgs.length === 0) {
      throw new Error('No organizations found for this Claude account');
    }

    this.organizationId = orgs[0].uuid;

    // Cache the org ID in provider_data
    credentials.provider_data = { ...credentials.provider_data, organization_id: this.organizationId };
    await this.sessionStore.store(credentials);
  }

  private async createConversation(credentials: { auth_token: string; cookies?: Record<string, string> }): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/api/organizations/${this.organizationId}/chat_conversations`,
      {
        method: 'POST',
        headers: {
          ...this.buildHeaders(credentials),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: '',
          model: this.defaultModel,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to create Claude conversation: ${res.status}`);
    }

    const data = await res.json() as { uuid: string };
    return data.uuid;
  }

  private buildHeaders(credentials: { auth_token: string; cookies?: Record<string, string> }): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    };

    // Claude uses session cookies, not bearer tokens
    if (credentials.cookies && Object.keys(credentials.cookies).length > 0) {
      headers.Cookie = Object.entries(credentials.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    } else {
      // Fallback to bearer if cookies aren't available
      headers.Authorization = `Bearer ${credentials.auth_token}`;
    }

    return headers;
  }

  /**
   * Parse Claude's SSE stream to extract the full response text.
   */
  private async parseSSEStream(res: Response): Promise<string> {
    const text = await res.text();
    const lines = text.split('\n');

    let fullText = '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      try {
        const event = JSON.parse(data) as ClaudeStreamEvent;

        if (event.type === 'completion' && event.completion) {
          fullText += event.completion;
        } else if (event.type === 'content_block_delta' && event.delta?.text) {
          fullText += event.delta.text;
        } else if (event.error) {
          throw new Error(`Claude stream error: ${event.error.message}`);
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue; // Skip unparseable lines
        throw err;
      }
    }

    return fullText || '[No response received]';
  }
}
