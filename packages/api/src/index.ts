/**
 * @agentvbx/api — Admin REST API + WebSocket server
 */

export { ApiServer } from './server.js';
export type { ApiServerConfig, WSEvent } from './server.js';

// Phase 2: Per-tenant webhook routing
export { OrgResolver } from './services/orgResolver.js';
export type { OrgConfig } from './services/orgResolver.js';
export { orgSlugMiddleware } from './middleware/orgSlugMiddleware.js';
export { createWebhookRouter } from './routes/webhooks/index.js';

// Phase 3: Production hardening
export { rateLimiterMiddleware, resetBuckets, TIER_LIMITS } from './middleware/rateLimiter.js';
export { channelHealth } from './services/channelHealth.js';
export type { ChannelHealthRecord, ChannelHealthAlert } from './services/channelHealth.js';
export { MessageHistoryService } from './services/messageHistory.js';
export type { StoredMessage, MessageHistoryConfig } from './services/messageHistory.js';

// Phase 4: SSE event stream for Mission Control
export { eventStream } from './services/eventStream.js';
export type { AgentEvent } from './services/eventStream.js';

// Phase 7D: SpokeStack entity event webhook
export { createSpokeStackEventsRouter, resolveRecipe } from './routes/webhooks/spokestack-events.js';
export type { EntityEvent } from './routes/webhooks/spokestack-events.js';
