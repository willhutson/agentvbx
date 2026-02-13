/**
 * Gemini session adapter — uses consumer Google account session to call
 * Gemini's internal API (the same endpoints gemini.google.com calls).
 *
 * This is NOT the public Vertex AI / Gemini API (with API keys or service accounts).
 * This rides the user's Google One AI Premium or free Gemini tier at
 * consumer pricing instead of per-token enterprise metering.
 *
 * Auth model:
 * - User logs into gemini.google.com via the desktop app's embedded webview
 * - Google session cookies are captured and stored in SessionStore
 * - Requests use the session cookies + SNLM0e token (CSRF-like token
 *   embedded in the page) against gemini.google.com/_/BardChatUi endpoints
 *
 * Internal API surface:
 * - POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   — send message, get response
 * - The request/response format uses a protobuf-like array encoding
 */

import { createLogger } from '../logger.js';
import type { ProviderAdapter, AdapterRequest, AdapterResponse } from './adapter.js';
import type { SessionStore } from './session-store.js';

const logger = createLogger('gemini-session');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GeminiSessionConfig {
  tenant_id: string;
  session_store: SessionStore;
  /** Base URL override (for testing). */
  base_url?: string;
}

// ─── Gemini Session Adapter ─────────────────────────────────────────────────

export class GeminiSessionAdapter implements ProviderAdapter {
  readonly id = 'session:gemini';
  readonly name = 'Gemini (Session)';

  private tenantId: string;
  private sessionStore: SessionStore;
  private baseUrl: string;
  private snlm0eToken: string | null = null;
  private conversationId: string | null = null;
  private responseId: string | null = null;
  private choiceId: string | null = null;

  constructor(config: GeminiSessionConfig) {
    this.tenantId = config.tenant_id;
    this.sessionStore = config.session_store;
    this.baseUrl = config.base_url ?? 'https://gemini.google.com';
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      logger.warn({ tenant: this.tenantId }, 'No Gemini session — user needs to log in');
      return;
    }

    // Fetch the SNLM0e token needed for API requests
    try {
      await this.fetchSNLM0eToken();
      logger.info({ tenant: this.tenantId }, 'Gemini session adapter initialized');
    } catch (err) {
      logger.warn({ err, tenant: this.tenantId }, 'Gemini session initialized but could not fetch SNLM0e token');
    }
  }

  async isAvailable(): Promise<boolean> {
    const credentials = await this.sessionStore.load('gemini', this.tenantId);
    if (!credentials) return false;

    try {
      const res = await fetch(this.baseUrl, {
        headers: this.buildHeaders(credentials),
        redirect: 'manual',
      });

      // If we get redirected to accounts.google.com, session is expired
      if (res.status === 302 || res.status === 301) {
        const location = res.headers.get('location') ?? '';
        if (location.includes('accounts.google.com')) {
          logger.info({ tenant: this.tenantId }, 'Gemini session expired (redirect to login)');
          return false;
        }
      }

      if (res.ok) {
        await this.sessionStore.touch('gemini', this.tenantId);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const startMs = Date.now();
    const credentials = await this.sessionStore.load('gemini', this.tenantId);

    if (!credentials) {
      throw new Error('No Gemini session available — user needs to log in');
    }

    // Ensure we have the SNLM0e token
    if (!this.snlm0eToken) {
      await this.fetchSNLM0eToken();
    }

    if (!this.snlm0eToken) {
      throw new Error('Could not obtain Gemini SNLM0e token');
    }

    // Build the prompt — prepend system prompt for context
    let fullPrompt = request.prompt;
    if (request.system_prompt) {
      fullPrompt = `${request.system_prompt}\n\n${request.prompt}`;
    }

    // Gemini uses a protobuf-like array encoding for requests
    const requestPayload = this.buildRequestPayload(fullPrompt);

    try {
      const url = `${this.baseUrl}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;

      const params = new URLSearchParams({
        bl: 'boq_assistant-bard-web-server_20240101.00_p0',
        _reqid: String(Math.floor(Math.random() * 900000) + 100000),
        rt: 'c',
      });

      const formData = new URLSearchParams();
      formData.set('f.req', JSON.stringify(requestPayload));
      formData.set('at', this.snlm0eToken);

      const res = await fetch(`${url}?${params}`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(credentials),
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: formData.toString(),
      });

      if (!res.ok) {
        const errorText = await res.text();

        if (res.status === 401 || res.status === 403) {
          this.snlm0eToken = null;
          throw new Error('Gemini session expired — re-authentication needed');
        }

        throw new Error(`Gemini internal API error ${res.status}: ${errorText}`);
      }

      const responseText = await this.parseResponse(res);

      return {
        text: responseText,
        provider_id: this.id,
        model: 'gemini-pro',
        latency_ms: Date.now() - startMs,
        metadata: {
          conversation_id: this.conversationId,
          session_based: true,
          subscription_tier: 'consumer',
        },
      };
    } catch (err) {
      logger.error({ err, tenant: this.tenantId }, 'Gemini session request failed');
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.snlm0eToken = null;
    this.conversationId = null;
    this.responseId = null;
    this.choiceId = null;
  }

  /**
   * Start a new conversation.
   */
  resetConversation(): void {
    this.conversationId = null;
    this.responseId = null;
    this.choiceId = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Fetch the SNLM0e token from the Gemini page.
   * This is a CSRF-like token embedded in the HTML that's required for API calls.
   */
  private async fetchSNLM0eToken(): Promise<void> {
    const credentials = await this.sessionStore.load('gemini', this.tenantId);
    if (!credentials) return;

    const res = await fetch(this.baseUrl, {
      headers: this.buildHeaders(credentials),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Gemini page for SNLM0e token: ${res.status}`);
    }

    const html = await res.text();
    const match = html.match(/SNlM0e":"([^"]+)"/);

    if (match && match[1]) {
      this.snlm0eToken = match[1];

      // Cache the token in provider_data
      credentials.provider_data = { ...credentials.provider_data, snlm0e: this.snlm0eToken };
      await this.sessionStore.store(credentials);
    } else {
      throw new Error('Could not find SNLM0e token in Gemini page');
    }
  }

  private buildHeaders(credentials: { auth_token: string; cookies?: Record<string, string> }): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };

    if (credentials.cookies && Object.keys(credentials.cookies).length > 0) {
      headers.Cookie = Object.entries(credentials.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }

    return headers;
  }

  /**
   * Build the protobuf-like array payload for Gemini's internal API.
   */
  private buildRequestPayload(prompt: string): unknown[] {
    return [
      [
        [prompt],
        null,
        this.conversationId ? [this.conversationId, this.responseId, this.choiceId] : null,
      ],
    ];
  }

  /**
   * Parse Gemini's response format.
   * The response is a series of JSON arrays with a specific structure.
   */
  private async parseResponse(res: Response): Promise<string> {
    const text = await res.text();

    // Gemini wraps responses in )]}\' prefix and multiple JSON lines
    const lines = text.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        // Try to find the main response data
        const cleaned = line.replace(/^\)\]\}'/, '').trim();
        if (!cleaned) continue;

        const parsed = JSON.parse(cleaned);

        // The response structure is deeply nested arrays
        // Navigate to extract the text content
        if (Array.isArray(parsed) && parsed[0]?.[2]) {
          const innerJson = parsed[0][2];

          try {
            const inner = typeof innerJson === 'string' ? JSON.parse(innerJson) : innerJson;

            // Extract response text
            if (Array.isArray(inner) && inner[4]?.[0]?.[1]?.[0]) {
              const responseText = inner[4][0][1][0];

              // Update conversation tracking
              if (inner[1]) {
                this.conversationId = inner[1][0] ?? this.conversationId;
                this.responseId = inner[1][1] ?? this.responseId;
                this.choiceId = inner[4]?.[0]?.[0] ?? this.choiceId;
              }

              return responseText;
            }
          } catch {
            // Inner parse failed, continue
          }
        }
      } catch {
        // Parse failed, try next line
      }
    }

    return '[No response received]';
  }
}
