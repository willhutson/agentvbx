import pino from 'pino';

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
  base: { service: 'agentvbx-whatsapp' },
});

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ component: name });
}
