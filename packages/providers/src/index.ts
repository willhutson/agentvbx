/**
 * @agentvbx/providers — Provider registry, Model Genie, and adapter layer
 */

export { ProviderRegistry } from './registry/index.js';
export type {
  ToolCategory,
  IntegrationMethod,
  Provider,
  ProviderTier,
  ProviderAffiliate,
  ProviderHealth,
} from './registry/index.js';

export { ModelGenie } from './genie/index.js';
export type { GenieRecommendation, GenieQuery } from './genie/index.js';

export { OllamaAdapter, AdapterManager } from './adapters/index.js';
export type {
  ProviderAdapter,
  AdapterRequest,
  AdapterResponse,
  OllamaConfig,
} from './adapters/index.js';

export { AnthropicAdapter } from './adapters/anthropic.js';
export type { AnthropicConfig } from './adapters/anthropic.js';

export { OpenAIAdapter } from './adapters/openai.js';
export type { OpenAIConfig } from './adapters/openai.js';

export { DeepSeekAdapter } from './adapters/deepseek.js';
export type { DeepSeekConfig } from './adapters/deepseek.js';
