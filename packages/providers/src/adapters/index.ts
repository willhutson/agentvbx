export { OllamaAdapter, AdapterManager } from './adapter.js';
export type {
  ProviderAdapter,
  AdapterRequest,
  AdapterResponse,
  OllamaConfig,
} from './adapter.js';

export { AnthropicAdapter } from './anthropic.js';
export type { AnthropicConfig } from './anthropic.js';

export { OpenAIAdapter } from './openai.js';
export type { OpenAIConfig } from './openai.js';

export { DeepSeekAdapter } from './deepseek.js';
export type { DeepSeekConfig } from './deepseek.js';

// ─── Session-based adapters (consumer subscription auth) ────────────────────

export { SessionStore } from './session-store.js';
export type {
  SessionCredentials,
  SessionEvent,
  SessionEventHandler,
  SessionStoreConfig,
} from './session-store.js';

export { ChatGPTSessionAdapter } from './chatgpt-session.js';
export type { ChatGPTSessionConfig } from './chatgpt-session.js';

export { ClaudeSessionAdapter } from './claude-session.js';
export type { ClaudeSessionConfig } from './claude-session.js';

export { GeminiSessionAdapter } from './gemini-session.js';
export type { GeminiSessionConfig } from './gemini-session.js';
