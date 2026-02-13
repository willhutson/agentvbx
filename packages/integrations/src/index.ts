/**
 * @agentvbx/integrations — Platform integrations for AGENTVBX
 */

// Core adapter interface
export { IntegrationManager } from './adapter.js';
export type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationFile,
  IntegrationRecord,
  UploadResult,
} from './adapter.js';

// Google
export { GoogleAuth } from './google/auth.js';
export type { GoogleOAuthConfig, GoogleTokens } from './google/auth.js';
export { GoogleDriveAdapter } from './google/drive.js';

// Monday.com
export { MondayAdapter } from './monday.js';

// Notion
export { NotionAdapter } from './notion.js';

// GitHub
export { GitHubAdapter } from './github.js';

// Meta Ads
export { MetaAdsClient } from './meta-ads.js';
export type {
  MetaAdsConfig,
  CampaignConfig,
  CampaignObjective,
  AudienceTargeting,
  AdCreative,
  LeadFormConfig,
  AdPlacement,
  CampaignMetrics,
  Campaign,
} from './meta-ads.js';

// Meta Webhooks
export { MetaWebhookProcessor } from './meta-webhooks.js';
export type {
  MetaWebhookConfig,
  LeadgenEntry,
  ProcessedLead,
} from './meta-webhooks.js';
