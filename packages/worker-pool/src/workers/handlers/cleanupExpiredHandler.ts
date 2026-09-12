/**
 * @flowcache/worker-pool — workers/handlers/cleanupExpiredHandler.ts
 *
 * Task: CLEANUP_FIND_EXPIRED ('cleanup:find-expired')
 *
 * `StorageEngine.sweepExpired()` already does a cheap in-process,
 * main-thread sweep on an interval, which is sufficient for most
 * workloads. This handler exists for the case of a very large cache
 * (millions of entries) where even that linear scan is worth moving
 * off the request-handling thread: the caller snapshots the entry
 * list, dispatches it here, and gets back just the keys to delete.
 */

import { TaskTypes } from '../../TaskTypes.js';
import { registerHandler } from './registry.js';
import type { CleanupFindExpiredPayload, CleanupFindExpiredResult } from '../../types.js';

registerHandler<CleanupFindExpiredPayload, CleanupFindExpiredResult>(
  TaskTypes.CLEANUP_FIND_EXPIRED,
  async ({ entries, nowMs }) => {
    const expiredKeys: string[] = [];
    for (const entry of entries) {
      if (entry.metadata.expiresAt !== null && entry.metadata.expiresAt <= nowMs) {
        expiredKeys.push(entry.key);
      }
    }
    return { expiredKeys };
  },
);