import { describe, it, expect } from 'vitest';
import { CountMinSketch } from '@flowcache/eviction';

describe('CountMinSketch', () => {
  it('never undercounts (estimate >= true count)', () => {
    const sketch = new CountMinSketch(64, 4, 1_000_000);
    for (let i = 0; i < 10; i++) sketch.increment('hot-key');

    expect(sketch.estimate('hot-key')).toBeGreaterThanOrEqual(10);
  });

  it('returns 0 for a key that was never incremented', () => {
    const sketch = new CountMinSketch();
    expect(sketch.estimate('never-seen')).toBe(0);
  });

  it('distinguishes a hot key from a cold key under normal load', () => {
    const sketch = new CountMinSketch(2048, 4);
    for (let i = 0; i < 100; i++) sketch.increment('hot');
    sketch.increment('cold');

    expect(sketch.estimate('hot')).toBeGreaterThan(sketch.estimate('cold'));
  });

  it('age() halves every counter', () => {
    const sketch = new CountMinSketch(64, 4, 1_000_000);
    for (let i = 0; i < 20; i++) sketch.increment('k');

    const before = sketch.estimate('k');
    sketch.age();
    const after = sketch.estimate('k');

    expect(after).toBeLessThanOrEqual(Math.ceil(before / 2) + 1);
    expect(after).toBeGreaterThan(0);
  });

  it('automatically ages after agingThreshold increments', () => {
    const sketch = new CountMinSketch(64, 4, 10);
    // agingThreshold counts increments, so aging fires as soon as the
    // count reaches it — i.e. on the 10th increment, not the 11th.
    // Stop one short so `atThreshold` reflects the pre-aging state.
    for (let i = 0; i < 9; i++) sketch.increment('k');
    const atThreshold = sketch.estimate('k');

    sketch.increment('k'); // 10th increment triggers an internal age()
    const afterTrigger = sketch.estimate('k');

    // After aging, the estimate should be well below what 10
    // uninterrupted increments would have produced.
    expect(afterTrigger).toBeLessThan(atThreshold + 1);
  });

  it('reset() clears all counters', () => {
    const sketch = new CountMinSketch();
    sketch.increment('k');
    sketch.reset();
    expect(sketch.estimate('k')).toBe(0);
  });
});