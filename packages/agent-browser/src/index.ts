/**
 * @agentvbx/agent-browser — Browser session management for AI providers
 */

export { SessionManager } from './session-manager.js';
export type {
  SessionConfig,
  SessionStatus,
  BrowserSession,
  SessionMessage,
} from './session-manager.js';

export { TaskRunner } from './task-runner.js';
export type {
  TaskConfig,
  TaskStatus,
  TaskResult,
  TaskArtifact,
} from './task-runner.js';

export { HealthMonitor } from './health-monitor.js';
export type {
  HealthCheckResult,
  MonitorConfig,
  HealthEvent,
  HealthEventHandler,
} from './health-monitor.js';

export { ReauthFlowManager } from './reauth-flow.js';
export type {
  ReauthMethod,
  ReauthStatus,
  ReauthRequest,
  ReauthConfig,
  ReauthEventHandler,
} from './reauth-flow.js';

export {
  PROVIDER_SCRIPTS,
  getProviderScript,
  getAvailableProviderScripts,
  findElement,
} from './provider-scripts.js';
export type { ProviderScript } from './provider-scripts.js';
