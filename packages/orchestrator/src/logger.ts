/**
 * Structured logger using pino.
 * All components use createLogger(name) for consistent, filterable output.
 */

import pino from 'pino';

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'agentvbx' },
});

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ component: name });
}

export { rootLogger as logger };
