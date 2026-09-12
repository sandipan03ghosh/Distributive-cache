/**
 * @flowcache/cache-node — routes/internalRoutes.ts
 *
 * Cluster-internal endpoints — not meant for end clients, only for
 * other nodes (`ReplicaRecoveryClient`), the benchmark engine
 * (`FaultInjectionClient`, `PolicyComparisonRunner.setPolicy`), and
 * operators. In a production deployment these would typically sit
 * behind a separate internal network / auth boundary; that's outside
 * this project's scope, so it's called out explicitly here instead of
 * silently assumed.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { EvictionPolicyType, ValidationError, type FaultInjectionCommand } from '@flowcache/shared';
import type { CacheNodeContext } from '../CacheNodeContext.js';

const VALID_FAULT_TYPES = new Set<FaultInjectionCommand['type']>([
  'KILL',
  'RESTART',
  'DELAY_REPLICATION',
  'DROP_MESSAGES',
]);

const PINNABLE_POLICIES = new Set<string>([
  EvictionPolicyType.LRU,
  EvictionPolicyType.LFU,
  EvictionPolicyType.TINY_LFU,
]);

export function createInternalRoutes(ctx: CacheNodeContext): Router {
  const router = Router();

  /** Full point-in-time export of this node's local entries. Used by
   *  `ReplicaRecoveryClient.pullFullState()` when another node needs to
   *  bulk-bootstrap beyond what Kafka replay can provide. */
  router.get('/internal/replicate/export', (_req: Request, res: Response) => {
    res.status(200).json([...ctx.storage.entries()]);
  });

  router.post('/internal/fault-injection', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const command = req.body as Partial<FaultInjectionCommand> | undefined;
      if (!command?.type || !VALID_FAULT_TYPES.has(command.type)) {
        throw new ValidationError(`"type" must be one of: ${[...VALID_FAULT_TYPES].join(', ')}`);
      }

      await ctx.faultInjector.apply(command as FaultInjectionCommand);

      if (command.type === 'RESTART') {
        await ctx.onRestart();
      }

      res.status(200).json({ applied: true, command });
    } catch (err) {
      next(err);
    }
  });

  /** Pins a specific eviction policy (pausing auto-switching) or
   *  resumes adaptive mode. This is what `PolicyComparisonRunner` in
   *  `@flowcache/benchmark` calls between runs to measure each policy
   *  in isolation. */
  router.post('/internal/policy', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { policy?: string } | undefined;
      const policy = body?.policy;

      if (policy === 'ADAPTIVE') {
        ctx.evictionEngine.resumeAutoSwitch();
      } else if (policy && PINNABLE_POLICIES.has(policy)) {
        ctx.evictionEngine.pauseAutoSwitch();
        ctx.evictionEngine.forceSwitch(policy as EvictionPolicyType, 'pinned via /internal/policy');
      } else {
        throw new ValidationError(
          `"policy" must be one of: ${[...PINNABLE_POLICIES].join(', ')}, ADAPTIVE`,
        );
      }

      res.status(200).json({
        currentPolicy: ctx.evictionEngine.getCurrentPolicy(),
        autoSwitchEnabled: ctx.evictionEngine.isAutoSwitchEnabled(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}