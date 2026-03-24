/**
 * SpokeStack ERP integration adapter.
 *
 * Allows AgentVBX to read/write SpokeStack data and route
 * messages back to the ERP for review callbacks.
 *
 * Implements the IntegrationAdapter interface from adapter.ts.
 */

import { createHmac } from 'node:crypto';
import { createLogger } from './logger.js';
import type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationRecord,
  UploadResult,
} from './adapter.js';

const logger = createLogger('spokestack');

export interface SpokeStackConfig {
  erpUrl: string;
  serviceKey: string;
  webhookSecret: string;
}

export class SpokeStackAdapter implements IntegrationAdapter {
  readonly id = 'spokestack';
  readonly name = 'SpokeStack ERP';
  readonly platform = 'spokestack';
  private apiKey?: string;
  private baseUrl = 'https://app.spokestack.com';
  private webhookSecret = '';

  async initialize(credentials: IntegrationCredentials): Promise<void> {
    this.apiKey = credentials.api_key;
    if (credentials.access_token) {
      this.baseUrl = credentials.access_token; // Overload for base URL
    }
    logger.info('SpokeStack adapter initialized');
  }

  /**
   * Initialize with explicit config (alternative to credentials-based init).
   */
  initializeWithConfig(config: SpokeStackConfig): void {
    this.apiKey = config.serviceKey;
    this.baseUrl = config.erpUrl;
    this.webhookSecret = config.webhookSecret;
    logger.info({ url: this.baseUrl }, 'SpokeStack adapter initialized with config');
  }

  async isConnected(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await this.request('/api/v1/service/health');
      return !!res.status;
    } catch {
      return false;
    }
  }

  /**
   * List ERP resources (briefs, reviews, tasks, etc.).
   * Use params.resource to specify resource type.
   */
  async list(params?: Record<string, unknown>): Promise<IntegrationRecord[]> {
    const resource = (params?.resource as string) ?? 'briefs';
    const orgId = params?.orgId as string | undefined;

    const queryParts: string[] = [];
    for (const [k, v] of Object.entries(params ?? {})) {
      if (k !== 'resource' && k !== 'orgId' && v != null) {
        queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

    const data = await this.request(`/api/v1/service/${resource}${query}`, {
      headers: orgId ? { 'X-Organization-Id': orgId } : undefined,
    });

    const items = data.data ?? data;
    return (Array.isArray(items) ? items : [items]).map(
      (item: Record<string, unknown>) => ({
        id: String(item.id ?? ''),
        fields: item,
        created_at: item.created_at as string | undefined,
        updated_at: item.updated_at as string | undefined,
      }),
    );
  }

  /**
   * Read a single ERP record.
   * ID format: "resource:id" (e.g., "briefs:abc123").
   */
  async read(id: string): Promise<IntegrationRecord | null> {
    const [resource, recordId] = id.includes(':') ? id.split(':') : ['briefs', id];
    if (!recordId) return null;

    try {
      const data = await this.request(`/api/v1/service/${resource}/${recordId}`);
      return {
        id: String(data.id ?? recordId),
        fields: data,
        created_at: data.created_at as string | undefined,
        updated_at: data.updated_at as string | undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a new ERP record.
   * data.name is the resource type. data.fields carries the payload.
   */
  async create(data: {
    name: string;
    content?: Buffer | string;
    mime_type?: string;
    parent_id?: string;
    fields?: Record<string, unknown>;
  }): Promise<UploadResult | IntegrationRecord> {
    const resource = data.name;
    const orgId = data.fields?.orgId as string | undefined;
    const userId = data.fields?.userId as string | undefined;

    const body = { ...data.fields };
    delete body.orgId;
    delete body.userId;

    const headers: Record<string, string> = {};
    if (orgId) headers['X-Organization-Id'] = orgId;
    if (userId) headers['X-User-Id'] = userId;

    const result = await this.request(`/api/v1/service/${resource}`, {
      method: 'POST',
      body,
      headers,
    });

    return {
      id: String(result.id ?? ''),
      fields: result,
      created_at: result.created_at as string | undefined,
      updated_at: result.updated_at as string | undefined,
    };
  }

  /**
   * Update an ERP record.
   * ID format: "resource:id" (e.g., "briefs:abc123").
   */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    const [resource, recordId] = id.includes(':') ? id.split(':') : ['briefs', id];
    const orgId = data.orgId as string | undefined;
    const userId = data.userId as string | undefined;

    const body = { ...data };
    delete body.orgId;
    delete body.userId;

    const headers: Record<string, string> = {};
    if (orgId) headers['X-Organization-Id'] = orgId;
    if (userId) headers['X-User-Id'] = userId;

    return this.request(`/api/v1/service/${resource}/${recordId}`, {
      method: 'PATCH',
      body,
      headers,
    });
  }

  async delete(id: string): Promise<void> {
    const [resource, recordId] = id.includes(':') ? id.split(':') : ['briefs', id];
    await this.request(`/api/v1/service/${resource}/${recordId}`, { method: 'DELETE' });
    logger.info({ resource, recordId }, 'SpokeStack record deleted');
  }

  async disconnect(): Promise<void> {
    this.apiKey = undefined;
    logger.info('SpokeStack adapter disconnected');
  }

  // ─── SpokeStack-specific methods ──────────────────────────────────────

  /**
   * Send a review decision back to the ERP (Contract D1).
   */
  async sendReviewCallback(params: {
    canvasRunId: string;
    canvasNodeId: string;
    decision: 'APPROVED' | 'REVISION_REQUESTED' | 'REJECTED' | 'SKIPPED';
    notes?: string;
    respondedVia: string;
    respondedByPhone: string;
  }): Promise<void> {
    const payload = {
      canvas_run_id: params.canvasRunId,
      canvas_node_id: params.canvasNodeId,
      decision: params.decision,
      notes: params.notes,
      responded_via: params.respondedVia,
      responded_by_phone: params.respondedByPhone,
      responded_at: new Date().toISOString(),
    };

    const headers: Record<string, string> = {};
    if (this.webhookSecret) {
      headers['X-Webhook-Signature'] = this.signPayload(JSON.stringify(payload));
    }

    await this.request('/api/v1/service/vbx/review-callback', {
      method: 'POST',
      body: payload,
      headers,
    });

    logger.info(
      { canvasRunId: params.canvasRunId, decision: params.decision },
      'Review callback sent',
    );
  }

  /**
   * Send an execution question response back to the ERP (Contract D2).
   */
  async sendQuestionCallback(params: {
    canvasRunId: string;
    canvasNodeId: string;
    answer: string;
    respondedVia: string;
    respondedByPhone: string;
  }): Promise<void> {
    const payload = {
      canvas_run_id: params.canvasRunId,
      canvas_node_id: params.canvasNodeId,
      answer: params.answer,
      responded_via: params.respondedVia,
      responded_by_phone: params.respondedByPhone,
      responded_at: new Date().toISOString(),
    };

    await this.request('/api/v1/service/vbx/question-callback', {
      method: 'POST',
      body: payload,
    });

    logger.info(
      { canvasRunId: params.canvasRunId },
      'Question callback sent',
    );
  }

  /**
   * Sign a payload with HMAC-SHA256 for webhook verification.
   */
  signPayload(payload: string): string {
    return createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async request(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Record<string, any>> {
    if (!this.apiKey) throw new Error('SpokeStack not authenticated');

    const { method = 'GET', body, headers: extraHeaders } = options;
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };

    if (body) fetchOptions.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, fetchOptions);

    if (!res.ok) {
      const error = await res.text();
      logger.error({ status: res.status, path }, 'SpokeStack API error');
      throw new Error(`SpokeStack API error ${res.status}: ${error}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
