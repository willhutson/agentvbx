/**
 * AGENTVBX Admin API Server
 *
 * REST API + WebSocket for managing tenants, agents, recipes, providers,
 * and real-time system events. This is the main entry point for the
 * desktop app and any external integrations.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { createLogger } from './logger.js';
import type { Orchestrator } from './types.js';

const logger = createLogger('api-server');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiServerConfig {
  port: number;
  host?: string;
  apiKey?: string;
}

export interface WSEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

// ─── API Server ─────────────────────────────────────────────────────────────

export class ApiServer {
  private app: express.Application;
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private wsClients: Set<WebSocket> = new Set();
  private orchestrator?: Orchestrator;

  constructor(private config: ApiServerConfig) {
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json({ limit: '50mb' }));

    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.setupWebSocket();
    this.setupRoutes();
  }

  /**
   * Set the orchestrator instance for API access.
   */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Start listening.
   */
  async start(): Promise<void> {
    const { port, host = '0.0.0.0' } = this.config;
    return new Promise((resolve) => {
      this.httpServer.listen(port, host, () => {
        logger.info({ port, host }, 'API server started');
        resolve();
      });
    });
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    for (const client of this.wsClients) {
      client.close();
    }
    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info('API server stopped');
        resolve();
      });
    });
  }

  /**
   * Broadcast an event to all connected WebSocket clients.
   */
  broadcast(event: WSEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Get the Express app for testing or middleware injection.
   */
  getApp(): express.Application {
    return this.app;
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.wsClients.add(ws);
      logger.info({ clients: this.wsClients.size }, 'WebSocket client connected');

      ws.on('close', () => {
        this.wsClients.delete(ws);
        logger.info({ clients: this.wsClients.size }, 'WebSocket client disconnected');
      });

      // Send initial state
      if (this.orchestrator) {
        this.orchestrator.getHealth().then((health) => {
          ws.send(JSON.stringify({ type: 'health', data: health, timestamp: new Date().toISOString() }));
        });
      }
    });
  }

  // ─── Auth Middleware ────────────────────────────────────────────────────

  private authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.config.apiKey) {
      next();
      return;
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== this.config.apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  // ─── Routes ─────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const auth = this.authMiddleware.bind(this);

    // ── Health ──
    this.app.get('/api/health', async (_req, res) => {
      if (!this.orchestrator) {
        res.json({ status: 'no_orchestrator', queue: {}, processes: {}, agents: [] });
        return;
      }
      const health = await this.orchestrator.getHealth();
      res.json(health);
    });

    // ── Tenants ──
    this.app.post('/api/tenants', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const { name, tier } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const tenant = this.orchestrator.createTenant(name, tier);
      this.broadcast({ type: 'tenant:created', data: tenant, timestamp: new Date().toISOString() });
      res.status(201).json(tenant);
    });

    this.app.get('/api/tenants', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const ids = this.orchestrator.getTenantManager().list();
      const tenants = ids.map((id) => this.orchestrator!.getTenantManager().load(id)).filter(Boolean);
      res.json(tenants);
    });

    this.app.get('/api/tenants/:id', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const tenant = this.orchestrator.getTenantManager().load(String(req.params.id));
      if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }
      res.json(tenant);
    });

    this.app.patch('/api/tenants/:id', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const updated = this.orchestrator.getTenantManager().update(String(req.params.id), req.body);
      if (!updated) { res.status(404).json({ error: 'Tenant not found' }); return; }
      res.json(updated);
    });

    // ── Agents ──
    this.app.get('/api/agents', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const names = this.orchestrator.getRouter().getRegisteredAgents();
      const agents = names.map((n) => this.orchestrator!.getRouter().getAgent(n)).filter(Boolean);
      res.json(agents);
    });

    this.app.get('/api/agents/:name', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const agent = this.orchestrator.getRouter().getAgent(String(req.params.name));
      if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
      res.json(agent);
    });

    // ── Messages ──
    this.app.post('/api/messages', auth, async (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const message = {
        id: uuid(),
        timestamp: new Date().toISOString(),
        direction: 'inbound' as const,
        ...req.body,
      };
      const queueId = await this.orchestrator.handleMessage(message);
      this.broadcast({ type: 'message:queued', data: { queueId, message }, timestamp: new Date().toISOString() });
      res.status(202).json({ queue_id: queueId, message_id: message.id });
    });

    // ── Recipes ──
    this.app.get('/api/recipes', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const recipes = this.orchestrator.getConfigLoader().loadRecipes();
      res.json(recipes);
    });

    this.app.post('/api/recipes/:name/execute', auth, async (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const { tenant_id, number_id, input } = req.body;
      if (!tenant_id) { res.status(400).json({ error: 'tenant_id is required' }); return; }
      try {
        const executionId = await this.orchestrator.runRecipe(
          String(req.params.name), tenant_id, number_id ?? 'default', input,
        );
        this.broadcast({
          type: 'recipe:started',
          data: { execution_id: executionId, recipe: String(req.params.name), tenant_id },
          timestamp: new Date().toISOString(),
        });
        res.status(202).json({ execution_id: executionId });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : 'Recipe not found' });
      }
    });

    this.app.get('/api/recipes/executions/:id', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const execution = this.orchestrator.getRecipeEngine().getExecution(String(_req.params.id));
      if (!execution) { res.status(404).json({ error: 'Execution not found' }); return; }
      res.json(execution);
    });

    this.app.delete('/api/recipes/executions/:id', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const cancelled = this.orchestrator.getRecipeEngine().cancel(String(_req.params.id));
      if (!cancelled) { res.status(404).json({ error: 'Execution not found or not running' }); return; }
      res.json({ cancelled: true });
    });

    // ── Providers ──
    this.app.get('/api/providers', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const providers = this.orchestrator.getConfigLoader().loadProviders();
      res.json(providers);
    });

    // ── Processes ──
    this.app.get('/api/processes', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      res.json(this.orchestrator.getSupervisor().getStatus());
    });

    // ── Browser Sessions ──
    this.app.get('/api/browser/sessions', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const sessions = this.orchestrator.getBrowserSessions();
      res.json(sessions);
    });

    this.app.get('/api/browser/sessions/:tenantId', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const sessions = this.orchestrator.getBrowserSessionsByTenant(String(req.params.tenantId));
      res.json(sessions);
    });

    this.app.post('/api/browser/sessions', auth, async (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const { tenant_id, provider_id, provider_url, headless } = req.body;
      if (!tenant_id || !provider_id) {
        res.status(400).json({ error: 'tenant_id and provider_id are required' });
        return;
      }
      try {
        const session = await this.orchestrator.createBrowserSession({
          tenant_id, provider_id, provider_url, headless,
        });
        this.broadcast({ type: 'browser:session_created', data: session, timestamp: new Date().toISOString() });
        res.status(201).json(session);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Session creation failed' });
      }
    });

    this.app.delete('/api/browser/sessions/:tenantId/:providerId', auth, async (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      await this.orchestrator.closeBrowserSession(String(req.params.tenantId), String(req.params.providerId));
      this.broadcast({
        type: 'browser:session_closed',
        data: { tenant_id: String(req.params.tenantId), provider_id: String(req.params.providerId) },
        timestamp: new Date().toISOString(),
      });
      res.json({ closed: true });
    });

    this.app.get('/api/browser/health', auth, async (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const health = await this.orchestrator.getBrowserHealth();
      res.json(health);
    });

    this.app.post('/api/browser/reauth', auth, async (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const { tenant_id, provider_id, method } = req.body;
      if (!tenant_id || !provider_id) {
        res.status(400).json({ error: 'tenant_id and provider_id are required' });
        return;
      }
      try {
        const request = await this.orchestrator.requestBrowserReauth(tenant_id, provider_id, method);
        this.broadcast({ type: 'browser:reauth_requested', data: request, timestamp: new Date().toISOString() });
        res.status(202).json(request);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Re-auth failed' });
      }
    });

    this.app.get('/api/browser/scripts', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const scripts = this.orchestrator.getAvailableBrowserScripts();
      res.json(scripts);
    });

    // ── Marketplace ──
    this.app.get('/api/marketplace/recipes', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const category = _req.query.category as string | undefined;
      const sort = _req.query.sort as string | undefined;
      const search = _req.query.search as string | undefined;
      const recipes = this.orchestrator.getMarketplaceRecipes(category, sort, search);
      res.json(recipes);
    });

    this.app.get('/api/marketplace/recipes/:id', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const recipe = this.orchestrator.getMarketplaceRecipe(String(req.params.id));
      if (!recipe) { res.status(404).json({ error: 'Recipe not found' }); return; }
      res.json(recipe);
    });

    this.app.post('/api/marketplace/recipes', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const published = this.orchestrator.publishRecipe(req.body);
      this.broadcast({ type: 'marketplace:recipe_published', data: published, timestamp: new Date().toISOString() });
      res.status(201).json(published);
    });

    this.app.post('/api/marketplace/recipes/:id/install', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const { tenant_id } = req.body;
      if (!tenant_id) { res.status(400).json({ error: 'tenant_id is required' }); return; }
      const installed = this.orchestrator.installRecipe(String(req.params.id), tenant_id);
      if (!installed) { res.status(404).json({ error: 'Recipe not found' }); return; }
      res.json({ installed: true, recipe_id: String(req.params.id) });
    });

    // ── Analytics ──
    this.app.get('/api/analytics/overview', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      res.json(this.orchestrator.getAnalyticsOverview());
    });

    this.app.get('/api/analytics/usage/:tenantId', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      res.json(this.orchestrator.getTenantUsage(String(req.params.tenantId), from, to));
    });

    this.app.get('/api/analytics/costs', auth, (_req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      res.json(this.orchestrator.getCostBreakdown());
    });

    // ── White-label ──
    this.app.get('/api/whitelabel/:tenantId', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const config = this.orchestrator.getWhitelabelConfig(String(req.params.tenantId));
      if (!config) { res.status(404).json({ error: 'No whitelabel config' }); return; }
      res.json(config);
    });

    this.app.put('/api/whitelabel/:tenantId', auth, (req, res) => {
      if (!this.orchestrator) { res.status(503).json({ error: 'Orchestrator not ready' }); return; }
      const config = this.orchestrator.setWhitelabelConfig(String(req.params.tenantId), req.body);
      res.json(config);
    });

    // ── System info ──
    this.app.get('/api/system', auth, async (_req, res) => {
      const health = this.orchestrator ? await this.orchestrator.getHealth() : null;
      res.json({
        version: '0.5.0',
        phase: 'Phase 5-7',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        health,
        ws_clients: this.wsClients.size,
      });
    });
  }
}
