/**
 * @flowcache/worker-pool — workers/handlers/registry.ts
 *
 * A tiny plugin registry that lives *inside* the worker thread. Each
 * handler module (e.g. `snapshotSerializeHandler.ts`) calls
 * `registerHandler(type, fn)` as a side effect of being imported;
 * `workerEntry.ts` imports `./handlers/index.js` once at worker
 * startup, which pulls in every built-in handler module, then looks
 * handlers up by task type as messages arrive.
 */

import type { TaskHandler } from '../../types.js';

const handlers = new Map<string, TaskHandler<unknown, unknown>>();

export function registerHandler<P, R>(type: string, handler: TaskHandler<P, R>): void {
  if (handlers.has(type)) {
    throw new Error(`A task handler is already registered for type "${type}"`);
  }
  handlers.set(type, handler as TaskHandler<unknown, unknown>);
}

export function getHandler(type: string): TaskHandler<unknown, unknown> | undefined {
  return handlers.get(type);
}

export function registeredTaskTypes(): string[] {
  return [...handlers.keys()];
}