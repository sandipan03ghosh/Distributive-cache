/**
 * @flowcache/cache-node — middleware/requestTiming.ts
 */

import type { NextFunction, Request, Response } from 'express';
import { Timer } from '@flowcache/metrics';
import type { CacheNodeContext } from '../CacheNodeContext.js';

export function requestTimingMiddleware(ctx: CacheNodeContext) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const timer = Timer.start();
    res.on('finish', () => {
      ctx.metricsCollector.recordRequest(timer.elapsedMs());
    });
    next();
  };
}