/**
 * @flowcache/gateway — routes/cacheRoutes.ts
 *
 * The gateway's core job: hash each request's key to find which node
 * owns it, forward the request, and return the response. `GET` never
 * touches Kafka anywhere in this system — it's plain synchronous HTTP
 * end to end (client -> gateway -> cache node's local storage).
 *
 * Fault tolerance: `forwardWithFailover` doesn't just pick the single
 * ring-owner node — it walks the ring's ordered candidate list
 * (primary, then replicas) and tries each in turn, skipping any
 * already marked DEAD and falling through to the next candidate if a
 * request unexpectedly fails. A `KeyNotFoundError` (the key simply
 * doesn't exist) is NOT treated as a node failure and is not retried
 * against another node.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  KeyNotFoundError,
  NoHealthyNodesError,
  NodeStatus,
  ValidationError,
  decodeCacheKeyParam,
  type CacheKey,
  type NodeInfo,
  type PutRequestBody,
} from '@flowcache/shared';
import type { GatewayContext } from '../GatewayContext.js';

export function createCacheRoutes(ctx: GatewayContext): Router {
  const router = Router();

  router.get('/cache/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = decodeCacheKeyParam(req.params.key as string);
      const body = await forwardWithFailover(ctx, key, (node) => ctx.client.get(node, key));
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.put('/cache', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestBody = req.body as Partial<PutRequestBody> | undefined;
      if (!requestBody || typeof requestBody.key !== 'string' || requestBody.key.length === 0) {
        throw new ValidationError('Request body must include a non-empty string "key"');
      }
      if (!('value' in requestBody)) {
        throw new ValidationError('Request body must include a "value" field');
      }

      const key = requestBody.key;
      const body = await forwardWithFailover(ctx, key, (node) =>
        ctx.client.put(node, requestBody as PutRequestBody),
      );
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cache/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = decodeCacheKeyParam(req.params.key as string);
      const body = await forwardWithFailover(ctx, key, (node) => ctx.client.delete(node, key));
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function forwardWithFailover<T>(
  ctx: GatewayContext,
  key: CacheKey,
  action: (node: NodeInfo) => Promise<T>,
): Promise<T> {
  const candidateIds = ctx.ring.getNodesForKey(key, ctx.replicationFactorForFailover);
  const candidates = candidateIds
    .map((id) => ctx.ring.getNodeInfo(id))
    .filter((n): n is NodeInfo => n !== undefined && n.status !== NodeStatus.DEAD);

  if (candidates.length === 0) {
    throw new NoHealthyNodesError();
  }

  let lastError: unknown = new NoHealthyNodesError();

  for (const node of candidates) {
    try {
      return await action(node);
    } catch (err) {
      if (err instanceof KeyNotFoundError) {
        throw err; // the key genuinely doesn't exist — not a node failure, don't fail over
      }
      lastError = err;
      ctx.logger.warn({ nodeId: node.nodeId, key, err }, 'Request to cache node failed; trying next ring candidate');
    }
  }

  throw lastError;
}