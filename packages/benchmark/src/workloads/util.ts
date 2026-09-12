/**
 * @flowcache/benchmark — workloads/util.ts
 */

/** Small, cheap-to-generate synthetic payload for benchmark PUTs. Kept
 *  intentionally lightweight — the benchmark is measuring the cache's
 *  behavior, not JSON serialization cost. */
export function syntheticValue(seed: number): Record<string, unknown> {
  return {
    seed,
    generatedAt: Date.now(),
    payload: Math.random().toString(36).slice(2, 10),
  };
}