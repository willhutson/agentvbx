/**
 * Notion integration adapter.
 *
 * Uses the Notion API for page and database operations.
 * Primary use case: meeting notes, knowledge base, and artifact storage.
 */

import { createLogger } from './logger.js';
import type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationRecord,
} from './adapter.js';

const logger = createLogger('notion');

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export class NotionAdapter implements IntegrationAdapter {
  readonly id = 'notion';
  readonly name = 'Notion';
  readonly platform = 'notion';
  private apiKey?: string;

  async initialize(credentials: IntegrationCredentials): Promise<void> {
    this.apiKey = credentials.api_key ?? credentials.access_token;
    logger.info('Notion adapter initialized');
  }

  async isConnected(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await this.request('/users/me');
      return !!res.id;
    } catch {
      return false;
    }
  }

  /**
   * List pages or search across workspace.
   */
  async list(params?: Record<string, unknown>): Promise<IntegrationRecord[]> {
    const query = params?.query as string | undefined;
    const databaseId = params?.database_id as string | undefined;

    if (databaseId) {
      // Query a database
      const body: Record<string, unknown> = {
        page_size: params?.limit ?? 50,
      };

      const data = await this.request(`/databases/${databaseId}/query`, {
        method: 'POST',
        body,
      });

      return (data.results ?? []).map((page: Record<string, unknown>) => ({
        id: page.id as string,
        fields: this.extractPageProperties(page.properties as Record<string, unknown>),
        created_at: page.created_time as string,
        updated_at: page.last_edited_time as string,
      }));
    }

    // Search across workspace
    const body: Record<string, unknown> = {
      page_size: params?.limit ?? 25,
    };
    if (query) body.query = query;

    const data = await this.request('/search', { method: 'POST', body });

    return (data.results ?? []).map((item: Record<string, unknown>) => ({
      id: item.id as string,
      fields: {
        type: item.object,
        title: this.extractTitle(item),
        url: item.url,
      },
      created_at: item.created_time as string,
      updated_at: item.last_edited_time as string,
    }));
  }

  /**
   * Read a page by ID.
   */
  async read(id: string): Promise<IntegrationRecord | null> {
    try {
      const page = await this.request(`/pages/${id}`);
      return {
        id: page.id as string,
        fields: {
          ...this.extractPageProperties(page.properties as Record<string, unknown>),
          url: page.url,
        },
        created_at: page.created_time as string,
        updated_at: page.last_edited_time as string,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a new page in a database or as a child of another page.
   */
  async create(data: {
    name: string;
    content?: Buffer | string;
    parent_id?: string;
    fields?: Record<string, unknown>;
  }): Promise<IntegrationRecord> {
    const parentId = data.parent_id ?? (data.fields?.database_id as string);
    if (!parentId) throw new Error('parent_id (page or database) is required');

    const isDatabase = data.fields?.is_database !== false;
    const parent = isDatabase
      ? { database_id: parentId }
      : { page_id: parentId };

    const properties: Record<string, unknown> = {
      title: {
        title: [{ text: { content: data.name } }],
      },
    };

    // Add additional fields as properties
    if (data.fields) {
      for (const [key, value] of Object.entries(data.fields)) {
        if (key === 'database_id' || key === 'is_database') continue;
        properties[key] = { rich_text: [{ text: { content: String(value) } }] };
      }
    }

    const body: Record<string, unknown> = { parent, properties };

    // Add content as page body
    if (data.content) {
      const contentStr = Buffer.isBuffer(data.content) ? data.content.toString() : data.content;
      body.children = [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: contentStr } }],
          },
        },
      ];
    }

    const result = await this.request('/pages', { method: 'POST', body });

    logger.info({ id: result.id, name: data.name }, 'Notion page created');

    return {
      id: result.id as string,
      fields: { name: data.name, url: result.url },
      created_at: result.created_time as string,
    };
  }

  /**
   * Update page properties.
   */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'title') {
        properties[key] = { title: [{ text: { content: String(value) } }] };
      } else {
        properties[key] = { rich_text: [{ text: { content: String(value) } }] };
      }
    }

    return this.request(`/pages/${id}`, {
      method: 'PATCH',
      body: { properties },
    });
  }

  /**
   * Archive (soft-delete) a page.
   */
  async delete(id: string): Promise<void> {
    await this.request(`/pages/${id}`, {
      method: 'PATCH',
      body: { archived: true },
    });
    logger.info({ id }, 'Notion page archived');
  }

  async disconnect(): Promise<void> {
    this.apiKey = undefined;
    logger.info('Notion adapter disconnected');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private extractTitle(item: Record<string, unknown>): string {
    const props = item.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) return '';
    const titleProp = Object.values(props).find((p) => p.type === 'title');
    const titleArr = titleProp?.title as Array<{ plain_text: string }> | undefined;
    return titleArr?.[0]?.plain_text ?? '';
  }

  private extractPageProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!properties) return result;

    for (const [key, prop] of Object.entries(properties)) {
      const p = prop as Record<string, unknown>;
      switch (p.type) {
        case 'title':
          result[key] = (p.title as Array<{ plain_text: string }>)?.[0]?.plain_text ?? '';
          break;
        case 'rich_text':
          result[key] = (p.rich_text as Array<{ plain_text: string }>)?.[0]?.plain_text ?? '';
          break;
        case 'number':
          result[key] = p.number;
          break;
        case 'select':
          result[key] = (p.select as Record<string, string>)?.name;
          break;
        case 'checkbox':
          result[key] = p.checkbox;
          break;
        default:
          result[key] = p[p.type as string] ?? null;
      }
    }

    return result;
  }

  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new Error('Notion not authenticated');

    const { method = 'GET', body } = options;
    const fetchOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
    };

    if (body) fetchOptions.body = JSON.stringify(body);

    const res = await fetch(`${NOTION_API}${path}`, fetchOptions);

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Notion API error ${res.status}: ${error}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
