/**
 * Monday.com integration adapter.
 *
 * Uses Monday.com's GraphQL API for board operations.
 * Key use case: voice-to-board updates (voice note → transcribe → extract → update Monday).
 */

import { createLogger } from './logger.js';
import type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationRecord,
  UploadResult,
} from './adapter.js';

const logger = createLogger('monday');

const MONDAY_API = 'https://api.monday.com/v2';

export class MondayAdapter implements IntegrationAdapter {
  readonly id = 'monday';
  readonly name = 'Monday.com';
  readonly platform = 'monday';
  private apiKey?: string;

  async initialize(credentials: IntegrationCredentials): Promise<void> {
    this.apiKey = credentials.api_key ?? credentials.access_token;
    logger.info('Monday.com adapter initialized');
  }

  async isConnected(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const data = await this.query('{ me { id name } }');
      return !!data.me?.id;
    } catch {
      return false;
    }
  }

  /**
   * List boards or items.
   */
  async list(params?: Record<string, unknown>): Promise<IntegrationRecord[]> {
    const boardId = params?.board_id as string | undefined;

    if (boardId) {
      // List items in a board
      const data = await this.query(`{
        boards(ids: [${boardId}]) {
          items_page(limit: ${params?.limit ?? 50}) {
            items {
              id
              name
              column_values { id title text value }
              created_at
              updated_at
            }
          }
        }
      }`);

      const items = data.boards?.[0]?.items_page?.items ?? [];
      return items.map((item: Record<string, unknown>) => ({
        id: item.id as string,
        fields: {
          name: item.name,
          ...(item.column_values as Array<{ id: string; title: string; text: string }>)?.reduce(
            (acc: Record<string, string>, col) => {
              acc[col.id] = col.text ?? '';
              return acc;
            },
            {},
          ),
        },
        created_at: item.created_at as string,
        updated_at: item.updated_at as string,
      }));
    }

    // List boards
    const data = await this.query(`{
      boards(limit: ${params?.limit ?? 25}) {
        id
        name
        state
        board_kind
        columns { id title type }
      }
    }`);

    return (data.boards ?? []).map((board: Record<string, unknown>) => ({
      id: board.id as string,
      fields: {
        name: board.name,
        state: board.state,
        kind: board.board_kind,
        columns: board.columns,
      },
    }));
  }

  /**
   * Read a single item by ID.
   */
  async read(id: string): Promise<IntegrationRecord | null> {
    const data = await this.query(`{
      items(ids: [${id}]) {
        id
        name
        column_values { id title text value }
        created_at
        updated_at
      }
    }`);

    const item = data.items?.[0];
    if (!item) return null;

    return {
      id: item.id,
      fields: {
        name: item.name,
        ...(item.column_values as Array<{ id: string; text: string }>)?.reduce(
          (acc: Record<string, string>, col) => {
            acc[col.id] = col.text ?? '';
            return acc;
          },
          {},
        ),
      },
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  /**
   * Create a new item on a board.
   */
  async create(data: {
    name: string;
    fields?: Record<string, unknown>;
    parent_id?: string;
  }): Promise<IntegrationRecord> {
    const boardId = data.parent_id ?? data.fields?.board_id;
    if (!boardId) throw new Error('board_id is required to create a Monday.com item');

    const columnValues = data.fields ? { ...data.fields } : {};
    delete columnValues.board_id;

    const mutation = `mutation {
      create_item(
        board_id: ${boardId}
        item_name: "${data.name.replace(/"/g, '\\"')}"
        column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}"
      ) {
        id
        name
        created_at
      }
    }`;

    const result = await this.query(mutation);
    const item = result.create_item;

    logger.info({ id: item?.id, name: data.name, board: boardId }, 'Monday.com item created');

    return {
      id: item?.id ?? '',
      fields: { name: data.name, ...columnValues },
      created_at: item?.created_at,
    };
  }

  /**
   * Update an item's column values.
   */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    const boardId = data.board_id;
    if (!boardId) throw new Error('board_id is required to update a Monday.com item');

    const columnValues = { ...data };
    delete columnValues.board_id;

    const mutation = `mutation {
      change_multiple_column_values(
        board_id: ${boardId}
        item_id: ${id}
        column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}"
      ) {
        id
        name
      }
    }`;

    return this.query(mutation);
  }

  async delete(id: string): Promise<void> {
    await this.query(`mutation { delete_item(item_id: ${id}) { id } }`);
    logger.info({ id }, 'Monday.com item deleted');
  }

  async disconnect(): Promise<void> {
    this.apiKey = undefined;
    logger.info('Monday.com adapter disconnected');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async query(query: string): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new Error('Monday.com not authenticated');

    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Monday.com API error ${res.status}: ${error}`);
    }

    const result = await res.json() as { data: Record<string, unknown>; errors?: unknown[] };
    if (result.errors) {
      throw new Error(`Monday.com GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  }
}
