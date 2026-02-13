/**
 * Provider-specific browser automation scripts.
 *
 * Each provider has its own selectors, input patterns, and response extraction logic.
 * These scripts are used by the task runner to interact with AI provider web UIs.
 *
 * In production, these would use agent-browser's ref-based element selection
 * for resilience against UI changes. For now, we use CSS selectors with fallbacks.
 */

import { createLogger } from './logger.js';

const logger = createLogger('provider-scripts');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProviderScript {
  id: string;
  name: string;
  url: string;
  login_url: string;
  /** CSS selectors for key UI elements */
  selectors: {
    input_field: string[];
    send_button: string[];
    response_container: string[];
    login_indicator: string[];
    new_chat_button?: string[];
    artifact_container?: string[];
    stop_button?: string[];
  };
  /** Wait conditions after sending */
  wait: {
    response_selector: string;
    timeout_ms: number;
    poll_interval_ms: number;
    stable_duration_ms: number;
  };
  /** Response extraction */
  extract: {
    response_method: 'last_message' | 'streaming_complete' | 'diff';
    artifact_types?: string[];
  };
}

// ─── Provider Definitions ────────────────────────────────────────────────────

export const PROVIDER_SCRIPTS: Record<string, ProviderScript> = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    login_url: 'https://chatgpt.com/auth/login',
    selectors: {
      input_field: ['#prompt-textarea', 'textarea[data-id="root"]', 'div[contenteditable="true"]'],
      send_button: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
      response_container: ['div[data-message-author-role="assistant"]', '.markdown.prose'],
      login_indicator: ['button[data-testid="login-button"]', 'a[href*="auth/login"]'],
      new_chat_button: ['a[href="/"]', 'nav a:first-child'],
      artifact_container: ['div[class*="artifact"]', 'pre code'],
      stop_button: ['button[aria-label="Stop generating"]'],
    },
    wait: {
      response_selector: 'div[data-message-author-role="assistant"]',
      timeout_ms: 120000,
      poll_interval_ms: 500,
      stable_duration_ms: 2000,
    },
    extract: {
      response_method: 'streaming_complete',
      artifact_types: ['code', 'image', 'file'],
    },
  },

  claude: {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    login_url: 'https://claude.ai/login',
    selectors: {
      input_field: ['div[contenteditable="true"].ProseMirror', 'fieldset .ProseMirror'],
      send_button: ['button[aria-label="Send Message"]', 'button[type="submit"]'],
      response_container: ['div[data-is-streaming]', '.font-claude-message'],
      login_indicator: ['button:has-text("Log in")', 'a[href*="login"]'],
      new_chat_button: ['a[href="/new"]', 'button[aria-label="New chat"]'],
      artifact_container: ['div[class*="artifact"]', '.code-block'],
      stop_button: ['button[aria-label="Stop Response"]'],
    },
    wait: {
      response_selector: '.font-claude-message',
      timeout_ms: 180000,
      poll_interval_ms: 500,
      stable_duration_ms: 3000,
    },
    extract: {
      response_method: 'streaming_complete',
      artifact_types: ['code', 'document', 'image'],
    },
  },

  gemini: {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    login_url: 'https://accounts.google.com',
    selectors: {
      input_field: ['rich-textarea .ql-editor', '.input-area textarea', 'div[contenteditable="true"]'],
      send_button: ['button[aria-label="Send message"]', '.send-button'],
      response_container: ['.model-response-text', '.response-container'],
      login_indicator: ['a[href*="accounts.google.com"]'],
      new_chat_button: ['button[aria-label="New chat"]', 'a[href="/app"]'],
    },
    wait: {
      response_selector: '.model-response-text',
      timeout_ms: 120000,
      poll_interval_ms: 500,
      stable_duration_ms: 2000,
    },
    extract: {
      response_method: 'streaming_complete',
      artifact_types: ['code', 'image'],
    },
  },

  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    url: 'https://www.perplexity.ai',
    login_url: 'https://www.perplexity.ai/signin',
    selectors: {
      input_field: ['textarea[placeholder*="Ask"]', 'textarea.overflow-auto'],
      send_button: ['button[aria-label="Submit"]', 'button svg[data-icon="arrow-right"]'],
      response_container: ['.prose', '.markdown-content'],
      login_indicator: ['button:has-text("Sign In")', 'a[href*="signin"]'],
      new_chat_button: ['a[href="/"]'],
    },
    wait: {
      response_selector: '.prose',
      timeout_ms: 60000,
      poll_interval_ms: 500,
      stable_duration_ms: 2000,
    },
    extract: {
      response_method: 'streaming_complete',
      artifact_types: ['citation'],
    },
  },

  midjourney: {
    id: 'midjourney',
    name: 'Midjourney',
    url: 'https://www.midjourney.com/imagine',
    login_url: 'https://www.midjourney.com/signin',
    selectors: {
      input_field: ['input[placeholder*="Imagine"]', 'textarea[placeholder*="prompt"]'],
      send_button: ['button[type="submit"]', 'button[aria-label="Generate"]'],
      response_container: ['.image-grid', '.generation-result'],
      login_indicator: ['a[href*="signin"]', 'button:has-text("Sign In")'],
    },
    wait: {
      response_selector: '.image-grid img',
      timeout_ms: 300000,
      poll_interval_ms: 2000,
      stable_duration_ms: 5000,
    },
    extract: {
      response_method: 'last_message',
      artifact_types: ['image'],
    },
  },

  lovable: {
    id: 'lovable',
    name: 'Lovable',
    url: 'https://lovable.dev',
    login_url: 'https://lovable.dev/login',
    selectors: {
      input_field: ['textarea', 'div[contenteditable="true"]'],
      send_button: ['button[type="submit"]', 'button:has-text("Send")'],
      response_container: ['.response', '.output-panel'],
      login_indicator: ['a[href*="login"]', 'button:has-text("Log in")'],
    },
    wait: {
      response_selector: '.response',
      timeout_ms: 300000,
      poll_interval_ms: 2000,
      stable_duration_ms: 5000,
    },
    extract: {
      response_method: 'streaming_complete',
      artifact_types: ['code', 'preview'],
    },
  },
};

// ─── Script Helpers ─────────────────────────────────────────────────────────

/**
 * Get the automation script for a provider.
 */
export function getProviderScript(providerId: string): ProviderScript | undefined {
  return PROVIDER_SCRIPTS[providerId];
}

/**
 * Get all registered provider script IDs.
 */
export function getAvailableProviderScripts(): string[] {
  return Object.keys(PROVIDER_SCRIPTS);
}

/**
 * Try multiple selectors in order, return the first match.
 */
export async function findElement(
  page: { $(selector: string): Promise<unknown> },
  selectors: string[],
): Promise<{ element: unknown; selector: string } | null> {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        return { element, selector };
      }
    } catch {
      // Selector failed, try next
    }
  }
  logger.warn({ selectors }, 'No matching element found for any selector');
  return null;
}
