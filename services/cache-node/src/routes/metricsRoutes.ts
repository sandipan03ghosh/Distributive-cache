/**
 * @flowcache/cache-node — routes/metricsRoutes.ts
 */

import { Router, type Request, type Response } from 'express';
import type { CacheNodeContext } from '../CacheNodeContext.js';

export function createMetricsRoutes(ctx: CacheNodeContext): Router {
  const router = Router();

  router.get('/metrics', (_req: Request, res: Response) => {
    res.status(200).json(ctx.metricsCollector.getSnapshot());
  });

  /** Eviction-specific detail beyond what fits in the general metrics
   *  snapshot: current workload signals and the full policy-switch
   *  history — what the dashboard's "current eviction policy" /
   *  "policy switching frequency" panels read from. */
  router.get('/metrics/eviction', (_req: Request, res: Response) => {
    res.status(200).json({
      nodeId: ctx.nodeId,
      currentPolicy: ctx.evictionEngine.getCurrentPolicy(),
      autoSwitchEnabled: ctx.evictionEngine.isAutoSwitchEnabled(),
      signals: ctx.evictionEngine.getSignals(),
      switchHistory: ctx.evictionEngine.getSwitchHistory(),
    });
  });

  return router;
}