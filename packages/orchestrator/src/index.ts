/**
 * @agentvbx/orchestrator — Core orchestration layer for AGENTVBX
 *
 * The orchestrator is the central brain: it connects Redis Streams (message queue),
 * the message router (keyword/channel-based agent selection), the recipe engine
 * (multi-step workflow execution), and the tenant manager (multi-tenant isolation).
 */

// Main orchestrator
export { Orchestrator } from './orchestrator.js';
export type { OrchestratorConfig } from './orchestrator.js';

// Queue
export { RedisStreams } from './queue/index.js';
export type { RedisStreamsConfig } from './queue/index.js';

// Routing
export { MessageRouter } from './routing/index.js';
export type { ProviderStatus } from './routing/index.js';

// Recipe engine
export { RecipeEngine } from './recipe/index.js';
export type {
  StepStatus,
  StepResult,
  RecipeExecution,
  StepHandler,
  ConfirmationHandler,
  NotificationHandler,
} from './recipe/index.js';

// Tenant management
export { TenantManager } from './tenant/index.js';

// Config
export { ConfigLoader } from './config/index.js';

// Process management
export { ProcessSupervisor } from './process/index.js';
export type { ProcessConfig } from './process/index.js';

// Logger
export { createLogger } from './logger.js';

// Types — re-export everything
export type * from './types.js';
