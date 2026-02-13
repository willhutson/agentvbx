/**
 * @agentvbx/orchestrator — Core orchestration layer for AGENTVBX
 *
 * The orchestrator is the central brain: it connects Redis Streams (message queue),
 * the message router (keyword/channel-based agent selection), the recipe engine
 * (multi-step workflow execution), and the tenant manager (multi-tenant isolation).
 */

// Main orchestrator
export { Orchestrator } from './orchestrator.js';
export type {
  OrchestratorConfig,
  AdapterManagerLike,
  IntegrationManagerLike,
  ChannelSender,
  MessageEventHandler,
  MessageResult,
} from './orchestrator.js';

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

// Step handlers
export { AgentStepHandler } from './handlers/index.js';
export { IntegrationReadHandler, IntegrationWriteHandler } from './handlers/index.js';
export { NotificationStepHandler } from './handlers/index.js';

// Artifacts
export { ArtifactManager } from './artifacts/index.js';
export { ArtifactDeliveryHandler } from './artifacts/index.js';
export type { ArtifactInput, CloudUploader, ArtifactNotifier } from './artifacts/index.js';

// File stores (local, Obsidian, cloud) + artifact versioning
export { LocalFileStore, ObsidianStore, CloudFileStore, FileStoreManager } from './files/index.js';
export { VersionManager } from './files/index.js';
export type {
  FileEntry,
  FileContent,
  FileStore,
  FileStoreType,
  FileStoreConfig,
  ObsidianNote,
  ArtifactStatus,
  ArtifactVersion,
  FeedbackFragment,
  UnifiedFeedback,
  VersionedArtifact,
} from './files/index.js';

// Tenant management
export { TenantManager } from './tenant/index.js';

// Config
export { ConfigLoader } from './config/index.js';

// Process management
export { ProcessSupervisor } from './process/index.js';
export type { ProcessConfig } from './process/index.js';

// Marketplace
export { MarketplaceCatalog } from './marketplace/index.js';
export type { MarketplaceEntry, PublishRequest, MarketplaceStats } from './marketplace/index.js';

// Scaling
export { RateLimiter, TIER_LIMITS } from './scaling/index.js';
export type { TierLimits, UsageBucket, RateLimitResult } from './scaling/index.js';

// Analytics
export { AnalyticsEngine } from './analytics/index.js';
export type {
  UsageEvent,
  TenantUsageSummary,
  AnalyticsOverview,
  CostBreakdown,
} from './analytics/index.js';

// White-label
export { WhitelabelManager } from './whitelabel/index.js';
export type { WhitelabelConfig } from './whitelabel/index.js';

// Logger
export { createLogger } from './logger.js';

// Types — re-export everything
export type * from './types.js';
