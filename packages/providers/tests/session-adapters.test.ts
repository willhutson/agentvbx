import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore } from '../src/adapters/session-store.js';
import { ChatGPTSessionAdapter } from '../src/adapters/chatgpt-session.js';
import { ClaudeSessionAdapter } from '../src/adapters/claude-session.js';
import { GeminiSessionAdapter } from '../src/adapters/gemini-session.js';
import { AdapterManager } from '../src/adapters/adapter.js';
import type { SessionCredentials } from '../src/adapters/session-store.js';
import type { ProviderAdapter, AdapterRequest } from '../src/adapters/adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Session Store Tests ────────────────────────────────────────────────────

describe('SessionStore', () => {
  let store: SessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentvbx-test-'));
    store = new SessionStore({
      storage_path: tempDir,
      encryption_key: 'test-key-12345',
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const mockCredentials: SessionCredentials = {
    provider_id: 'chatgpt',
    tenant_id: 'tenant-1',
    auth_token: 'test-session-token-abc123',
    cookies: { session: 'cookie-value' },
    provider_data: { org_id: 'org-123' },
    created_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  };

  it('should store and load credentials', async () => {
    await store.store(mockCredentials);
    const loaded = await store.load('chatgpt', 'tenant-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.provider_id).toBe('chatgpt');
    expect(loaded!.tenant_id).toBe('tenant-1');
    expect(loaded!.auth_token).toBe('test-session-token-abc123');
    expect(loaded!.cookies).toEqual({ session: 'cookie-value' });
    expect(loaded!.provider_data).toEqual({ org_id: 'org-123' });
  });

  it('should return null for non-existent sessions', async () => {
    const loaded = await store.load('chatgpt', 'nonexistent');
    expect(loaded).toBeNull();
  });

  it('should return from cache on second load', async () => {
    await store.store(mockCredentials);

    // First load — from disk
    const first = await store.load('chatgpt', 'tenant-1');
    expect(first).not.toBeNull();

    // Second load — from cache
    const second = await store.load('chatgpt', 'tenant-1');
    expect(second).not.toBeNull();
    expect(second!.auth_token).toBe(first!.auth_token);
  });

  it('should detect expired sessions', async () => {
    const expired: SessionCredentials = {
      ...mockCredentials,
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    };

    await store.store(expired);
    const loaded = await store.load('chatgpt', 'tenant-1');
    expect(loaded).toBeNull();
  });

  it('should not expire sessions without expires_at', async () => {
    const noExpiry: SessionCredentials = {
      ...mockCredentials,
      expires_at: undefined,
    };

    await store.store(noExpiry);
    const loaded = await store.load('chatgpt', 'tenant-1');
    expect(loaded).not.toBeNull();
  });

  it('should delete sessions', async () => {
    await store.store(mockCredentials);
    await store.delete('chatgpt', 'tenant-1');

    const loaded = await store.load('chatgpt', 'tenant-1');
    expect(loaded).toBeNull();
  });

  it('should update last_verified_at on touch', async () => {
    await store.store(mockCredentials);
    const before = (await store.load('chatgpt', 'tenant-1'))!.last_verified_at;

    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 10));
    await store.touch('chatgpt', 'tenant-1');

    const after = (await store.load('chatgpt', 'tenant-1'))!.last_verified_at;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('should list sessions for a tenant', async () => {
    await store.store(mockCredentials);
    await store.store({
      ...mockCredentials,
      provider_id: 'claude',
    });

    const sessions = store.listSessions('tenant-1');
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.provider_id).sort()).toEqual(['chatgpt', 'claude']);
  });

  it('should check hasValidSession correctly', async () => {
    expect(await store.hasValidSession('chatgpt', 'tenant-1')).toBe(false);

    await store.store(mockCredentials);
    expect(await store.hasValidSession('chatgpt', 'tenant-1')).toBe(true);
  });

  it('should emit events', async () => {
    const events: string[] = [];
    store.onEvent((event) => events.push(event));

    await store.store(mockCredentials);
    expect(events).toContain('session:stored');

    await store.load('chatgpt', 'tenant-1');
    // From cache, no load event (already cached from store)

    await store.delete('chatgpt', 'tenant-1');
    expect(events).toContain('session:deleted');
  });

  it('should emit expired event for expired sessions', async () => {
    const events: string[] = [];
    store.onEvent((event) => events.push(event));

    const expired: SessionCredentials = {
      ...mockCredentials,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };

    await store.store(expired);
    // Clear cache to force disk read
    await store.delete('chatgpt', 'tenant-1');
    events.length = 0;

    // Re-store and try to load
    await store.store(expired);
    events.length = 0;

    // Force cache clear by deleting and re-storing
    store = new SessionStore({
      storage_path: tempDir,
      encryption_key: 'test-key-12345',
    });
    store.onEvent((event) => events.push(event));

    await store.load('chatgpt', 'tenant-1');
    expect(events).toContain('session:expired');
  });

  it('should encrypt data at rest', async () => {
    await store.store(mockCredentials);

    // Read the raw file — should not contain the plaintext token
    const { readFile } = await import('node:fs/promises');
    const files = await import('node:fs/promises').then((m) => m.readdir(tempDir));
    const sessionFile = files.find((f: string) => f.endsWith('.session'));
    expect(sessionFile).toBeDefined();

    const rawContent = await readFile(join(tempDir, sessionFile!), 'utf-8');
    expect(rawContent).not.toContain('test-session-token-abc123');
    expect(rawContent).toMatch(/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/); // iv:tag:ciphertext format
  });

  it('should isolate sessions across tenants', async () => {
    await store.store(mockCredentials);
    await store.store({
      ...mockCredentials,
      tenant_id: 'tenant-2',
      auth_token: 'different-token',
    });

    const t1 = await store.load('chatgpt', 'tenant-1');
    const t2 = await store.load('chatgpt', 'tenant-2');

    expect(t1!.auth_token).toBe('test-session-token-abc123');
    expect(t2!.auth_token).toBe('different-token');
  });
});

// ─── Session Adapter Creation Tests ─────────────────────────────────────────

describe('Session Adapters', () => {
  let store: SessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentvbx-test-'));
    store = new SessionStore({
      storage_path: tempDir,
      encryption_key: 'test-key',
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ChatGPTSessionAdapter', () => {
    it('should have correct ID and name', () => {
      const adapter = new ChatGPTSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(adapter.id).toBe('session:chatgpt');
      expect(adapter.name).toBe('ChatGPT (Session)');
    });

    it('should be unavailable without stored session', async () => {
      const adapter = new ChatGPTSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('should implement ProviderAdapter interface', () => {
      const adapter: ProviderAdapter = new ChatGPTSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(typeof adapter.isAvailable).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.initialize).toBe('function');
      expect(typeof adapter.destroy).toBe('function');
    });

    it('should throw on send without session', async () => {
      const adapter = new ChatGPTSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      await expect(adapter.send({ prompt: 'test' })).rejects.toThrow(
        'No ChatGPT session available',
      );
    });

    it('should reset conversation state on destroy', async () => {
      const adapter = new ChatGPTSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      await adapter.destroy();
      // Should not throw
    });
  });

  describe('ClaudeSessionAdapter', () => {
    it('should have correct ID and name', () => {
      const adapter = new ClaudeSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(adapter.id).toBe('session:claude');
      expect(adapter.name).toBe('Claude (Session)');
    });

    it('should be unavailable without stored session', async () => {
      const adapter = new ClaudeSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('should implement ProviderAdapter interface', () => {
      const adapter: ProviderAdapter = new ClaudeSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(typeof adapter.isAvailable).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.initialize).toBe('function');
      expect(typeof adapter.destroy).toBe('function');
    });

    it('should throw on send without session', async () => {
      const adapter = new ClaudeSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      await expect(adapter.send({ prompt: 'test' })).rejects.toThrow(
        'No Claude session available',
      );
    });
  });

  describe('GeminiSessionAdapter', () => {
    it('should have correct ID and name', () => {
      const adapter = new GeminiSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(adapter.id).toBe('session:gemini');
      expect(adapter.name).toBe('Gemini (Session)');
    });

    it('should be unavailable without stored session', async () => {
      const adapter = new GeminiSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('should throw on send without session', async () => {
      const adapter = new GeminiSessionAdapter({
        tenant_id: 'tenant-1',
        session_store: store,
      });
      await expect(adapter.send({ prompt: 'test' })).rejects.toThrow(
        'No Gemini session available',
      );
    });
  });
});

// ─── AdapterManager Gap Detection Tests ─────────────────────────────────────

describe('AdapterManager — Provider Gap Detection', () => {
  let manager: AdapterManager;

  // Mock adapter that's always available
  const createMockAdapter = (id: string, available = true): ProviderAdapter => ({
    id,
    name: `Mock ${id}`,
    isAvailable: async () => available,
    send: async (request: AdapterRequest) => ({
      text: `Response from ${id}`,
      provider_id: id,
      latency_ms: 10,
    }),
    initialize: async () => {},
    destroy: async () => {},
  });

  beforeEach(() => {
    manager = new AdapterManager();
  });

  it('should detect gaps for unregistered session providers', async () => {
    // Only register free providers, not session ones
    manager.register(createMockAdapter('deepseek'));
    manager.register(createMockAdapter('ollama'));

    const gaps = await manager.detectGaps([
      'session:chatgpt',
      'session:claude',
      'deepseek',
    ]);

    expect(gaps).toHaveLength(2);
    expect(gaps[0].provider_id).toBe('session:chatgpt');
    expect(gaps[0].reason).toBe('recipe_requirement');
    expect(gaps[0].signup_url).toBeDefined();
    expect(gaps[1].provider_id).toBe('session:claude');
  });

  it('should detect gaps for unavailable session providers', async () => {
    manager.register(createMockAdapter('session:chatgpt', false));
    manager.register(createMockAdapter('deepseek'));

    const gaps = await manager.detectGaps(['session:chatgpt', 'deepseek']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].provider_id).toBe('session:chatgpt');
  });

  it('should return no gaps when all providers are available', async () => {
    manager.register(createMockAdapter('session:chatgpt'));
    manager.register(createMockAdapter('deepseek'));

    const gaps = await manager.detectGaps(['session:chatgpt', 'deepseek']);
    expect(gaps).toHaveLength(0);
  });

  it('should include signup URLs for known session providers', async () => {
    const gaps = await manager.detectGaps([
      'session:chatgpt',
      'session:claude',
      'session:gemini',
      'session:perplexity',
    ]);

    expect(gaps).toHaveLength(4);
    for (const gap of gaps) {
      expect(gap.signup_url).toBeDefined();
      expect(gap.signup_url).toContain('http');
    }
  });

  it('should record gaps during sendWithFallback', async () => {
    // Session providers unavailable, but deepseek works
    manager.register(createMockAdapter('session:claude', false));
    manager.register(createMockAdapter('deepseek'));

    const result = await manager.sendWithFallback(
      { prompt: 'test' },
      ['session:claude', 'deepseek'],
    );

    expect(result.text).toBe('Response from deepseek');
    expect(result.provider_gaps).toHaveLength(1);
    expect(result.provider_gaps[0].provider_id).toBe('session:claude');
    expect(result.provider_gaps[0].fell_back_to).toBe('deepseek');
  });

  it('should emit gap events via handler', async () => {
    const gaps: string[] = [];
    manager.onProviderGap((gap) => gaps.push(gap.provider_id));

    manager.register(createMockAdapter('session:chatgpt', false));
    manager.register(createMockAdapter('deepseek'));

    await manager.sendWithFallback(
      { prompt: 'test' },
      ['session:chatgpt', 'deepseek'],
    );

    expect(gaps).toContain('session:chatgpt');
  });

  it('should deduplicate recent gaps', async () => {
    manager.register(createMockAdapter('session:claude', false));
    manager.register(createMockAdapter('deepseek'));

    // Trigger the same gap twice
    await manager.sendWithFallback({ prompt: 'test 1' }, ['session:claude', 'deepseek']);
    await manager.sendWithFallback({ prompt: 'test 2' }, ['session:claude', 'deepseek']);

    const recentGaps = manager.getRecentGaps();
    expect(recentGaps).toHaveLength(1);
  });

  it('should clear gaps when requested', async () => {
    manager.register(createMockAdapter('session:claude', false));
    manager.register(createMockAdapter('deepseek'));

    await manager.sendWithFallback({ prompt: 'test' }, ['session:claude', 'deepseek']);
    expect(manager.getRecentGaps()).toHaveLength(1);

    manager.clearGaps();
    expect(manager.getRecentGaps()).toHaveLength(0);
  });

  it('should list session adapters separately', () => {
    manager.register(createMockAdapter('session:chatgpt'));
    manager.register(createMockAdapter('session:claude'));
    manager.register(createMockAdapter('deepseek'));
    manager.register(createMockAdapter('ollama'));

    expect(manager.listSessionAdapters()).toEqual(['session:chatgpt', 'session:claude']);
    expect(manager.listAdapters()).toHaveLength(4);
  });

  it('should handle gap for unregistered session provider in fallback', async () => {
    // session:chatgpt not even registered
    manager.register(createMockAdapter('deepseek'));

    const gaps: string[] = [];
    manager.onProviderGap((gap) => gaps.push(gap.provider_id));

    const result = await manager.sendWithFallback(
      { prompt: 'test' },
      ['session:chatgpt', 'deepseek'],
    );

    expect(result.text).toBe('Response from deepseek');
    expect(gaps).toContain('session:chatgpt');
    expect(result.provider_gaps[0].reason).toBe('preferred_unavailable');
  });

  it('should throw when all providers fail', async () => {
    manager.register(createMockAdapter('session:claude', false));
    manager.register(createMockAdapter('deepseek', false));

    await expect(
      manager.sendWithFallback({ prompt: 'test' }, ['session:claude', 'deepseek']),
    ).rejects.toThrow('All providers failed');
  });
});
