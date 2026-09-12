/**
 * @flowcache/cache-node — routes/healthRoutes.ts
 *
 * Always responds 200 — the *body*, not the HTTP status, communicates
 * health. This lets a naive "is it reachable" load-balancer check and
 * the gateway's application-aware health poller (which reads `status`)
 * both get useful signal from the same endpoint, and it means a
 * momentarily-overloaded node still gets a chance to report `SUSPECT`
 * rather than looking identical to a fully dead one.
 */

import { Router, type Request, type Response } from 'express';
import { NodeStatus, type HealthCheckResponse } from '@flowcache/shared';
import type { CacheNodeContext } from '../CacheNodeContext.js';

export function createHealthRoutes(ctx: CacheNodeContext): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/health', (_req: Request, res: Response) => {
    const status = ctx.faultInjector.isKilled() ? NodeStatus.DEAD : NodeStatus.HEALTHY;
    const body: HealthCheckResponse = {
      nodeId: ctx.nodeId,
      status,
      uptimeMs: Date.now() - startedAt,
      timestamp: Date.now(),
    };
    res.status(200).json(body);
  });

  return router;
}