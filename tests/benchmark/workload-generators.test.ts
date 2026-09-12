import { describe, it, expect } from 'vitest';
import {
  UniformRandomWorkload,
  ZipfianWorkload,
  SequentialScanWorkload,
  MixedWorkload,
  createWorkload,
  WorkloadType,
} from '@flowcache/benchmark';

describe('UniformRandomWorkload', () => {
  it('only ever generates keys within the configured keyspace', () => {
    const workload = new UniformRandomWorkload(100, 0.8, 'k');
    const ops = workload.nextBatch(500);

    for (const op of ops) {
      const index = Number(op.key.split(':')[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(100);
    }
  });

  it('roughly respects the configured read/write ratio over a large sample', () => {
    const workload = new UniformRandomWorkload(1000, 0.9);
    const ops = workload.nextBatch(5000);
    const reads = ops.filter((op) => op.op === 'GET').length;

    expect(reads / ops.length).toBeGreaterThan(0.8);
    expect(reads / ops.length).toBeLessThan(1.0);
  });
});

describe('ZipfianWorkload', () => {
  it('concentrates the majority of accesses on a small set of hot keys', () => {
    const workload = new ZipfianWorkload(1000, 1.0, 1.5); // readRatio=1.0 so every op has a key we can count
    const ops = workload.nextBatch(10_000);

    const counts = new Map<string, number>();
    for (const op of ops) counts.set(op.key, (counts.get(op.key) ?? 0) + 1);

    const sorted = [...counts.values()].sort((a, b) => b - a);
    const top10Sum = sorted.slice(0, 10).reduce((a, b) => a + b, 0);

    // With a meaningfully skewed distribution over 1000 keys, the top
    // 10 keys should account for a large share of all accesses — far
    // more than the ~1% a uniform distribution would produce.
    expect(top10Sum / ops.length).toBeGreaterThan(0.2);
  });

  it('every generated rank is within the keyspace', () => {
    const workload = new ZipfianWorkload(50, 1.0, 1.07);
    const ops = workload.nextBatch(2000);
    for (const op of ops) {
      const rank = Number(op.key.split(':')[1]);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(50);
    }
  });
});

describe('SequentialScanWorkload', () => {
  it('generates strictly monotonically increasing keys, wrapping at the keyspace boundary', () => {
    const workload = new SequentialScanWorkload(5, 'k', 'GET');
    const ops = workload.nextBatch(12);
    const indices = ops.map((op) => Number(op.key.split(':')[1]));

    expect(indices).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
  });

  it('every op is a GET when configured that way', () => {
    const workload = new SequentialScanWorkload(10, 'k', 'GET');
    const ops = workload.nextBatch(20);
    expect(ops.every((op) => op.op === 'GET')).toBe(true);
  });
});

describe('MixedWorkload', () => {
  it('draws from every component generator over enough samples', () => {
    const a = new SequentialScanWorkload(1, 'a', 'GET'); // always key "a:0"
    const b = new SequentialScanWorkload(1, 'b', 'GET'); // always key "b:0"
    const mixed = new MixedWorkload([
      { generator: a, weight: 1 },
      { generator: b, weight: 1 },
    ]);

    const ops = mixed.nextBatch(200);
    const keys = new Set(ops.map((op) => op.key));
    expect(keys.has('a:0')).toBe(true);
    expect(keys.has('b:0')).toBe(true);
  });

  it('throws if constructed with zero component generators', () => {
    expect(() => new MixedWorkload([])).toThrow();
  });
});

describe('createWorkload (factory)', () => {
  it('maps every WorkloadType to a generator with a matching .type', () => {
    for (const type of Object.values(WorkloadType)) {
      const workload = createWorkload({ type, keyspaceSize: 100 });
      expect(workload.type).toBe(type);
      expect(workload.nextBatch(5)).toHaveLength(5);
    }
  });
});