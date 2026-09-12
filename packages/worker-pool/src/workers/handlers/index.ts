/**
 * @flowcache/worker-pool — workers/handlers/index.ts
 *
 * Importing this module (for its side effects) registers all four
 * built-in task handlers. `workerEntry.ts` imports this once at worker
 * thread startup.
 */

import './snapshotSerializeHandler.js';
import './replicationEncodeHandler.js';
import './cleanupExpiredHandler.js';
import './benchmarkExecuteOpsHandler.js';

export { getHandler, registerHandler, registeredTaskTypes } from './registry.js';