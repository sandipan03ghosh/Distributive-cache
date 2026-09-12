/**
 * @flowcache/cache-node — routes/cacheRoutes.ts
 *
 * The three primary client-facing endpoints. GET is fully synchronous
 * over HTTP (never touches Kafka — see the architecture note in
 * CacheNodeServer). PUT and DELETE apply to local storage first, then
 * kick off asynchronous replication: a replication failure or timeout
 * never fails the client's write, since FlowCache's replication model
 * is deliberately asynchronous (see @flowcache/replication).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  KeyNotFoundError,
  ValidationError,
  decodeCacheKeyParam,
  type DeleteResponseBody,
  type GetResponseBody,
  type PutRequestBody,
  type PutResponseBody,
} from '@flowcache/shared';
import type { CacheNodeContext } from '../CacheNodeContext.js';

export function createCacheRoutes(ctx: CacheNodeContext): Router {
  const router = Router();

  router.get('/cache/:key', (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = decodeCacheKeyParam(req.params.key as string);
      const entry = ctx.storage.get(key);
      if (!entry) {
        throw new KeyNotFoundError(key);
      }

      const body: GetResponseBody = {
        key,
        value: entry.value,
        metadata: entry.metadata,
        nodeId: ctx.nodeId,
      };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.put('/cache', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<PutRequestBody> | undefined;
      if (!body || typeof body.key !== 'string' || body.key.length === 0) {
        throw new ValidationError('Request body must include a non-empty string "key"');
      }
      if (!('value' in body)) {
        throw new ValidationError('Request body must include a "value" field');
      }
      if (body.ttlMs !== undefined && (typeof body.ttlMs !== 'number' || body.ttlMs <= 0)) {
        throw new ValidationError('"ttlMs", if provided, must be a positive number');
      }

      const entry = ctx.storage.set(body.key, body.value, { ttlMs: body.ttlMs });

      // Fire replication in the background — never block the client's
      // response on it. Kafka connectivity trouble (e.g. a stale
      // connection needing to reconnect) can take many seconds to
      // resolve via retries; awaiting that here would make PUT latency
      // hostage to Kafka's health, contradicting the documented
      // "off the critical path" replication model (see the
      // architecture note atop CacheNodeServer.ts and the write-path
      // sequence diagram in the README, which shows the response as
      // `{version, replicated: false}`).
      ctx.replicateWrite(body.key, entry.value, entry.metadata).catch((err: unknown) => {
        ctx.logger.warn({ err, key: body.key }, 'Replication failed after local write; write still succeeded locally');
      });

      const response: PutResponseBody = {
        key: body.key,
        version: entry.metadata.version,
        nodeId: ctx.nodeId,
        replicated: false,
      };
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cache/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = decodeCacheKeyParam(req.params.key as string);
      const deleted = ctx.storage.delete(key);

      if (deleted) {
        // Same fire-and-forget reasoning as PUT above — never block the
        // response on Kafka.
        ctx.replicateDelete(key).catch((err: unknown) => {
          ctx.logger.warn({ err, key }, 'Replication failed after local delete; delete still succeeded locally');
        });
      }

      const response: DeleteResponseBody = { key, deleted, nodeId: ctx.nodeId };
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}