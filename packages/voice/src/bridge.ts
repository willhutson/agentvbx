/**
 * Voice <-> Orchestrator bridge.
 *
 * Connects Telnyx voice webhooks to the orchestrator queue.
 * Handles inbound calls, transcriptions, and SMS → queue routing.
 * Sends voice AI responses and SMS replies back through Telnyx.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from './logger.js';
import type { TelnyxClient } from './telnyx-client.js';
import type { TranscriptionRouter } from './transcription.js';
import type { TelnyxWebhookEvent } from './webhook-handler.js';

const logger = createLogger('voice-bridge');

export interface VoiceBridgeConfig {
  tenant_id: string;
  number_id: string;
  default_voice?: string;
  default_greeting?: string;
  voice_ai_instructions?: string;
}

export interface MessagePublisher {
  handleMessage(message: {
    id: string;
    tenant_id: string;
    number_id: string;
    channel: 'voice' | 'sms';
    direction: 'inbound';
    from: string;
    to: string;
    text: string;
    timestamp: string;
    call_metadata?: {
      call_id: string;
      duration_seconds: number;
      recording_url?: string;
      transcript?: string;
    };
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

export class VoiceBridge {
  private telnyxClient: TelnyxClient;
  private transcriptionRouter: TranscriptionRouter;
  private publisher: MessagePublisher;
  private config: VoiceBridgeConfig;

  // Track active calls
  private activeCalls: Map<string, { from: string; to: string; startedAt: string }> = new Map();

  constructor(
    telnyxClient: TelnyxClient,
    transcriptionRouter: TranscriptionRouter,
    publisher: MessagePublisher,
    config: VoiceBridgeConfig,
  ) {
    this.telnyxClient = telnyxClient;
    this.transcriptionRouter = transcriptionRouter;
    this.publisher = publisher;
    this.config = config;
  }

  /**
   * Get webhook handlers that wire into the Telnyx webhook router.
   */
  getWebhookHandlers() {
    return {
      onInboundCall: (event: TelnyxWebhookEvent) => this.handleInboundCall(event),
      onCallAnswered: (event: TelnyxWebhookEvent) => this.handleCallAnswered(event),
      onCallHangup: (event: TelnyxWebhookEvent) => this.handleCallHangup(event),
      onTranscription: (event: TelnyxWebhookEvent) => this.handleTranscription(event),
      onSMSReceived: (event: TelnyxWebhookEvent) => this.handleSMSReceived(event),
      onRecordingSaved: (event: TelnyxWebhookEvent) => this.handleRecordingSaved(event),
      onVoiceAIEvent: (event: TelnyxWebhookEvent) => this.handleVoiceAIEvent(event),
    };
  }

  /**
   * Send an SMS response.
   */
  async sendSMSResponse(from: string, to: string, text: string): Promise<void> {
    await this.telnyxClient.sendSMS(from, to, text);
  }

  // ─── Webhook Handlers ────────────────────────────────────────────────

  private async handleInboundCall(event: TelnyxWebhookEvent): Promise<void> {
    const { payload } = event.data;
    const callId = payload.call_control_id!;
    const from = payload.from!;
    const to = payload.to!;

    logger.info({ callId, from, to }, 'Inbound call received');

    this.activeCalls.set(callId, { from, to, startedAt: new Date().toISOString() });

    // Answer the call
    await this.telnyxClient.answerCall(callId);

    // Start recording
    await this.telnyxClient.startRecording(callId);

    // Start Voice AI assistant
    await this.telnyxClient.startVoiceAI(callId, {
      instructions: this.config.voice_ai_instructions ?? 'You are a helpful AI assistant. Be concise and friendly.',
      voice: this.config.default_voice ?? 'alloy',
    });

    logger.info({ callId }, 'Voice AI started on inbound call');
  }

  private async handleCallAnswered(event: TelnyxWebhookEvent): Promise<void> {
    const callId = event.data.payload.call_control_id;
    logger.info({ callId }, 'Call answered');
  }

  private async handleCallHangup(event: TelnyxWebhookEvent): Promise<void> {
    const callId = event.data.payload.call_control_id!;
    const callInfo = this.activeCalls.get(callId);

    if (callInfo) {
      const duration = Math.floor((Date.now() - new Date(callInfo.startedAt).getTime()) / 1000);
      logger.info({ callId, duration, from: callInfo.from }, 'Call ended');
      this.activeCalls.delete(callId);
    }
  }

  private async handleTranscription(event: TelnyxWebhookEvent): Promise<void> {
    const { payload } = event.data;
    const callId = payload.call_control_id!;
    const text = payload.text as string ?? '';
    const callInfo = this.activeCalls.get(callId);

    if (!text.trim()) return;

    logger.info({ callId, preview: text.substring(0, 100) }, 'Call transcription received');

    // Publish transcription as a voice message to the queue
    const message = {
      id: uuid(),
      tenant_id: this.config.tenant_id,
      number_id: this.config.number_id,
      channel: 'voice' as const,
      direction: 'inbound' as const,
      from: callInfo?.from ?? 'unknown',
      to: callInfo?.to ?? 'unknown',
      text,
      timestamp: event.data.occurred_at,
      call_metadata: {
        call_id: callId,
        duration_seconds: 0,
        transcript: text,
      },
      metadata: { event_type: 'transcription' },
    };

    await this.publisher.handleMessage(message);
  }

  private async handleSMSReceived(event: TelnyxWebhookEvent): Promise<void> {
    const { payload } = event.data;
    const from = payload.from!;
    const to = payload.to!;
    const text = payload.text as string ?? '';

    logger.info({ from, to, preview: text.substring(0, 50) }, 'SMS received');

    const message = {
      id: uuid(),
      tenant_id: this.config.tenant_id,
      number_id: this.config.number_id,
      channel: 'sms' as const,
      direction: 'inbound' as const,
      from,
      to,
      text,
      timestamp: event.data.occurred_at,
      metadata: {
        media: payload.media,
      },
    };

    await this.publisher.handleMessage(message);
  }

  private async handleRecordingSaved(event: TelnyxWebhookEvent): Promise<void> {
    const { payload } = event.data;
    const callId = payload.call_control_id;
    const recordingUrl = (payload.recording_urls as { mp3?: string })?.mp3;

    logger.info({ callId, recordingUrl }, 'Call recording saved');
  }

  private async handleVoiceAIEvent(event: TelnyxWebhookEvent): Promise<void> {
    const { event_type, payload } = event.data;
    const callId = payload.call_control_id;

    logger.info({ callId, event_type }, 'Voice AI event');
  }
}
