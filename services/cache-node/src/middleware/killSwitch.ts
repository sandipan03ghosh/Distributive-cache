/**
 * @flowcache/cache-node — middleware/killSwitch.ts
 *
 * Applied only to the public `/cache/*` and `/metrics` routes (not
 * `/health` or `/internal/*`): while this node has been fault-injected
 * into a KILLED state, client-facing requests fail fast with a 503
 * rather than being served as if nothing were wrong. `/health` stays
 * reachable and reports `DEAD` in its body so the gateway can route
 * around this node; `/internal/fault-injection` stays reachable so a
 * RESTART command can actually bring the node back.
 */

import type { NextFunction, Request, Response } from 'express';
import { NodeUnavailableError } from '@flowcache/shared';
import type { CacheNodeContext } from '../CacheNodeContext.js';

export function killSwitchMiddleware(ctx: CacheNodeContext) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    if (ctx.faultInjector.isKilled()) {
      next(new NodeUnavailableError(ctx.nodeId));
      return;
    }
    next();
  };
}