import pino from 'pino';

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'agentvbx-providers' },
});

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ component: name });
}
