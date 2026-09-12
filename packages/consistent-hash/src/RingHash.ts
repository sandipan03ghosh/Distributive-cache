/**
 * @flowcache/consistent-hash — RingHash.ts
 *
 * A small, self-contained, dependency-free 32-bit string hash used to
 * place both real and virtual nodes, and keys, onto the hash ring's
 * [0, 2^32) circular keyspace. Two independent hash "rounds" are
 * combined (double hashing) to reduce clustering versus a single
 * 32-bit FNV-1a pass, which matters for ring quality once you're
 * hashing hundreds of virtual node labels.
 *
 * This is intentionally a different implementation than the
 * CountMinSketch's hash in `packages/eviction` — the two packages have
 * no dependency on each other by design (see the DAG note in
 * packages/eviction/src/EvictionPolicy.ts).
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32(input: string, seed = 0): number {
  let hash = (FNV_OFFSET_BASIS ^ seed) >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** djb2, used as the second independent hash function for double
 *  hashing / point diversification. */
function djb2(input: string, seed = 5381): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 33) + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Produces a deterministic, well-distributed 32-bit unsigned integer
 * position on the ring for the given input string. Combining fnv1a32
 * and djb2 (rather than using either alone) meaningfully improves
 * point distribution uniformity for the label patterns virtual nodes
 * use (`${nodeId}#${i}`), which tend to differ only in a numeric
 * suffix — exactly the kind of near-duplicate input that makes a
 * single weak hash cluster.
 */
export function ringHash(input: string): number {
  const a = fnv1a32(input);
  const b = djb2(input);
  // XOR-fold the two hashes together, then run one more avalanche
  // multiply so the combination isn't trivially separable back into
  // its two components.
  let combined = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  combined ^= combined >>> 15;
  combined = Math.imul(combined, 0x85ebca6b) >>> 0;
  combined ^= combined >>> 13;
  return combined >>> 0;
}