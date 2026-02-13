import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalFileStore, ObsidianStore, FileStoreManager } from '../src/files/store.js';
import { VersionManager } from '../src/files/versioning.js';
import type { FileStoreConfig } from '../src/files/store.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Local File Store Tests ─────────────────────────────────────────────────

describe('LocalFileStore', () => {
  let tempDir: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentvbx-fs-'));

    // Create test file structure
    await writeFile(join(tempDir, 'readme.md'), '# Test Project\n\nHello world');
    await writeFile(join(tempDir, 'data.json'), '{"key": "value"}');
    await writeFile(join(tempDir, 'report.pdf'), Buffer.from('fake pdf content'));
    await mkdir(join(tempDir, 'docs'));
    await writeFile(join(tempDir, 'docs', 'guide.txt'), 'User guide content');
    await writeFile(join(tempDir, '.hidden'), 'hidden file');

    const config: FileStoreConfig = {
      id: 'test-local',
      name: 'Test Store',
      type: 'local',
      root: tempDir,
    };
    store = new LocalFileStore(config);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should list files in root directory', async () => {
    const entries = await store.list();
    const names = entries.map((e) => e.name);

    expect(names).toContain('readme.md');
    expect(names).toContain('data.json');
    expect(names).toContain('report.pdf');
    expect(names).toContain('docs');
    expect(names).not.toContain('.hidden'); // Hidden files excluded
  });

  it('should list files in subdirectory', async () => {
    const entries = await store.list('docs');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('guide.txt');
  });

  it('should identify directories', async () => {
    const entries = await store.list();
    const docsEntry = entries.find((e) => e.name === 'docs');
    expect(docsEntry?.is_directory).toBe(true);
  });

  it('should read text file content', async () => {
    const content = await store.read('readme.md');
    expect(content).not.toBeNull();
    expect(content!.text).toBe('# Test Project\n\nHello world');
    expect(content!.entry.mime_type).toBe('text/markdown');
  });

  it('should read binary file content', async () => {
    const content = await store.read('report.pdf');
    expect(content).not.toBeNull();
    expect(content!.data).toBeInstanceOf(Buffer);
    expect(content!.text).toBeUndefined(); // Binary, no text
    expect(content!.entry.mime_type).toBe('application/pdf');
  });

  it('should return null for non-existent files', async () => {
    const content = await store.read('nonexistent.txt');
    expect(content).toBeNull();
  });

  it('should write new files', async () => {
    const entry = await store.write('new-file.txt', 'new content');
    expect(entry.name).toBe('new-file.txt');
    expect(entry.size_bytes).toBeGreaterThan(0);

    const content = await store.read('new-file.txt');
    expect(content!.text).toBe('new content');
  });

  it('should create subdirectories when writing', async () => {
    const entry = await store.write('deep/nested/file.txt', 'nested');
    expect(entry.name).toBe('file.txt');

    const content = await store.read('deep/nested/file.txt');
    expect(content!.text).toBe('nested');
  });

  it('should reject writes to read-only stores', async () => {
    const readOnlyStore = new LocalFileStore({
      id: 'ro',
      name: 'Read Only',
      type: 'local',
      root: tempDir,
      read_only: true,
    });

    await expect(readOnlyStore.write('test.txt', 'content')).rejects.toThrow('read-only');
  });

  it('should search by filename', async () => {
    const results = await store.search('readme');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('readme.md');
  });

  it('should report connected status', async () => {
    expect(await store.isConnected()).toBe(true);

    const missingStore = new LocalFileStore({
      id: 'missing',
      name: 'Missing',
      type: 'local',
      root: '/nonexistent/path',
    });
    expect(await missingStore.isConnected()).toBe(false);
  });

  it('should compute stats', async () => {
    const stats = await store.stats();
    expect(stats.files).toBeGreaterThanOrEqual(4); // readme, data, report, guide
    expect(stats.total_bytes).toBeGreaterThan(0);
  });

  it('should exclude files matching patterns', async () => {
    const filteredStore = new LocalFileStore({
      id: 'filtered',
      name: 'Filtered',
      type: 'local',
      root: tempDir,
      exclude: ['*.pdf'],
    });

    const entries = await filteredStore.list();
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('report.pdf');
    expect(names).toContain('readme.md');
  });

  it('should set store_id on all entries', async () => {
    const entries = await store.list();
    for (const entry of entries) {
      expect(entry.store_id).toBe('test-local');
    }
  });
});

// ─── Obsidian Store Tests ───────────────────────────────────────────────────

describe('ObsidianStore', () => {
  let tempDir: string;
  let store: ObsidianStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentvbx-obs-'));

    // Create a mock Obsidian vault
    await mkdir(join(tempDir, '.obsidian'), { recursive: true });
    await writeFile(
      join(tempDir, 'Daily Note.md'),
      `---
title: Daily Note
date: 2024-01-15
tags: daily, journal
---

# Daily Note

Today I worked on the [[Project Alpha]] integration.
Also discussed #meeting notes with the team.
See [[Architecture Doc]] for details.`,
    );
    await writeFile(join(tempDir, 'Project Alpha.md'), '# Project Alpha\n\nDescription here.');
    await mkdir(join(tempDir, 'archive'));
    await writeFile(join(tempDir, 'archive', 'old-note.md'), '# Old Note');

    store = new ObsidianStore({
      id: 'test-vault',
      name: 'Test Vault',
      type: 'obsidian',
      root: tempDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should detect as connected (has .obsidian dir)', async () => {
    expect(await store.isConnected()).toBe(true);
  });

  it('should not detect non-vault as connected', async () => {
    const nonVault = new ObsidianStore({
      id: 'not-vault',
      name: 'Not Vault',
      type: 'obsidian',
      root: join(tmpdir(), 'nonexistent-vault'),
    });
    expect(await nonVault.isConnected()).toBe(false);
  });

  it('should list notes excluding .obsidian', async () => {
    const entries = await store.list();
    const names = entries.map((e) => e.name);
    expect(names).toContain('Daily Note.md');
    expect(names).toContain('Project Alpha.md');
    expect(names).not.toContain('.obsidian');
  });

  it('should parse frontmatter from notes', async () => {
    const content = await store.read('Daily Note.md');
    expect(content).not.toBeNull();
    expect(content!.entry.metadata?.frontmatter).toBeDefined();

    const fm = content!.entry.metadata!.frontmatter as Record<string, unknown>;
    expect(fm.title).toBe('Daily Note');
    expect(fm.date).toBe('2024-01-15');
  });

  it('should extract wiki-links', async () => {
    const content = await store.read('Daily Note.md');
    const links = content!.entry.metadata!.links as string[];
    expect(links).toContain('Project Alpha');
    expect(links).toContain('Architecture Doc');
  });

  it('should extract tags', async () => {
    const content = await store.read('Daily Note.md');
    const tags = content!.entry.metadata!.tags as string[];
    expect(tags).toContain('meeting');
  });

  it('should list notes with metadata', async () => {
    const notes = await store.listNotes();
    expect(notes.length).toBeGreaterThanOrEqual(2);

    const dailyNote = notes.find((n) => n.name === 'Daily Note.md');
    expect(dailyNote?.links).toContain('Project Alpha');
  });

  it('should resolve wiki-links to file paths', async () => {
    const resolved = await store.resolveLink('Project Alpha');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('Project Alpha.md');
  });

  it('should search by content', async () => {
    const results = await store.search('integration');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── File Store Manager Tests ───────────────────────────────────────────────

describe('FileStoreManager', () => {
  let tempDir: string;
  let manager: FileStoreManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentvbx-mgr-'));
    await writeFile(join(tempDir, 'test.md'), '# Test');

    manager = new FileStoreManager();
    manager.register(new LocalFileStore({
      id: 'desktop',
      name: 'Desktop',
      type: 'local',
      root: tempDir,
    }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should register and retrieve stores', () => {
    expect(manager.get('desktop')).toBeDefined();
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  it('should list stores with connection status', async () => {
    const stores = await manager.listStores();
    expect(stores).toHaveLength(1);
    expect(stores[0].id).toBe('desktop');
    expect(stores[0].connected).toBe(true);
  });

  it('should search across all stores', async () => {
    const results = await manager.searchAll('test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].store_id).toBe('desktop');
  });

  it('should read from a specific store', async () => {
    const content = await manager.readFrom('desktop', 'test.md');
    expect(content).not.toBeNull();
    expect(content!.text).toBe('# Test');
  });

  it('should return null for unknown store', async () => {
    const content = await manager.readFrom('unknown', 'file.txt');
    expect(content).toBeNull();
  });
});

// ─── Version Manager Tests ──────────────────────────────────────────────────

describe('VersionManager', () => {
  let vm: VersionManager;

  beforeEach(() => {
    vm = new VersionManager();
  });

  it('should create versioned artifact at v1 draft', () => {
    const artifact = vm.createVersionedArtifact(
      'art-1', 'tenant-1', 'report.pdf', '/tmp/report.pdf', 'writer-agent', 'abc123',
    );

    expect(artifact.current_version).toBe(1);
    expect(artifact.status).toBe('draft');
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0].content_hash).toBe('abc123');
    expect(artifact.versions[0].created_by).toBe('writer-agent');
  });

  it('should transition through lifecycle states', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'report.pdf', '/tmp/v1.pdf', 'agent', 'hash1');

    // draft → pending_review
    vm.markSentForReview('art-1');
    expect(vm.get('art-1')!.status).toBe('pending_review');

    // Add feedback → collecting_feedback
    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'the intro is too long',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
    });
    expect(vm.get('art-1')!.status).toBe('collecting_feedback');

    // Close feedback → revision
    const unified = vm.closeFeedback('art-1', 'timeout');
    expect(vm.get('art-1')!.status).toBe('revision');
    expect(unified.fragment_count).toBe(1);

    // Add new version → draft
    vm.addVersion('art-1', '/tmp/v2.pdf', 'hash2', 'agent', unified.revision_prompt);
    expect(vm.get('art-1')!.current_version).toBe(2);
    expect(vm.get('art-1')!.status).toBe('draft');

    // Approve → approved
    vm.approve('art-1');
    expect(vm.get('art-1')!.status).toBe('approved');

    // Deliver → delivered
    vm.markDelivered('art-1', 'https://drive.google.com/file/abc');
    expect(vm.get('art-1')!.status).toBe('delivered');
  });

  it('should accumulate fragmented feedback', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'report.pdf', '/tmp/v1.pdf', 'agent', 'hash1');
    vm.markSentForReview('art-1');

    // Fragment 1: text message
    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'the intro is too long',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
    });

    // Fragment 2: voice note (simulated transcript)
    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'voice_note',
      content: 'also the revenue chart in section 3 needs updating with Q4 numbers',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
      media_url: 'https://whatsapp.com/voice/123',
    });

    // Fragment 3: another text
    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'and add a section on partnerships',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
    });

    const artifact = vm.get('art-1')!;
    expect(artifact.pending_feedback).toHaveLength(3);
    expect(artifact.pending_feedback[0].sequence).toBe(1);
    expect(artifact.pending_feedback[1].sequence).toBe(2);
    expect(artifact.pending_feedback[2].sequence).toBe(3);

    // Unify fragments
    const unified = vm.closeFeedback('art-1', 'explicit');
    expect(unified.fragment_count).toBe(3);
    expect(unified.revision_prompt).toContain('intro is too long');
    expect(unified.revision_prompt).toContain('Voice note');
    expect(unified.revision_prompt).toContain('partnerships');
    expect(unified.close_reason).toBe('explicit');

    // Pending feedback cleared
    expect(vm.get('art-1')!.pending_feedback).toHaveLength(0);
    // History preserved
    expect(vm.get('art-1')!.feedback_history).toHaveLength(1);
  });

  it('should group feedback by section reference', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'report.pdf', '/tmp/v1.pdf', 'agent', 'hash1');
    vm.markSentForReview('art-1');

    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'too wordy',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
      section_ref: 'Introduction',
    });

    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'needs more data',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
      section_ref: 'Results',
    });

    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'good overall structure though',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
    });

    const unified = vm.closeFeedback('art-1', 'timeout');
    expect(unified.revision_prompt).toContain('Introduction');
    expect(unified.revision_prompt).toContain('Results');
    expect(unified.revision_prompt).toContain('General feedback');
  });

  it('should track version history across revisions', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'doc.md', '/tmp/v1.md', 'writer', 'hash1');
    vm.addVersion('art-1', '/tmp/v2.md', 'hash2', 'writer', 'fix intro');
    vm.addVersion('art-1', '/tmp/v3.md', 'hash3', 'writer', 'add charts');

    const artifact = vm.get('art-1')!;
    expect(artifact.current_version).toBe(3);
    expect(artifact.versions).toHaveLength(3);
    expect(artifact.versions[1].revision_prompt).toBe('fix intro');
    expect(artifact.versions[2].revision_prompt).toBe('add charts');
  });

  it('should get version path by number', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'doc.md', '/tmp/v1.md', 'agent', 'h1');
    vm.addVersion('art-1', '/tmp/v2.md', 'h2', 'agent');

    expect(vm.getVersionPath('art-1', 1)).toBe('/tmp/v1.md');
    expect(vm.getVersionPath('art-1', 2)).toBe('/tmp/v2.md');
    expect(vm.getVersionPath('art-1', 3)).toBeUndefined();
  });

  it('should list artifacts by tenant and status', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'a.pdf', '/a', 'agent', 'h1');
    vm.createVersionedArtifact('art-2', 'tenant-1', 'b.pdf', '/b', 'agent', 'h2');
    vm.createVersionedArtifact('art-3', 'tenant-2', 'c.pdf', '/c', 'agent', 'h3');

    vm.approve('art-2');

    expect(vm.listForTenant('tenant-1')).toHaveLength(2);
    expect(vm.listForTenant('tenant-1', 'draft')).toHaveLength(1);
    expect(vm.listForTenant('tenant-1', 'approved')).toHaveLength(1);
    expect(vm.listForTenant('tenant-2')).toHaveLength(1);
  });

  it('should detect pending feedback and timing', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'doc.md', '/tmp/v1.md', 'agent', 'h1');

    expect(vm.hasPendingFeedback('art-1')).toBe(false);
    expect(vm.timeSinceLastFeedback('art-1')).toBeNull();

    vm.markSentForReview('art-1');
    vm.addFeedback('art-1', {
      artifact_id: 'art-1',
      type: 'text',
      content: 'looks good mostly',
      channel: 'whatsapp',
      received_at: new Date().toISOString(),
    });

    expect(vm.hasPendingFeedback('art-1')).toBe(true);
    expect(vm.timeSinceLastFeedback('art-1')).not.toBeNull();
    expect(vm.timeSinceLastFeedback('art-1')!).toBeLessThan(1000);
  });

  it('should throw on feedback close with no fragments', () => {
    vm.createVersionedArtifact('art-1', 'tenant-1', 'doc.md', '/tmp/v1.md', 'agent', 'h1');
    expect(() => vm.closeFeedback('art-1', 'timeout')).toThrow('No pending feedback');
  });

  it('should throw on operations with unknown artifact', () => {
    expect(() => vm.markSentForReview('nonexistent')).toThrow('Artifact not found');
    expect(() => vm.approve('nonexistent')).toThrow('Artifact not found');
  });
});
