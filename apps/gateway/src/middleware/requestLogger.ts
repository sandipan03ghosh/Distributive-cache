/**
 * @flowcache/gateway — middleware/requestLogger.ts
 */

import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@flowcache/shared';

export function requestLoggerMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.debug(
        { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt },
        'Request handled',
      );
    });
    next();
  };
}