/**
 * @flowcache/worker-pool — TaskTypes.ts
 *
 * Named constants for the built-in task types, so callers write
 * `pool.submitTask(TaskTypes.SNAPSHOT_SERIALIZE, ...)` instead of
 * scattering the raw string literals across services.
 */

export const TaskTypes = {
  SNAPSHOT_SERIALIZE: 'snapshot:serialize',
  REPLICATION_ENCODE: 'replication:encode',
  CLEANUP_FIND_EXPIRED: 'cleanup:find-expired',
  BENCHMARK_EXECUTE_OPS: 'benchmark:execute-ops',
} as const;

export type TaskType = (typeof TaskTypes)[keyof typeof TaskTypes];