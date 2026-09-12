/**
 * @flowcache/shared — logger.ts
 *
 * Thin wrapper around pino that gives every service a consistently
 * shaped, structured logger with a bound `service` and `nodeId` field.
 * Using a factory (rather than a singleton) lets each cache node and
 * the gateway tag their own logs without cross-contamination.
 */

import pino, { type Logger as PinoLogger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  service: string;
  nodeId?: string;
  level?: LogLevel;
  pretty?: boolean;
}

export type Logger = PinoLogger;

export function createLogger(options: LoggerOptions): Logger {
  const { service, nodeId, level, pretty } = options;

  const base = pino({
    level: level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info',
    base: { service, nodeId: nodeId ?? null, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      pretty ?? process.env.LOG_PRETTY === 'true'
        ? {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          }
        : undefined,
  });

  return base;
}

/**
 * Convenience for one-off scripts / benchmarks that don't need a full
 * service context.
 */
export const rootLogger: Logger = createLogger({ service: 'flowcache', level: 'info' });