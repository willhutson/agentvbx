/**
 * GitHub integration adapter.
 *
 * Uses GitHub REST API for repository operations.
 * Primary use case: code artifact destination, issue tracking, PR creation.
 */

import { createLogger } from './logger.js';
import type {
  IntegrationAdapter,
  IntegrationCredentials,
  IntegrationFile,
  IntegrationRecord,
  UploadResult,
} from './adapter.js';

const logger = createLogger('github');

const GITHUB_API = 'https://api.github.com';

export class GitHubAdapter implements IntegrationAdapter {
  readonly id = 'github';
  readonly name = 'GitHub';
  readonly platform = 'github';
  private token?: string;

  async initialize(credentials: IntegrationCredentials): Promise<void> {
    this.token = credentials.access_token ?? credentials.api_key;
    logger.info('GitHub adapter initialized');
  }

  async isConnected(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await this.request('/user');
      return !!res.login;
    } catch {
      return false;
    }
  }

  /**
   * List repos or files in a repo.
   */
  async list(params?: Record<string, unknown>): Promise<(IntegrationFile | IntegrationRecord)[]> {
    const repo = params?.repo as string | undefined;
    const path = params?.path as string | undefined;

    if (repo && path !== undefined) {
      // List files in a repo path
      const data = await this.request(`/repos/${repo}/contents/${path ?? ''}`);
      const items = Array.isArray(data) ? data : [data];
      return items.map((f: Record<string, unknown>) => ({
        id: f.sha as string,
        name: f.name as string,
        mime_type: f.type === 'dir' ? 'inode/directory' : 'application/octet-stream',
        size_bytes: (f.size as number) ?? 0,
        url: f.html_url as string,
        metadata: { download_url: f.download_url, type: f.type },
      }));
    }

    // List user repos
    const data = await this.request(`/user/repos?per_page=${params?.limit ?? 30}&sort=updated`);
    return (data as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      fields: {
        name: r.full_name,
        description: r.description,
        language: r.language,
        private: r.private,
        url: r.html_url,
        default_branch: r.default_branch,
        stars: r.stargazers_count,
      },
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    }));
  }

  /**
   * Read a file from a repo.
   */
  async read(id: string): Promise<IntegrationFile | null> {
    // id format: "owner/repo:path/to/file"
    const [repo, filePath] = id.split(':');
    if (!repo || !filePath) return null;

    try {
      const data = await this.request(`/repos/${repo}/contents/${filePath}`);
      return {
        id: data.sha as string,
        name: data.name as string,
        mime_type: 'application/octet-stream',
        size_bytes: data.size as number,
        url: data.html_url as string,
        metadata: {
          content: data.content,
          encoding: data.encoding,
          download_url: data.download_url,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Create or update a file in a repo.
   */
  async create(data: {
    name: string;
    content?: Buffer | string;
    parent_id?: string;
    fields?: Record<string, unknown>;
  }): Promise<UploadResult> {
    const repo = data.parent_id ?? (data.fields?.repo as string);
    const path = data.fields?.path as string ?? data.name;
    const branch = data.fields?.branch as string ?? 'main';
    const message = data.fields?.commit_message as string ?? `Add ${data.name} via AGENTVBX`;

    if (!repo) throw new Error('repo is required (owner/repo format)');

    const contentStr = data.content
      ? (Buffer.isBuffer(data.content) ? data.content : Buffer.from(data.content))
      : Buffer.alloc(0);

    // Check if file exists (for updates)
    let sha: string | undefined;
    try {
      const existing = await this.request(`/repos/${repo}/contents/${path}?ref=${branch}`);
      sha = existing.sha as string;
    } catch {
      // File doesn't exist, that's fine
    }

    const body: Record<string, unknown> = {
      message,
      content: contentStr.toString('base64'),
      branch,
    };

    if (sha) body.sha = sha;

    const result = await this.request(`/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      body,
    });

    logger.info({ repo, path }, 'File committed to GitHub');

    return {
      id: result.content?.sha as string ?? '',
      url: result.content?.html_url as string ?? '',
      name: path,
      web_view_url: result.content?.html_url as string,
    };
  }

  /**
   * Create a GitHub issue.
   */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    const repo = data.repo as string;
    if (!repo) throw new Error('repo is required');

    // id is issue number for updates
    return this.request(`/repos/${repo}/issues/${id}`, {
      method: 'PATCH',
      body: data,
    });
  }

  async delete(_id: string): Promise<void> {
    logger.warn('GitHub file deletion not implemented — use create with empty content');
  }

  /**
   * Create a GitHub issue.
   */
  async createIssue(repo: string, title: string, body: string, labels?: string[]): Promise<IntegrationRecord> {
    const result = await this.request(`/repos/${repo}/issues`, {
      method: 'POST',
      body: { title, body, labels },
    });

    return {
      id: String(result.number),
      fields: {
        title: result.title,
        url: result.html_url,
        state: result.state,
      },
      created_at: result.created_at as string,
    };
  }

  async disconnect(): Promise<void> {
    this.token = undefined;
    logger.info('GitHub adapter disconnected');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error('GitHub not authenticated');

    const { method = 'GET', body } = options;
    const fetchOptions: RequestInit = {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };

    if (body) fetchOptions.body = JSON.stringify(body);

    const res = await fetch(`${GITHUB_API}${path}`, fetchOptions);

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${error}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
