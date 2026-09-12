/**
 * @flowcache/eviction — CountMinSketch.ts
 *
 * A from-scratch Count-Min Sketch: a fixed-size probabilistic frequency
 * table. Instead of storing an exact counter per key (unbounded
 * memory), it hashes each key into `depth` independent rows of a
 * `width`-wide counter array and increments one cell per row.
 * `estimate(key)` returns the minimum across those rows, which is
 * guaranteed to never under-count and, with a reasonably sized table,
 * rarely over-counts by much. This is the frequency-estimation core of
 * TinyLFU (per Einziger/Friedman/Manes' "TinyLFU: A Highly Efficient
 * Cache Admission Policy").
 *
 * Periodic aging (halving every counter) keeps the sketch responsive
 * to workload shifts instead of accumulating stale, ever-growing
 * counts forever.
 */

const DEFAULT_WIDTH = 2048; // counters per row; larger = fewer hash collisions
const DEFAULT_DEPTH = 4; // independent hash rows; larger = fewer worst-case overestimates
const MAX_COUNTER = 65535; // fits in Uint16Array
const DEFAULT_AGING_THRESHOLD = 50_000; // increments between halving passes

export class CountMinSketch {
  private readonly width: number;
  private readonly depth: number;
  private readonly agingThreshold: number;
  private readonly table: Uint16Array;
  private additionsSinceAging = 0;

  constructor(
    width: number = DEFAULT_WIDTH,
    depth: number = DEFAULT_DEPTH,
    agingThreshold: number = DEFAULT_AGING_THRESHOLD,
  ) {
    if (width <= 0 || depth <= 0) {
      throw new RangeError('CountMinSketch width and depth must be positive');
    }
    this.width = width;
    this.depth = depth;
    this.agingThreshold = agingThreshold;
    this.table = new Uint16Array(width * depth);
  }

  increment(key: string): void {
    for (let row = 0; row < this.depth; row++) {
      const idx = this.indexFor(key, row);
      if (this.table[idx] < MAX_COUNTER) {
        this.table[idx] += 1;
      }
    }
    this.additionsSinceAging += 1;
    if (this.additionsSinceAging >= this.agingThreshold) {
      this.age();
    }
  }

  estimate(key: string): number {
    let min = MAX_COUNTER;
    for (let row = 0; row < this.depth; row++) {
      const idx = this.indexFor(key, row);
      const value = this.table[idx];
      if (value < min) min = value;
    }
    return min;
  }

  /** Halves every counter. Bounds staleness: without aging, a key that
   *  was hot an hour ago but is now cold would keep "winning" against
   *  genuinely hot new keys forever. */
  age(): void {
    for (let i = 0; i < this.table.length; i++) {
      this.table[i] = this.table[i] >>> 1;
    }
    this.additionsSinceAging = 0;
  }

  reset(): void {
    this.table.fill(0);
    this.additionsSinceAging = 0;
  }

  private indexFor(key: string, row: number): number {
    const h = fnv1aWithSeed(key, row);
    return row * this.width + (h % this.width);
  }
}

/**
 * FNV-1a string hash, salted per row by folding in the row index before
 * hashing. Implemented from scratch — no external hashing library — to
 * get `depth` cheap, sufficiently independent hash functions out of a
 * single well-known, fast algorithm rather than needing `depth`
 * separate hash implementations.
 */
function fnv1aWithSeed(key: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // 32-bit FNV prime multiplication, kept within int32 via Math.imul
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned so `% width` never goes negative.
  return hash >>> 0;
}