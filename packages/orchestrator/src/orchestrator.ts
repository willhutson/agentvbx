/**
 * AGENTVBX Orchestrator — the central brain that connects all components.
 *
 * Responsibilities:
 * - Initialize Redis Streams, message router, recipe engine, and tenant manager
 * - Consume messages from the queue and route them to agents
 * - Execute recipes triggered by messages or schedules
 * - Manage provider health and fallback
 * - Expose health check and status APIs
 */

import { RedisStreams, type RedisStreamsConfig } from './queue/index.js';
import { MessageRouter } from './routing/index.js';
import { RecipeEngine } from './recipe/index.js';
import { TenantManager } from './tenant/index.js';
import { ConfigLoader } from './config/index.js';
import { ProcessSupervisor } from './process/index.js';
import { createLogger } from './logger.js';
import type { Message, QueueMessage, AgentBlueprint, Recipe } from './types.js';

const logger = createLogger('orchestrator');

export interface OrchestratorConfig {
  basePath: string;
  redis: RedisStreamsConfig;
  consumerName?: string;
}

export class Orchestrator {
  private queue: RedisStreams;
  private router: MessageRouter;
  private recipeEngine: RecipeEngine;
  private tenantManager: TenantManager;
  private configLoader: ConfigLoader;
  private supervisor: ProcessSupervisor;
  private running = false;
  private consumerName: string;

  constructor(private config: OrchestratorConfig) {
    this.queue = new RedisStreams(config.redis);
    this.router = new MessageRouter();
    this.recipeEngine = new RecipeEngine();
    this.tenantManager = new TenantManager(config.basePath);
    this.configLoader = new ConfigLoader(config.basePath);
    this.supervisor = new ProcessSupervisor();
    this.consumerName = config.consumerName ?? `worker-${process.pid}`;
  }

  /**
   * Start the orchestrator — connect to Redis, load configs, begin consuming.
   */
  async start(): Promise<void> {
    logger.info('Starting AGENTVBX orchestrator...');

    // Connect to Redis
    await this.queue.connect();

    // Load agent blueprints and register them with the router
    const agents = this.configLoader.loadAgents();
    for (const agent of agents) {
      this.router.registerAgent(agent);
    }
    logger.info({ count: agents.length }, 'Agents loaded');

    // Load recipes
    const recipes = this.configLoader.loadRecipes();
    logger.info({ count: recipes.length }, 'Recipes loaded');

    // Start consuming messages
    this.running = true;
    this.consumeLoop();

    logger.info('AGENTVBX orchestrator started');
  }

  /**
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    logger.info('Stopping AGENTVBX orchestrator...');
    this.running = false;
    await this.supervisor.stopAll();
    await this.queue.disconnect();
    logger.info('AGENTVBX orchestrator stopped');
  }

  /**
   * Publish a message to the queue for processing.
   */
  async handleMessage(message: Message): Promise<string> {
    return this.queue.publish(message);
  }

  /**
   * Execute a recipe by name for a tenant.
   */
  async runRecipe(
    recipeName: string,
    tenantId: string,
    numberId: string,
    input?: Record<string, unknown>,
  ): Promise<string> {
    const recipes = this.configLoader.loadRecipes();
    const recipe = recipes.find((r) => r.name === recipeName);

    if (!recipe) {
      throw new Error(`Recipe not found: ${recipeName}`);
    }

    const execution = await this.recipeEngine.execute(
      recipe,
      tenantId,
      numberId,
      { channel: 'app' },
      input,
    );

    return execution.id;
  }

  /**
   * Create a new tenant.
   */
  createTenant(name: string, tier?: 'free' | 'starter' | 'pro' | 'business' | 'agency') {
    return this.tenantManager.create(name, tier);
  }

  /**
   * Get system health status.
   */
  async getHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    queue: Record<string, number>;
    processes: Record<string, unknown>;
    agents: string[];
  }> {
    try {
      const queueStats = await this.queue.getQueueStats();
      return {
        status: 'healthy',
        queue: queueStats,
        processes: this.supervisor.getStatus(),
        agents: this.router.getRegisteredAgents(),
      };
    } catch {
      return {
        status: 'unhealthy',
        queue: { voice: 0, chat: 0, background: 0 },
        processes: this.supervisor.getStatus(),
        agents: this.router.getRegisteredAgents(),
      };
    }
  }

  /**
   * Get component references for advanced usage.
   */
  getRouter(): MessageRouter { return this.router; }
  getRecipeEngine(): RecipeEngine { return this.recipeEngine; }
  getTenantManager(): TenantManager { return this.tenantManager; }
  getConfigLoader(): ConfigLoader { return this.configLoader; }
  getSupervisor(): ProcessSupervisor { return this.supervisor; }

  /**
   * Main consume loop — reads from priority queues and processes messages.
   */
  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.queue.consume(this.consumerName, async (queueMsg: QueueMessage) => {
          await this.processMessage(queueMsg);
        });
      } catch (err) {
        logger.error({ err }, 'Consumer loop error');
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /**
   * Process a single message from the queue.
   */
  private async processMessage(queueMsg: QueueMessage): Promise<void> {
    const { message } = queueMsg;

    logger.info({
      id: queueMsg.id,
      channel: message.channel,
      tenant: message.tenant_id,
      text: message.text.substring(0, 100),
    }, 'Processing message');

    // Route the message to the best agent
    const decision = this.router.route(message);

    logger.info({
      id: queueMsg.id,
      agent: decision.agent,
      provider: decision.provider,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    }, 'Routing decision');

    // TODO: Dispatch to the actual agent/provider for execution
    // This is where provider adapters, agent-browser sessions, and
    // Ollama integration will be wired in.
    //
    // For now, log the routing decision. The provider adapter layer
    // (packages/providers) will handle actual execution.

    logger.info({ id: queueMsg.id, agent: decision.agent }, 'Message processed');
  }
}
