import pino from 'pino';

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info') {
  return pino({ level, base: { service: 'peer' } });
}

export type Logger = ReturnType<typeof createLogger>;
