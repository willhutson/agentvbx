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
