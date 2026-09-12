/**
 * @flowcache/gateway — routes/healthRoutes.ts
 *
 * The gateway's own liveness check — distinct from the per-node health
 * reflected in `/cluster`. A load balancer in front of multiple
 * gateway replicas would point here.
 */

import { Router, type Request, type Response } from 'express';

export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'HEALTHY', timestamp: Date.now() });
  });

  return router;
}