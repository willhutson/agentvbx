/**
 * Core types for the AGENTVBX orchestration layer.
 * Channel-agnostic message format, tenant model, agent blueprints, and recipe definitions.
 */

// ─── Channel-Agnostic Message ───────────────────────────────────────────────

export type Channel = 'whatsapp' | 'telegram' | 'voice' | 'sms' | 'app';
export type MessageDirection = 'inbound' | 'outbound';

export interface ArtifactRef {
  artifact_id: string;
  filename: string;
  file_type: string;
  thumbnail_url?: string;
  preview_url?: string;
  cloud_url?: string;
  local_path: string;
}

export interface CallMetadata {
  call_id: string;
  duration_seconds: number;
  recording_url?: string;
  transcript?: string;
}

export interface Message {
  id: string;
  tenant_id: string;
  number_id: string;
  channel: Channel;
  direction: MessageDirection;
  from: string;
  to: string;
  text: string;
  agent?: string;
  attachments?: FileAttachment[];
  reply_to?: string;
  artifact?: ArtifactRef;
  call_metadata?: CallMetadata;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface FileAttachment {
  filename: string;
  mime_type: string;
  size_bytes: number;
  url?: string;
  local_path?: string;
}

// ─── Tool Taxonomy ──────────────────────────────────────────────────────────

export type ToolCategory = 'think' | 'search' | 'build' | 'create' | 'connect' | 'work' | 'talk';

// ─── Provider ───────────────────────────────────────────────────────────────

export type IntegrationMethod = 'browser' | 'api' | 'sdk' | 'local';

export interface ProviderTier {
  name: string;
  limits: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  company: string;
  url: string;
  category: ToolCategory;
  subcategory?: string;
  integration_method: IntegrationMethod;
  capabilities: string[];
  tiers: ProviderTier[];
  priority: number;
  enabled: boolean;
  affiliate?: {
    program_url?: string;
    commission_type?: 'one-time' | 'recurring';
    has_existing_program: boolean;
  };
}

// ─── Agent Blueprint ────────────────────────────────────────────────────────

export interface VoiceSettings {
  voice: string;
  style?: string;
  language?: string;
}

export interface AgentBlueprint {
  name: string;
  description: string;
  provider_priority: string[];
  tools: string[];
  channels: Channel[];
  routing_keywords: string[];
  temperature: number;
  voice_settings?: VoiceSettings;
  system_prompt: string;
}

// ─── Recipe ─────────────────────────────────────────────────────────────────

export type RecipeStepType = 'agent' | 'integration_read' | 'integration_write' | 'artifact_delivery' | 'notification';

export interface RecipeStep {
  name: string;
  type?: RecipeStepType;
  agent?: string;
  provider?: string;
  integration?: string;
  action?: string;
  channel?: Channel;
  input: string | string[];
  output: string;
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  gate?: 'human_approval' | 'auto';
}

export interface RecipeTrigger {
  type: 'manual' | 'schedule' | 'platform_event' | 'voice_note' | 'message';
  channel?: Channel;
  cron?: string;
  platform?: string;
  event?: string;
  filter?: string;
}

export interface RecipeMarketplace {
  id: string;
  creator: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  forked_from?: string;
  required_tools: string[];
  optional_tools?: string[];
  pricing: {
    type: 'free' | 'one_time' | 'subscription';
    price?: number;
    currency?: string;
  };
  stats?: {
    deployments: number;
    avg_rating: number;
    reviews: number;
  };
}

export interface Recipe {
  name: string;
  description: string;
  trigger?: RecipeTrigger;
  steps: RecipeStep[];
  marketplace?: RecipeMarketplace;
}

// ─── Tenant ─────────────────────────────────────────────────────────────────

export interface TenantNumber {
  phone_number: string;
  telnyx_id: string;
  country: string;
  locality?: string;
  capabilities: ('voice_inbound' | 'voice_outbound' | 'sms' | 'whatsapp')[];
  max_agents: number;
  agents: string[];
  voice_settings?: {
    default_voice: string;
    language: string;
    transcription_model: string;
    llm_endpoint: string;
    greeting: string;
    fallback_llm?: string;
  };
}

export type TranscriptionEngine = 'telnyx' | 'deepgram_nova3_batch' | 'deepgram_nova3_premium' | 'local_whisper';

export interface TenantTranscription {
  live_calls: {
    engine: 'telnyx';
    model: string;
  };
  voice_notes: {
    engine: 'auto' | TranscriptionEngine;
    fallback: TranscriptionEngine;
    privacy_mode: boolean;
  };
  local_whisper: {
    enabled: boolean;
    model: string;
    max_audio_length: number;
  };
  deepgram?: {
    mode: 'batch' | 'streaming';
    model: string;
    features: {
      diarization: boolean;
      language_detection: boolean;
      smart_formatting: boolean;
    };
  };
}

export type CloudProvider = 'google_drive' | 'onedrive' | 'notion' | 'github' | 'dropbox';

export interface ArtifactDestinations {
  defaults: Record<string, CloudProvider>;
  overrides?: Array<{
    match: string;
    destination: CloudProvider;
    folder?: string;
    convert_to?: string;
  }>;
  notifications: {
    primary: Channel;
    secondary?: Channel;
    include_thumbnail: boolean;
    include_preview_link: boolean;
  };
}

export interface Artifact {
  id: string;
  tenant_id: string;
  number_id: string;
  recipe_id?: string;
  recipe_step?: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  created_at: string;
  local_path: string;
  cloud_url?: string;
  cloud_provider?: CloudProvider;
  cloud_file_id?: string;
  preview_url?: string;
  thumbnail_path?: string;
  thumbnail_url?: string;
  notified_via: string[];
  notification_sent_at?: string;
  tools_used: string[];
  generation_time_ms: number;
  tags: string[];
}

export type PlatformName =
  | 'google_drive' | 'gmail' | 'gcal'
  | 'onedrive' | 'outlook'
  | 'notion' | 'slack' | 'linear' | 'monday'
  | 'github' | 'figma' | 'airtable'
  | 'salesforce' | 'hubspot' | 'shopify'
  | 'zapier';

export type AuthMethod = 'oauth2' | 'api_key' | 'webhook';

export interface PlatformIntegration {
  id: string;
  platform: PlatformName;
  auth_method: AuthMethod;
  scopes: string[];
  token_encrypted: string;
  capabilities: {
    artifact_destination: boolean;
    context_source: boolean;
    recipe_trigger: boolean;
    recipe_action: boolean;
    notification_channel: boolean;
    preview_surface: boolean;
  };
  config: {
    default_folder?: string;
    watch_folders?: string[];
    notification_preferences?: Record<string, unknown>;
  };
}

export interface TenantConfig {
  id: string;
  name: string;
  tier: 'free' | 'starter' | 'pro' | 'business' | 'agency';
  numbers: TenantNumber[];
  transcription: TenantTranscription;
  artifact_destinations: ArtifactDestinations;
  integrations: PlatformIntegration[];
  created_at: string;
  updated_at: string;
}

// ─── Queue / Routing ────────────────────────────────────────────────────────

export type QueuePriority = 'voice' | 'chat' | 'background';

export interface QueueMessage {
  id: string;
  stream: string;
  priority: QueuePriority;
  message: Message;
  created_at: string;
  attempts: number;
  max_attempts: number;
}

export interface RoutingDecision {
  agent: string;
  provider: string;
  confidence: number;
  reasoning: string;
  fallback_providers: string[];
}
