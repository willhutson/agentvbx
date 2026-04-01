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
