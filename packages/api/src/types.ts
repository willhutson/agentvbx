/**
 * Re-exports of orchestrator types used by the API layer.
 * Avoids direct dependency on @agentvbx/orchestrator at the type level.
 */

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: unknown): Promise<string>;
  runRecipe(name: string, tenantId: string, numberId: string, input?: Record<string, unknown>): Promise<string>;
  createTenant(name: string, tier?: string): unknown;
  getHealth(): Promise<{
    status: string;
    queue: Record<string, number>;
    processes: Record<string, unknown>;
    agents: string[];
    adapters?: string[];
  }>;
  getRouter(): {
    getRegisteredAgents(): string[];
    getAgent(name: string): unknown;
  };
  getRecipeEngine(): {
    getExecution(id: string): unknown;
    cancel(id: string): boolean;
    getActiveExecutions(tenantId: string): unknown[];
  };
  getTenantManager(): {
    list(): string[];
    load(id: string): unknown;
    update(id: string, updates: unknown): unknown;
    exists(id: string): boolean;
  };
  getConfigLoader(): {
    loadRecipes(): unknown[];
    loadProviders(): unknown[];
    loadAgents(): unknown[];
  };
  getSupervisor(): {
    getStatus(): Record<string, unknown>;
  };

  // Phase 5: Browser BYOA
  getBrowserSessions(): unknown[];
  getBrowserSessionsByTenant(tenantId: string): unknown[];
  createBrowserSession(config: {
    tenant_id: string;
    provider_id: string;
    provider_url?: string;
    headless?: boolean;
  }): Promise<unknown>;
  closeBrowserSession(tenantId: string, providerId: string): Promise<void>;
  getBrowserHealth(): Promise<Record<string, unknown>>;
  requestBrowserReauth(tenantId: string, providerId: string, method?: string): Promise<unknown>;
  getAvailableBrowserScripts(): unknown[];

  // Phase 6: Marketplace
  getMarketplaceRecipes(category?: string, sort?: string, search?: string): unknown[];
  getMarketplaceRecipe(id: string): unknown;
  publishRecipe(recipe: unknown): unknown;
  installRecipe(recipeId: string, tenantId: string): boolean;

  // Phase 7: Analytics
  getAnalyticsOverview(): unknown;
  getTenantUsage(tenantId: string, from?: string, to?: string): unknown;
  getCostBreakdown(): unknown;

  // Phase 7: White-label
  getWhitelabelConfig(tenantId: string): unknown;
  setWhitelabelConfig(tenantId: string, config: unknown): unknown;
}
