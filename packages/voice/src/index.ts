/**
 * @agentvbx/voice — Telnyx telephony, Voice AI, call control, and transcription
 */

export { TelnyxClient } from './telnyx-client.js';
export type {
  TelnyxConfig,
  NumberSearchParams,
  AvailableNumber,
  ProvisionedNumber,
  VoiceAIConfig,
  CallEvent,
} from './telnyx-client.js';

export { TranscriptionRouter } from './transcription.js';
export type {
  TranscriptionTier,
  TranscriptionConfig,
  TranscriptionResult,
  TranscriptionSegment,
  SpeakerSegment,
} from './transcription.js';

export { createWebhookRouter } from './webhook-handler.js';
export type { TelnyxWebhookEvent, WebhookHandler } from './webhook-handler.js';
