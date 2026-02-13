/**
 * AGENTVBX Orchestrator — the central brain that connects all components.
 *
 * Responsibilities:
 * - Initialize Redis Streams, message router, recipe engine, and tenant manager
 * - Consume messages from the queue and route them to agents
 * - Execute recipes triggered by messages or schedules
 * - Manage provider health and fallback
 * - Dispatch to provider adapters for actual LLM execution
 * - Deliver artifacts and notifications
 */

import { RedisStreams, type RedisStreamsConfig } from './queue/index.js';
import { MessageRouter } from './routing/index.js';
import { RecipeEngine } from './recipe/index.js';
import { TenantManager } from './tenant/index.js';
import { ConfigLoader } from './config/index.js';
import { ProcessSupervisor } from './process/index.js';
import { ArtifactManager } from './artifacts/index.js';
import { AgentStepHandler } from './handlers/agent-step-handler.js';
import { IntegrationReadHandler, IntegrationWriteHandler } from './handlers/integration-step-handler.js';
import { NotificationStepHandler } from './handlers/notification-step-handler.js';
import { ArtifactDeliveryHandler } from './artifacts/delivery.js';
import { createLogger } from './logger.js';
import type { Message, QueueMessage, Channel } from './types.js';

const logger = createLogger('orchestrator');

// ─── Pluggable Interfaces ──────────────────────────────────────────────────

export interface AdapterManagerLike {
  sendWithFallback(
    request: { prompt: string; system_prompt?: string; temperature?: number; max_tokens?: number; metadata?: Record<string, unknown> },
    providerPriority: string[],
  ): Promise<{ text: string; provider_id: string; model?: string; tokens_used?: number; latency_ms: number; fallbacks_tried: string[] }>;
  get(id: string): unknown;
  listAdapters(): string[];
}

export interface IntegrationManagerLike {
  get(id: string): {
    list(params?: Record<string, unknown>): Promise<unknown[]>;
    read(id: string): Promise<unknown>;
    create(data: Record<string, unknown>): Promise<unknown>;
    update(id: string, data: Record<string, unknown>): Promise<unknown>;
  } | undefined;
}

export type ChannelSender = (channel: Channel, to: string, message: string, metadata?: Record<string, unknown>) => Promise<void>;

export type MessageEventHandler = (event: string, data: unknown) => void;

// ─── Config ─────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  basePath: string;
  redis: RedisStreamsConfig;
  consumerName?: string;
}

export interface MessageResult {
  agent: string;
  provider: string;
  response: string;
  tokens_used?: number;
  latency_ms: number;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export class Orchestrator {
  private queue: RedisStreams;
  private router: MessageRouter;
  private recipeEngine: RecipeEngine;
  private tenantManager: TenantManager;
  private configLoader: ConfigLoader;
  private supervisor: ProcessSupervisor;
  private artifactManager: ArtifactManager;
  private running = false;
  private consumerName: string;

  // Pluggable dependencies — set after construction
  private adapterManager?: AdapterManagerLike;
  private integrationManager?: IntegrationManagerLike;
  private channelSender?: ChannelSender;
  private eventHandler?: MessageEventHandler;

  constructor(private config: OrchestratorConfig) {
    this.queue = new RedisStreams(config.redis);
    this.router = new MessageRouter();
    this.recipeEngine = new RecipeEngine();
    this.tenantManager = new TenantManager(config.basePath);
    this.configLoader = new ConfigLoader(config.basePath);
    this.supervisor = new ProcessSupervisor();
    this.artifactManager = new ArtifactManager(config.basePath);
    this.consumerName = config.consumerName ?? `worker-${process.pid}`;
  }

  /**
   * Wire the adapter manager (provider layer) into the orchestrator.
   */
  setAdapterManager(adapterManager: AdapterManagerLike): void {
    this.adapterManager = adapterManager;
    this.registerStepHandlers();
  }

  /**
   * Wire the integration manager (platform integrations) into the orchestrator.
   */
  setIntegrationManager(integrationManager: IntegrationManagerLike): void {
    this.integrationManager = integrationManager;
    this.registerIntegrationHandlers();
  }

  /**
   * Wire the channel sender (WhatsApp, SMS, etc.) for response delivery.
   */
  setChannelSender(sender: ChannelSender): void {
    this.channelSender = sender;
    this.registerNotificationHandler();
  }

  /**
   * Set event handler for broadcasting events to WebSocket clients.
   */
  setEventHandler(handler: MessageEventHandler): void {
    this.eventHandler = handler;
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
    adapters: string[];
  }> {
    try {
      const queueStats = await this.queue.getQueueStats();
      return {
        status: this.adapterManager ? 'healthy' : 'degraded',
        queue: queueStats,
        processes: this.supervisor.getStatus(),
        agents: this.router.getRegisteredAgents(),
        adapters: this.adapterManager?.listAdapters() ?? [],
      };
    } catch {
      return {
        status: 'unhealthy',
        queue: { voice: 0, chat: 0, background: 0 },
        processes: this.supervisor.getStatus(),
        agents: this.router.getRegisteredAgents(),
        adapters: [],
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
  getArtifactManager(): ArtifactManager { return this.artifactManager; }

  // ─── Private: Step Handler Registration ─────────────────────────────

  private registerStepHandlers(): void {
    if (!this.adapterManager) return;

    const agentHandler = new AgentStepHandler({
      adapterManager: this.adapterManager,
      getAgentBlueprint: (name) => this.router.getAgent(name),
    });

    this.recipeEngine.registerStepHandler('agent', agentHandler);
    this.recipeEngine.registerStepHandler('default', agentHandler);
    logger.info('Agent step handlers registered');
  }

  private registerIntegrationHandlers(): void {
    if (!this.integrationManager) return;

    const readHandler = new IntegrationReadHandler({
      getAdapter: (id) => this.integrationManager?.get(id),
    });

    const writeHandler = new IntegrationWriteHandler({
      getAdapter: (id) => this.integrationManager?.get(id),
    });

    const deliveryHandler = new ArtifactDeliveryHandler({
      artifactManager: this.artifactManager,
      getTenantDestinations: (tenantId) => {
        const config = this.tenantManager.load(tenantId);
        if (!config) return undefined;
        return {
          defaults: config.artifact_destinations.defaults,
          notifications: config.artifact_destinations.notifications,
        };
      },
    });

    this.recipeEngine.registerStepHandler('integration_read', readHandler);
    this.recipeEngine.registerStepHandler('integration_write', writeHandler);
    this.recipeEngine.registerStepHandler('artifact_delivery', deliveryHandler);
    logger.info('Integration + artifact step handlers registered');
  }

  private registerNotificationHandler(): void {
    if (!this.channelSender) return;

    const notificationHandler = new NotificationStepHandler(this.channelSender);
    this.recipeEngine.registerStepHandler('notification', notificationHandler);
    logger.info('Notification step handler registered');
  }

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
   * Routes to agent, dispatches to provider adapter, and sends response back.
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

    this.eventHandler?.('message:routed', {
      id: queueMsg.id,
      decision,
      timestamp: new Date().toISOString(),
    });

    // If no adapter manager, just log (Phase 1 behavior)
    if (!this.adapterManager) {
      logger.info({ id: queueMsg.id, agent: decision.agent }, 'Message processed (no adapter manager)');
      return;
    }

    // If routing failed, nothing to dispatch
    if (decision.agent === 'none') {
      logger.warn({ id: queueMsg.id }, 'No agent matched, message dropped');
      return;
    }

    // Get the agent blueprint for system prompt and config
    const blueprint = this.router.getAgent(decision.agent);
    if (!blueprint) {
      logger.error({ agent: decision.agent }, 'Agent blueprint not found after routing');
      return;
    }

    // Build the provider priority list with fallbacks
    const providerPriority = [decision.provider, ...decision.fallback_providers];

    try {
      const response = await this.adapterManager.sendWithFallback(
        {
          prompt: message.text,
          system_prompt: blueprint.system_prompt,
          temperature: blueprint.temperature,
          metadata: {
            agent: decision.agent,
            channel: message.channel,
            tenant_id: message.tenant_id,
            message_id: message.id,
          },
        },
        providerPriority,
      );

      logger.info({
        id: queueMsg.id,
        agent: decision.agent,
        provider: response.provider_id,
        model: response.model,
        tokens: response.tokens_used,
        latency: response.latency_ms,
        fallbacks: response.fallbacks_tried,
      }, 'Message dispatched and response received');

      this.eventHandler?.('message:completed', {
        id: queueMsg.id,
        agent: decision.agent,
        provider: response.provider_id,
        response_preview: response.text.substring(0, 200),
        tokens_used: response.tokens_used,
        latency_ms: response.latency_ms,
        timestamp: new Date().toISOString(),
      });

      // Send response back through the originating channel
      if (this.channelSender && message.direction === 'inbound') {
        await this.channelSender(message.channel, message.from, response.text, {
          agent: decision.agent,
          provider: response.provider_id,
          message_id: message.id,
        });
      }
    } catch (err) {
      logger.error({
        err,
        id: queueMsg.id,
        agent: decision.agent,
        providers: providerPriority,
      }, 'All providers failed for message');

      this.eventHandler?.('message:failed', {
        id: queueMsg.id,
        agent: decision.agent,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }
}
