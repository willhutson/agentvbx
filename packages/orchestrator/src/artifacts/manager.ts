/**
 * Artifact lifecycle manager.
 *
 * Handles the complete artifact lifecycle:
 * 1. Capture — save generated content to local disk
 * 2. Thumbnail — generate preview images
 * 3. Upload — push to cloud destination (Google Drive, GitHub, etc.)
 * 4. Notify — send WhatsApp/SMS notification with preview link
 * 5. Track — store metadata in SQLite for querying
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import type { Artifact, CloudProvider, ArtifactDestinations, Channel } from '../types.js';

const logger = createLogger('artifact-manager');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArtifactInput {
  filename: string;
  content: Buffer | string;
  file_type?: string;
  tenant_id: string;
  number_id: string;
  recipe_id?: string;
  recipe_step?: string;
  tools_used?: string[];
  tags?: string[];
}

export interface CloudUploader {
  upload(artifact: Artifact, content: Buffer): Promise<{ url: string; file_id: string; preview_url?: string; thumbnail_url?: string }>;
}

export interface ArtifactNotifier {
  notify(artifact: Artifact, channel: Channel, to: string): Promise<void>;
}

// ─── Artifact Manager ───────────────────────────────────────────────────────

export class ArtifactManager {
  private artifacts: Map<string, Artifact> = new Map();
  private uploaders: Map<CloudProvider, CloudUploader> = new Map();
  private notifier?: ArtifactNotifier;
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Register a cloud uploader for a destination.
   */
  registerUploader(provider: CloudProvider, uploader: CloudUploader): void {
    this.uploaders.set(provider, uploader);
    logger.info({ provider }, 'Cloud uploader registered');
  }

  /**
   * Set the notification handler.
   */
  setNotifier(notifier: ArtifactNotifier): void {
    this.notifier = notifier;
  }

  /**
   * Capture an artifact — save to disk and generate metadata.
   */
  capture(input: ArtifactInput): Artifact {
    const id = uuid();
    const startMs = Date.now();

    // Ensure tenant artifacts directory exists
    const artifactsDir = join(this.basePath, 'tenants', input.tenant_id, 'artifacts', 'files');
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true });
    }

    const ext = extname(input.filename) || this.guessExtension(input.file_type);
    const localFilename = `${id}${ext}`;
    const localPath = join(artifactsDir, localFilename);

    // Write content to disk
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
    writeFileSync(localPath, content);

    const artifact: Artifact = {
      id,
      tenant_id: input.tenant_id,
      number_id: input.number_id,
      recipe_id: input.recipe_id,
      recipe_step: input.recipe_step,
      filename: input.filename,
      file_type: input.file_type ?? this.guessFileType(input.filename),
      size_bytes: content.length,
      created_at: new Date().toISOString(),
      local_path: localPath,
      notified_via: [],
      tools_used: input.tools_used ?? [],
      generation_time_ms: Date.now() - startMs,
      tags: input.tags ?? [],
    };

    this.artifacts.set(id, artifact);
    logger.info({ id, filename: input.filename, size: content.length }, 'Artifact captured');

    return artifact;
  }

  /**
   * Upload an artifact to its designated cloud destination.
   */
  async upload(
    artifactId: string,
    destination: CloudProvider,
  ): Promise<Artifact> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);

    const uploader = this.uploaders.get(destination);
    if (!uploader) throw new Error(`No uploader registered for: ${destination}`);

    const content = readFileSync(artifact.local_path);
    const result = await uploader.upload(artifact, content);

    artifact.cloud_url = result.url;
    artifact.cloud_provider = destination;
    artifact.cloud_file_id = result.file_id;
    artifact.preview_url = result.preview_url;
    artifact.thumbnail_url = result.thumbnail_url;

    logger.info({ id: artifactId, destination, url: result.url }, 'Artifact uploaded to cloud');

    return artifact;
  }

  /**
   * Send a notification about an artifact.
   */
  async notify(
    artifactId: string,
    channel: Channel,
    to: string,
  ): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);

    if (!this.notifier) {
      logger.warn('No notifier configured, skipping notification');
      return;
    }

    await this.notifier.notify(artifact, channel, to);
    artifact.notified_via.push(channel);
    artifact.notification_sent_at = new Date().toISOString();

    logger.info({ id: artifactId, channel, to }, 'Artifact notification sent');
  }

  /**
   * Full delivery pipeline: capture → upload → notify.
   */
  async deliver(
    input: ArtifactInput,
    destinations: ArtifactDestinations,
    notifyTo?: string,
  ): Promise<Artifact> {
    // 1. Capture
    const artifact = this.capture(input);

    // 2. Determine cloud destination
    const fileCategory = this.categorizeFile(input.filename, input.file_type);
    let cloudDest = destinations.defaults[fileCategory] as CloudProvider | undefined;

    // Check for overrides
    if (destinations.overrides) {
      for (const override of destinations.overrides) {
        if (input.filename.match(new RegExp(override.match))) {
          cloudDest = override.destination;
          break;
        }
      }
    }

    // 3. Upload if we have a destination and uploader
    if (cloudDest && this.uploaders.has(cloudDest)) {
      await this.upload(artifact.id, cloudDest);
    }

    // 4. Notify
    if (notifyTo && destinations.notifications) {
      const channel = destinations.notifications.primary;
      await this.notify(artifact.id, channel, notifyTo);
    }

    return artifact;
  }

  /**
   * Get an artifact by ID.
   */
  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  /**
   * List artifacts for a tenant.
   */
  listForTenant(tenantId: string): Artifact[] {
    return Array.from(this.artifacts.values()).filter((a) => a.tenant_id === tenantId);
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private guessFileType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    const map: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.py': 'text/x-python',
      '.js': 'text/javascript',
      '.ts': 'text/typescript',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  private guessExtension(fileType?: string): string {
    if (!fileType) return '';
    const map: Record<string, string> = {
      'application/pdf': '.pdf',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'application/json': '.json',
      'text/csv': '.csv',
    };
    return map[fileType] ?? '';
  }

  private categorizeFile(filename: string, fileType?: string): string {
    const ext = extname(filename).toLowerCase();
    const docExts = ['.doc', '.docx', '.pdf', '.txt', '.md', '.rtf'];
    const sheetExts = ['.xls', '.xlsx', '.csv'];
    const slideExts = ['.ppt', '.pptx'];
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
    const videoExts = ['.mp4', '.mov', '.avi', '.webm'];
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a'];
    const codeExts = ['.py', '.js', '.ts', '.go', '.rs', '.java', '.rb', '.sh'];

    if (docExts.includes(ext)) return 'documents';
    if (sheetExts.includes(ext)) return 'spreadsheets';
    if (slideExts.includes(ext)) return 'presentations';
    if (imageExts.includes(ext)) return 'images';
    if (videoExts.includes(ext)) return 'videos';
    if (audioExts.includes(ext)) return 'audio';
    if (codeExts.includes(ext)) return 'code';
    if (fileType?.startsWith('text/')) return 'notes';
    return 'documents';
  }
}
