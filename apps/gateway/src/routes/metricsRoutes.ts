/**
 * @flowcache/gateway — routes/metricsRoutes.ts
 *
 * Fans out to every non-DEAD node's `/metrics` concurrently and merges
 * the results with `aggregateClusterMetrics` (from @flowcache/metrics)
 * into one cluster-wide view. A single unreachable node degrades the
 * response (that node is simply omitted) rather than failing the whole
 * request.
 */

import { Router, type Request, type Response } from 'express';
import { NodeStatus, type MetricsSnapshot } from '@flowcache/shared';
import { aggregateClusterMetrics } from '@flowcache/metrics';
import type { GatewayContext } from '../GatewayContext.js';

export function createMetricsRoutes(ctx: GatewayContext): Router {
  const router = Router();

  router.get('/metrics', async (_req: Request, res: Response) => {
    const nodes = ctx.ring.getPhysicalNodes().filter((n) => n.status !== NodeStatus.DEAD);

    const snapshots = await Promise.all(
      nodes.map(async (node): Promise<MetricsSnapshot | null> => {
        try {
          return await ctx.client.getMetrics(node);
        } catch (err) {
          ctx.logger.debug({ nodeId: node.nodeId, err }, 'Skipping unreachable node in metrics aggregation');
          return null;
        }
      }),
    );

    const validSnapshots = snapshots.filter((s): s is MetricsSnapshot => s !== null);
    res.status(200).json(aggregateClusterMetrics(validSnapshots));
  });

  return router;
}