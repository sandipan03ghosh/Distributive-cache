import { describe, it, expect } from 'vitest';
import { ConsistentHashRing, analyzeKeyMovement, generateSampleKeyspace } from '@flowcache/consistent-hash';
import { NodeStatus, type NodeInfo } from '@flowcache/shared';

function node(id: string, weight = 1): NodeInfo {
  return { nodeId: id, host: id, port: 4001, weight, status: NodeStatus.HEALTHY, lastHeartbeat: 0 };
}

describe('ConsistentHashRing', () => {
  it('is deterministic: the same key always maps to the same node', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 64 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));
    ring.addNode(node('c'));

    const first = ring.getNode('user:123');
    for (let i = 0; i < 10; i++) {
      expect(ring.getNode('user:123')).toBe(first);
    }
  });

  it('returns null for an empty ring', () => {
    const ring = new ConsistentHashRing();
    expect(ring.getNode('anything')).toBeNull();
  });

  it('creates virtual nodes proportional to weight', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 100 });
    ring.addNode(node('light', 1));
    ring.addNode(node('heavy', 3));

    const lightCount = ring.getRingSnapshot().filter((p) => p.nodeId === 'light').length;
    const heavyCount = ring.getRingSnapshot().filter((p) => p.nodeId === 'heavy').length;

    expect(heavyCount).toBeCloseTo(lightCount * 3, -1); // within an order of magnitude tolerance
  });

  it('distributes keys reasonably evenly across nodes', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 200 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));
    ring.addNode(node('c'));

    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 3000; i++) {
      const owner = ring.getNode(`key:${i}`);
      if (owner) counts[owner] += 1;
    }

    // With 200 virtual nodes per physical node, no bucket should be
    // wildly imbalanced (a generous tolerance to keep this test
    // reliable rather than flaky).
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(3000 / 3 - 600);
      expect(count).toBeLessThan(3000 / 3 + 600);
    }
  });

  it('getNodesForKey returns distinct physical nodes for replication targets', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 64 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));
    ring.addNode(node('c'));

    const targets = ring.getNodesForKey('some-key', 3);
    expect(new Set(targets).size).toBe(3);
  });

  it('getNodesForKey caps out at the number of physical nodes available', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 64 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));

    const targets = ring.getNodesForKey('some-key', 5);
    expect(targets).toHaveLength(2);
  });

  it('removeNode() takes a node out of rotation entirely', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 64 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));
    ring.removeNode('a');

    for (let i = 0; i < 50; i++) {
      expect(ring.getNode(`key:${i}`)).toBe('b');
    }
  });

  it('minimal key movement: adding a 4th node only moves roughly 1/N of the keyspace', () => {
    const before = new ConsistentHashRing({ baseVirtualNodeCount: 200 });
    before.addNode(node('a'));
    before.addNode(node('b'));
    before.addNode(node('c'));

    const after = before.clone();
    after.addNode(node('d'));

    const sampleKeys = generateSampleKeyspace(5000);
    const report = analyzeKeyMovement(before, after, sampleKeys);

    // Theoretical minimum here is ~1/4 = 25%. Allow real-world slack
    // for virtual node placement variance, but it must be nowhere
    // near "moved almost everything" (which naive hash % N would do).
    expect(report.movedRatio).toBeLessThan(0.5);
    expect(report.movedRatio).toBeGreaterThan(0);
  });

  it('getHealthyPhysicalNodes() filters by status', () => {
    const ring = new ConsistentHashRing({ baseVirtualNodeCount: 32 });
    ring.addNode(node('a'));
    ring.addNode(node('b'));
    ring.updateNodeStatus('b', NodeStatus.DEAD, 0);

    const healthy = ring.getHealthyPhysicalNodes();
    expect(healthy.map((n) => n.nodeId)).toEqual(['a']);
  });
});