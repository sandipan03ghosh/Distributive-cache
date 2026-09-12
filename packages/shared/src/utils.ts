/**
 * @flowcache/shared — utils.ts
 *
 * Small dependency-free helpers used across packages. Kept intentionally
 * minimal — anything with real algorithmic weight (hashing, percentile
 * calculation, etc.) lives in its own dedicated package.
 */

import { ValidationError } from './errors.js';

let counter = 0;

/** Decodes a `:key` route param, turning a malformed percent-encoding
 *  (e.g. a client requesting `/cache/%zz`) into a `ValidationError` (400)
 *  instead of letting the raw `URIError` fall through to the generic
 *  500 `INTERNAL_ERROR` path in `toErrorResponse` — a client sending a
 *  bad key is a client error, not a server fault, and shouldn't be
 *  logged/alerted on as one. */
export function decodeCacheKeyParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ValidationError(`Malformed key in URL: "${raw}"`);
  }
}

/** Monotonic-ish unique id: timestamp + process-local counter + random
 *  suffix. Good enough for event/correlation ids; not a UUID and makes
 *  no cross-process uniqueness guarantee beyond the random suffix. */
export function generateId(prefix = 'id'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Approximate byte size of a JSON-serializable value. Used for memory
 *  accounting; not exact (doesn't account for V8 object overhead) but
 *  consistent and cheap, which is what eviction heuristics need. */
export function approximateSizeBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 64; // fallback for non-serializable values (functions, symbols, circular refs)
  }
}

/** Exponential moving average helper, used by metrics + workload signal
 *  smoothing so that adaptive decisions aren't jittery on single samples. */
export class Ema {
  private value: number | null = null;
  constructor(private readonly alpha: number) {
    if (alpha <= 0 || alpha > 1) {
      throw new RangeError('Ema alpha must be in (0, 1]');
    }
  }

  update(sample: number): number {
    this.value = this.value === null ? sample : this.alpha * sample + (1 - this.alpha) * this.value;
    return this.value;
  }

  get(): number {
    return this.value ?? 0;
  }

  reset(): void {
    this.value = null;
  }
}

/** A fixed-capacity ring buffer, used for latency samples and sliding
 *  workload windows without unbounded memory growth. */
export class RingBuffer<T> {
  private readonly buf: T[] = [];
  private cursor = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new RangeError('RingBuffer capacity must be > 0');
  }

  push(item: T): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(item);
    } else {
      this.buf[this.cursor] = item;
    }
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  toArray(): T[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
    this.cursor = 0;
  }
}

export function nowMs(): number {
  return Date.now();
}