/**
 * Browser task runner — executes automation tasks against provider web UIs.
 *
 * The task runner takes a high-level instruction (e.g., "send prompt to ChatGPT")
 * and uses provider scripts + Playwright to execute it through the browser.
 *
 * Responsibilities:
 * - Execute send/receive message flows
 * - Extract responses and artifacts from provider UIs
 * - Detect and report auth failures for re-auth flow
 * - Handle timeouts and retries with exponential backoff
 */

import { createLogger } from './logger.js';
import { getProviderScript, findElement, type ProviderScript } from './provider-scripts.js';
import type { SessionMessage } from './session-manager.js';

const logger = createLogger('task-runner');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskConfig {
  provider_id: string;
  action: 'send_message' | 'new_chat' | 'extract_response' | 'check_auth';
  payload?: {
    message?: string;
    extract_artifacts?: boolean;
  };
  retry?: {
    max_attempts: number;
    backoff_ms: number;
  };
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'auth_required';

export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  response?: SessionMessage;
  artifacts?: TaskArtifact[];
  error?: string;
  duration_ms: number;
  retries: number;
}

export interface TaskArtifact {
  type: string;
  content: string;
  filename?: string;
  mime_type?: string;
}

// ─── Page interface (subset of Playwright Page) ─────────────────────────────

interface PageLike {
  $(selector: string): Promise<ElementLike | null>;
  $$(selector: string): Promise<ElementLike[]>;
  url(): string;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<ElementLike | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
}

interface ElementLike {
  click(): Promise<void>;
  fill?(value: string): Promise<void>;
  type?(text: string, options?: { delay?: number }): Promise<void>;
  textContent(): Promise<string | null>;
  innerHTML(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
}

// ─── Task Runner ────────────────────────────────────────────────────────────

export class TaskRunner {
  /**
   * Execute a task on a browser page using the provider's automation script.
   */
  async execute(page: PageLike, config: TaskConfig): Promise<TaskResult> {
    const startMs = Date.now();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let retries = 0;
    const maxRetries = config.retry?.max_attempts ?? 2;

    const script = getProviderScript(config.provider_id);
    if (!script) {
      return {
        task_id: taskId,
        status: 'failed',
        error: `No provider script for: ${config.provider_id}`,
        duration_ms: Date.now() - startMs,
        retries: 0,
      };
    }

    while (retries <= maxRetries) {
      try {
        // Check auth state first
        const isAuthed = await this.checkAuth(page, script);
        if (!isAuthed) {
          return {
            task_id: taskId,
            status: 'auth_required',
            error: 'Session expired, re-authentication needed',
            duration_ms: Date.now() - startMs,
            retries,
          };
        }

        switch (config.action) {
          case 'send_message': {
            const response = await this.sendMessage(page, script, config.payload?.message ?? '');
            const artifacts = config.payload?.extract_artifacts
              ? await this.extractArtifacts(page, script)
              : [];

            return {
              task_id: taskId,
              status: 'completed',
              response,
              artifacts,
              duration_ms: Date.now() - startMs,
              retries,
            };
          }

          case 'new_chat': {
            await this.startNewChat(page, script);
            return {
              task_id: taskId,
              status: 'completed',
              duration_ms: Date.now() - startMs,
              retries,
            };
          }

          case 'extract_response': {
            const response = await this.extractLatestResponse(page, script);
            const artifacts = await this.extractArtifacts(page, script);
            return {
              task_id: taskId,
              status: 'completed',
              response,
              artifacts,
              duration_ms: Date.now() - startMs,
              retries,
            };
          }

          case 'check_auth': {
            return {
              task_id: taskId,
              status: isAuthed ? 'completed' : 'auth_required',
              duration_ms: Date.now() - startMs,
              retries,
            };
          }

          default:
            return {
              task_id: taskId,
              status: 'failed',
              error: `Unknown action: ${config.action}`,
              duration_ms: Date.now() - startMs,
              retries,
            };
        }
      } catch (err) {
        retries++;
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ taskId, retries, maxRetries, error: errMsg }, 'Task attempt failed');

        if (retries > maxRetries) {
          return {
            task_id: taskId,
            status: 'failed',
            error: errMsg,
            duration_ms: Date.now() - startMs,
            retries,
          };
        }

        // Exponential backoff
        const backoff = (config.retry?.backoff_ms ?? 1000) * Math.pow(2, retries - 1);
        await page.waitForTimeout(backoff);
      }
    }

    return {
      task_id: taskId,
      status: 'failed',
      error: 'Max retries exceeded',
      duration_ms: Date.now() - startMs,
      retries,
    };
  }

  // ─── Auth Check ────────────────────────────────────────────────────────

  private async checkAuth(page: PageLike, script: ProviderScript): Promise<boolean> {
    const url = page.url();

    // URL-based checks
    if (url.includes('login') || url.includes('signin') || url.includes('auth/')) {
      return false;
    }

    // Selector-based checks for login indicators
    for (const selector of script.selectors.login_indicator) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          logger.info({ provider: script.id }, 'Login indicator detected — session expired');
          return false;
        }
      } catch {
        // Selector not found = good, means we're not on login page
      }
    }

    return true;
  }

  // ─── Send Message ──────────────────────────────────────────────────────

  private async sendMessage(
    page: PageLike,
    script: ProviderScript,
    message: string,
  ): Promise<SessionMessage> {
    logger.info({ provider: script.id, preview: message.substring(0, 60) }, 'Sending message');

    // Find and focus input field
    const input = await findElement(
      page as unknown as { $(selector: string): Promise<unknown> },
      script.selectors.input_field,
    );
    if (!input) {
      throw new Error(`Could not find input field for ${script.id}`);
    }

    const el = input.element as ElementLike;

    // Type the message
    if (el.fill) {
      await el.fill(message);
    } else if (el.type) {
      await el.type(message, { delay: 10 });
    } else {
      await el.click();
      await page.keyboard.press('a');
      // Fall back to evaluate-based input
      await page.evaluate(`(el, msg) => { el.textContent = msg; el.dispatchEvent(new Event('input', {bubbles: true})); }`, input.element, message);
    }

    // Small delay to let UI process input
    await page.waitForTimeout(200);

    // Click send button
    const sendBtn = await findElement(
      page as unknown as { $(selector: string): Promise<unknown> },
      script.selectors.send_button,
    );
    if (sendBtn) {
      await (sendBtn.element as ElementLike).click();
    } else {
      // Fallback: press Enter
      await page.keyboard.press('Enter');
    }

    // Wait for response
    const response = await this.waitForResponse(page, script);
    return response;
  }

  // ─── Wait for Response ────────────────────────────────────────────────

  private async waitForResponse(page: PageLike, script: ProviderScript): Promise<SessionMessage> {
    const { timeout_ms, poll_interval_ms, stable_duration_ms } = script.wait;
    const startMs = Date.now();
    let lastContent = '';
    let stableStart = 0;

    while (Date.now() - startMs < timeout_ms) {
      await page.waitForTimeout(poll_interval_ms);

      // Check if stop button is visible (still generating)
      if (script.selectors.stop_button) {
        let isGenerating = false;
        for (const sel of script.selectors.stop_button) {
          try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) {
              isGenerating = true;
              break;
            }
          } catch { /* not found */ }
        }

        if (isGenerating) {
          stableStart = 0;
          continue;
        }
      }

      // Extract current response content
      const content = await this.getLatestResponseText(page, script);
      if (!content) continue;

      if (content === lastContent && content.length > 0) {
        if (stableStart === 0) stableStart = Date.now();
        if (Date.now() - stableStart >= stable_duration_ms) {
          // Response is stable
          return {
            role: 'assistant',
            content,
            timestamp: new Date().toISOString(),
          };
        }
      } else {
        lastContent = content;
        stableStart = 0;
      }
    }

    // Timeout — return whatever we have
    return {
      role: 'assistant',
      content: lastContent || '[Response timeout]',
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Extract Response ──────────────────────────────────────────────────

  private async getLatestResponseText(page: PageLike, script: ProviderScript): Promise<string> {
    for (const selector of script.selectors.response_container) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          const last = elements[elements.length - 1];
          const text = await last.textContent();
          if (text && text.trim().length > 0) {
            return text.trim();
          }
        }
      } catch { /* selector not valid for this page state */ }
    }
    return '';
  }

  private async extractLatestResponse(page: PageLike, script: ProviderScript): Promise<SessionMessage> {
    const content = await this.getLatestResponseText(page, script);
    return {
      role: 'assistant',
      content: content || '[No response found]',
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Extract Artifacts ─────────────────────────────────────────────────

  private async extractArtifacts(page: PageLike, script: ProviderScript): Promise<TaskArtifact[]> {
    const artifacts: TaskArtifact[] = [];

    if (!script.selectors.artifact_container) return artifacts;

    for (const selector of script.selectors.artifact_container) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const content = await el.innerHTML();
          if (content && content.trim().length > 0) {
            // Determine artifact type from element context
            const tagName = await el.getAttribute('data-type');
            artifacts.push({
              type: tagName ?? 'code',
              content: content.trim(),
            });
          }
        }
      } catch { /* skip */ }
    }

    return artifacts;
  }

  // ─── New Chat ──────────────────────────────────────────────────────────

  private async startNewChat(page: PageLike, script: ProviderScript): Promise<void> {
    if (!script.selectors.new_chat_button) {
      await page.goto(script.url, { waitUntil: 'networkidle' });
      return;
    }

    const btn = await findElement(
      page as unknown as { $(selector: string): Promise<unknown> },
      script.selectors.new_chat_button,
    );
    if (btn) {
      await (btn.element as ElementLike).click();
      await page.waitForTimeout(1000);
    } else {
      await page.goto(script.url, { waitUntil: 'networkidle' });
    }
  }
}
