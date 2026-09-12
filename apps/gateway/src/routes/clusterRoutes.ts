/**
 * @flowcache/gateway — routes/clusterRoutes.ts
 *
 * Powers the dashboard's cluster topology / hash ring visualization.
 * Deliberately does NOT fan out to every node's `/metrics` on every
 * call (that's what `GET /metrics` is for) — `totalKeys` is left at 0
 * here so polling `/cluster` stays cheap; the dashboard combines this
 * with a `/metrics` call when it needs both views.
 */

import { Router, type Request, type Response } from 'express';
import type { ClusterView } from '@flowcache/shared';
import type { GatewayContext } from '../GatewayContext.js';

export function createClusterRoutes(ctx: GatewayContext): Router {
  const router = Router();

  router.get('/cluster', (_req: Request, res: Response) => {
    const nodes = ctx.ring.getPhysicalNodes();
    const ring = ctx.ring.getRingSnapshot();

    const body: ClusterView = {
      nodes,
      ring,
      virtualNodesPerNode: nodes.length > 0 ? Math.round(ring.length / nodes.length) : 0,
      totalKeys: 0,
    };
    res.status(200).json(body);
  });

  return router;
}