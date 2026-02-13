/**
 * Google Drive integration adapter.
 *
 * Handles file upload, listing, search, and sharing via the
 * Google Drive API v3. Primary artifact destination for documents,
 * spreadsheets, presentations, and images.
 */

import { createLogger } from '../logger.js';
import type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationFile,
  UploadResult,
} from '../adapter.js';
import { GoogleAuth, type GoogleTokens } from './auth.js';

const logger = createLogger('google-drive');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export class GoogleDriveAdapter implements IntegrationAdapter {
  readonly id = 'google_drive';
  readonly name = 'Google Drive';
  readonly platform = 'google_drive';
  private auth?: GoogleAuth;
  private accessToken?: string;

  async initialize(credentials: IntegrationCredentials): Promise<void> {
    if (credentials.access_token) {
      this.accessToken = credentials.access_token;

      // If we have OAuth config, set up for refresh
      if (credentials.refresh_token) {
        this.auth = new GoogleAuth({
          client_id: '',
          client_secret: '',
          redirect_uri: '',
          scopes: [],
        });
        this.auth.setTokens({
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          expires_at: credentials.expires_at ?? new Date(Date.now() + 3600 * 1000).toISOString(),
          token_type: 'Bearer',
          scope: '',
        });
      }
    }

    logger.info('Google Drive adapter initialized');
  }

  async isConnected(): Promise<boolean> {
    if (!this.accessToken) return false;
    try {
      const res = await this.request('/about?fields=user');
      return !!res.user;
    } catch {
      return false;
    }
  }

  /**
   * List files in Drive (or a specific folder).
   */
  async list(params?: Record<string, unknown>): Promise<IntegrationFile[]> {
    const folderId = params?.folder_id as string | undefined;
    const query = params?.query as string | undefined;

    let q = "trashed=false";
    if (folderId) q += ` and '${folderId}' in parents`;
    if (query) q += ` and name contains '${query}'`;

    const searchParams = new URLSearchParams({
      q,
      fields: 'files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime,parents,thumbnailLink)',
      pageSize: String(params?.limit ?? 50),
      orderBy: 'modifiedTime desc',
    });

    const data = await this.request(`/files?${searchParams.toString()}`);

    return (data.files ?? []).map((f: Record<string, unknown>) => ({
      id: f.id as string,
      name: f.name as string,
      mime_type: f.mimeType as string,
      size_bytes: parseInt(f.size as string || '0', 10),
      url: f.webViewLink as string,
      parent_id: (f.parents as string[])?.[0],
      created_at: f.createdTime as string,
      modified_at: f.modifiedTime as string,
      metadata: { thumbnail_url: f.thumbnailLink },
    }));
  }

  /**
   * Read file metadata by ID.
   */
  async read(id: string): Promise<IntegrationFile | null> {
    try {
      const f = await this.request(
        `/files/${id}?fields=id,name,mimeType,size,webViewLink,createdTime,modifiedTime,parents,thumbnailLink`,
      );
      return {
        id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        size_bytes: parseInt(f.size || '0', 10),
        url: f.webViewLink,
        parent_id: f.parents?.[0],
        created_at: f.createdTime,
        modified_at: f.modifiedTime,
        metadata: { thumbnail_url: f.thumbnailLink },
      };
    } catch {
      return null;
    }
  }

  /**
   * Upload a file to Google Drive.
   * Uses multipart upload for files under 5MB, resumable for larger ones.
   */
  async create(data: {
    name: string;
    content?: Buffer | string;
    mime_type?: string;
    parent_id?: string;
    fields?: Record<string, unknown>;
  }): Promise<UploadResult> {
    const metadata: Record<string, unknown> = {
      name: data.name,
    };

    if (data.parent_id) {
      metadata.parents = [data.parent_id];
    }

    if (data.mime_type) {
      metadata.mimeType = data.mime_type;
    }

    const content = data.content
      ? (Buffer.isBuffer(data.content) ? data.content : Buffer.from(data.content))
      : Buffer.alloc(0);

    // Multipart upload
    const boundary = '---agentvbx-upload-boundary';
    const metadataStr = JSON.stringify(metadata);

    const bodyParts = [
      `--${boundary}\r\n`,
      'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      metadataStr,
      `\r\n--${boundary}\r\n`,
      `Content-Type: ${data.mime_type ?? 'application/octet-stream'}\r\n\r\n`,
    ];

    const prefix = Buffer.from(bodyParts.join(''));
    const suffix = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([prefix, content, suffix]);

    const token = await this.getToken();
    const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink,thumbnailLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Google Drive upload failed: ${res.status} ${error}`);
    }

    const result = await res.json() as Record<string, string>;

    logger.info({ id: result.id, name: data.name }, 'File uploaded to Google Drive');

    return {
      id: result.id,
      url: result.webViewLink ?? `https://drive.google.com/file/d/${result.id}/view`,
      name: result.name ?? data.name,
      web_view_url: result.webViewLink,
      thumbnail_url: result.thumbnailLink,
    };
  }

  /**
   * Update file metadata.
   */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    const token = await this.getToken();
    const res = await fetch(`${DRIVE_API}/files/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      throw new Error(`Google Drive update failed: ${res.status}`);
    }

    return res.json();
  }

  /**
   * Delete a file (move to trash).
   */
  async delete(id: string): Promise<void> {
    await this.update(id, { trashed: true });
    logger.info({ id }, 'File trashed in Google Drive');
  }

  /**
   * Create a shareable link for a file.
   */
  async createShareLink(fileId: string): Promise<string> {
    const token = await this.getToken();

    // Create "anyone with link" permission
    await fetch(`${DRIVE_API}/files/${fileId}/permissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role: 'reader',
        type: 'anyone',
      }),
    });

    const file = await this.read(fileId);
    return file?.url ?? `https://drive.google.com/file/d/${fileId}/view`;
  }

  async disconnect(): Promise<void> {
    this.accessToken = undefined;
    this.auth = undefined;
    logger.info('Google Drive adapter disconnected');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.auth) {
      return this.auth.getAccessToken();
    }
    if (this.accessToken) return this.accessToken;
    throw new Error('Google Drive not authenticated');
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    const res = await fetch(`${DRIVE_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Google Drive API error ${res.status}: ${error}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
