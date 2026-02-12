import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ConfigLoader } from '../src/config/loader.js';

const TEST_DIR = join(process.cwd(), '__test_configs__');

function setupTestDir() {
  mkdirSync(join(TEST_DIR, 'agents'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'recipes'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'providers'), { recursive: true });

  writeFileSync(
    join(TEST_DIR, 'agents', 'researcher.yaml'),
    YAML.stringify({
      name: 'Researcher',
      description: 'Test researcher',
      provider_priority: ['claude-max'],
      tools: ['exa'],
      channels: ['whatsapp'],
      routing_keywords: ['research'],
      temperature: 0.7,
      system_prompt: 'You are a researcher.',
    }),
  );

  writeFileSync(
    join(TEST_DIR, 'agents', 'writer.yaml'),
    YAML.stringify({
      name: 'Writer',
      description: 'Test writer',
      provider_priority: ['chatgpt-pro'],
      tools: [],
      channels: ['app'],
      routing_keywords: ['write'],
      temperature: 0.8,
      system_prompt: 'You are a writer.',
    }),
  );

  writeFileSync(
    join(TEST_DIR, 'recipes', 'test-recipe.yaml'),
    YAML.stringify({
      name: 'Test Recipe',
      description: 'A test',
      steps: [
        { name: 'step1', agent: 'researcher', input: 'query', output: 'result' },
      ],
    }),
  );
}

function cleanupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('ConfigLoader', () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    cleanupTestDir();
    setupTestDir();
    loader = new ConfigLoader(TEST_DIR);
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it('should load agent blueprints from directory', () => {
    const agents = loader.loadAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name)).toContain('Researcher');
    expect(agents.map((a) => a.name)).toContain('Writer');
  });

  it('should load recipes from directory', () => {
    const recipes = loader.loadRecipes();
    expect(recipes).toHaveLength(1);
    expect(recipes[0].name).toBe('Test Recipe');
    expect(recipes[0].steps).toHaveLength(1);
  });

  it('should handle missing directories gracefully', () => {
    const agents = loader.loadAgents(join(TEST_DIR, 'nonexistent'));
    expect(agents).toHaveLength(0);
  });

  it('should load a single YAML file', () => {
    const agent = loader.loadYamlFile(join(TEST_DIR, 'agents', 'researcher.yaml'));
    expect(agent).toBeDefined();
    expect((agent as Record<string, unknown>).name).toBe('Researcher');
  });

  it('should return null for missing files', () => {
    const result = loader.loadYamlFile(join(TEST_DIR, 'nonexistent.yaml'));
    expect(result).toBeNull();
  });

  it('should ensure tenant directory structure', () => {
    const tenantDir = loader.ensureTenantDir('test-tenant');
    expect(existsSync(tenantDir)).toBe(true);
    expect(existsSync(join(tenantDir, 'agents'))).toBe(true);
    expect(existsSync(join(tenantDir, 'recipes'))).toBe(true);
    expect(existsSync(join(tenantDir, 'artifacts'))).toBe(true);
    expect(existsSync(join(tenantDir, 'artifacts', 'files'))).toBe(true);
    expect(existsSync(join(tenantDir, 'sessions'))).toBe(true);
    expect(existsSync(join(tenantDir, 'integrations'))).toBe(true);
  });

  it('should skip non-YAML files', () => {
    writeFileSync(join(TEST_DIR, 'agents', 'readme.md'), '# Not a config');
    writeFileSync(join(TEST_DIR, 'agents', 'data.json'), '{}');
    const agents = loader.loadAgents();
    expect(agents).toHaveLength(2); // Only the 2 YAML files
  });
});
