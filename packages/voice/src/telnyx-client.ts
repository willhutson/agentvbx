/**
 * Telnyx client — phone number provisioning, voice AI, call control.
 *
 * This module wraps the Telnyx API for:
 * - Searching and provisioning phone numbers by country/area code
 * - Starting/managing Voice AI agents on calls
 * - Call control operations (answer, hangup, transfer, record)
 * - SMS/MMS sending
 */

import { createLogger } from './logger.js';

const logger = createLogger('telnyx-client');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TelnyxConfig {
  api_key: string;
  base_url?: string;
}

export interface NumberSearchParams {
  country_code: string;
  locality?: string;
  area_code?: string;
  features?: ('voice' | 'sms' | 'mms' | 'fax')[];
  limit?: number;
}

export interface AvailableNumber {
  phone_number: string;
  locality: string;
  region: string;
  country_code: string;
  features: string[];
  monthly_cost: string;
}

export interface ProvisionedNumber {
  id: string;
  phone_number: string;
  connection_id: string;
  status: string;
}

export interface VoiceAIConfig {
  instructions: string;
  voice: string;
  language?: string;
  transcription_model?: string;
  llm_endpoint?: string;
}

export interface CallEvent {
  call_id: string;
  event_type: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  timestamp: string;
  payload: Record<string, unknown>;
}

// ─── Telnyx Client ──────────────────────────────────────────────────────────

export class TelnyxClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: TelnyxConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.telnyx.com/v2';
  }

  /**
   * Search for available phone numbers by country and locality.
   */
  async searchNumbers(params: NumberSearchParams): Promise<AvailableNumber[]> {
    const query = new URLSearchParams();
    query.set('filter[country_code]', params.country_code);
    if (params.locality) query.set('filter[locality]', params.locality);
    if (params.area_code) query.set('filter[national_destination_code]', params.area_code);
    if (params.features) {
      for (const f of params.features) {
        query.append('filter[features][]', f);
      }
    }
    query.set('filter[limit]', String(params.limit ?? 5));

    const res = await this.request(`/available_phone_numbers?${query.toString()}`);
    const data = res.data ?? [];

    return data.map((n: Record<string, any>) => ({
      phone_number: n.phone_number as string,
      locality: n.locality as string ?? '',
      region: n.region_information?.[0]?.region_name ?? '',
      country_code: params.country_code,
      features: (n.features ?? []) as string[],
      monthly_cost: n.cost_information?.monthly_cost ?? 'unknown',
    }));
  }

  /**
   * Provision (purchase) a phone number.
   */
  async provisionNumber(phoneNumber: string, connectionId: string): Promise<ProvisionedNumber> {
    const res = await this.request('/phone_numbers', {
      method: 'POST',
      body: { phone_number: phoneNumber, connection_id: connectionId },
    });

    logger.info({ phone_number: phoneNumber }, 'Number provisioned');
    return {
      id: res.data.id,
      phone_number: res.data.phone_number,
      connection_id: connectionId,
      status: res.data.status,
    };
  }

  /**
   * Start a Voice AI assistant on an active call.
   */
  async startVoiceAI(callId: string, config: VoiceAIConfig): Promise<void> {
    await this.request(`/calls/${callId}/actions/ai_assistant_start`, {
      method: 'POST',
      body: {
        assistant: {
          instructions: config.instructions,
        },
        voice: config.voice,
        transcription: {
          model: config.transcription_model ?? 'distil-whisper/distil-large-v2',
        },
      },
    });

    logger.info({ callId, voice: config.voice }, 'Voice AI started on call');
  }

  /**
   * Answer an inbound call.
   */
  async answerCall(callId: string): Promise<void> {
    await this.request(`/calls/${callId}/actions/answer`, { method: 'POST', body: {} });
    logger.info({ callId }, 'Call answered');
  }

  /**
   * Hang up a call.
   */
  async hangupCall(callId: string): Promise<void> {
    await this.request(`/calls/${callId}/actions/hangup`, { method: 'POST', body: {} });
    logger.info({ callId }, 'Call hung up');
  }

  /**
   * Transfer a call to another number.
   */
  async transferCall(callId: string, to: string): Promise<void> {
    await this.request(`/calls/${callId}/actions/transfer`, {
      method: 'POST',
      body: { to },
    });
    logger.info({ callId, to }, 'Call transferred');
  }

  /**
   * Start recording a call.
   */
  async startRecording(callId: string): Promise<void> {
    await this.request(`/calls/${callId}/actions/record_start`, {
      method: 'POST',
      body: { format: 'mp3', channels: 'dual' },
    });
    logger.info({ callId }, 'Recording started');
  }

  /**
   * Initiate an outbound call.
   */
  async makeCall(from: string, to: string, connectionId: string): Promise<string> {
    const res = await this.request('/calls', {
      method: 'POST',
      body: {
        connection_id: connectionId,
        from,
        to,
        answering_machine_detection: 'detect',
      },
    });

    const callId = res.data.call_control_id;
    logger.info({ callId, from, to }, 'Outbound call initiated');
    return callId;
  }

  /**
   * Send an SMS message.
   */
  async sendSMS(from: string, to: string, text: string): Promise<string> {
    const res = await this.request('/messages', {
      method: 'POST',
      body: { from, to, text, type: 'SMS' },
    });

    const messageId = res.data.id;
    logger.info({ messageId, from, to }, 'SMS sent');
    return messageId;
  }

  /**
   * Make an authenticated request to the Telnyx API.
   */
  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ data: Record<string, any> & Record<string, any>[] }> {
    const { method = 'GET', body } = options;
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOptions);

    if (!res.ok) {
      const errorText = await res.text();
      logger.error({ status: res.status, path, errorText }, 'Telnyx API error');
      throw new Error(`Telnyx API error ${res.status}: ${errorText}`);
    }

    return res.json() as Promise<{ data: Record<string, any> & Record<string, any>[] }>;
  }
}
