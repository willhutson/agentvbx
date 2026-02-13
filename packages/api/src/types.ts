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
}
