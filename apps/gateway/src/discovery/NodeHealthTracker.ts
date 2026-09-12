/**
 * @flowcache/gateway — discovery/NodeHealthTracker.ts
 *
 * Periodically polls `GET /health` on every node the ring knows about
 * and updates that node's `NodeStatus` in the ring accordingly.
 * Applies simple hysteresis (`suspectAfterMisses` / `deadAfterMisses`
 * consecutive failures) rather than flipping status on a single missed
 * check, so one slow response or transient network blip doesn't yank a
 * healthy node out of rotation.
 *
 * This is what makes the gateway's request routing fault-tolerant:
 * `cacheRoutes.ts` only ever forwards to nodes this tracker currently
 * considers non-DEAD.
 */

import { NodeStatus, nowMs, type Logger, type NodeInfo } from '@flowcache/shared';
import type { ConsistentHashRing } from '@flowcache/consistent-hash';
import type { CacheNodeClient } from './CacheNodeClient.js';

export interface NodeHealthTrackerOptions {
  ring: ConsistentHashRing;
  client: CacheNodeClient;
  intervalMs: number;
  suspectAfterMisses: number;
  deadAfterMisses: number;
  logger: Logger;
}

export class NodeHealthTracker {
  private readonly missCounts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: NodeHealthTrackerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollAll().catch((err: unknown) => this.options.logger.warn({ err }, 'Health poll cycle failed'));
    }, this.options.intervalMs);
    this.timer.unref?.();

    // Poll immediately on startup rather than waiting a full interval,
    // so the ring reflects real node health as soon as possible.
    void this.pollAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollAll(): Promise<void> {
    const nodes = this.options.ring.getPhysicalNodes();
    await Promise.all(nodes.map((node) => this.pollOne(node)));
  }

  private async pollOne(node: NodeInfo): Promise<void> {
    try {
      const health = await this.options.client.getHealth(node);
      this.missCounts.set(node.nodeId, 0);

      // A node that self-reports DEAD (e.g. fault-injected) is treated
      // as SUSPECT here rather than immediately DEAD from the gateway's
      // perspective — the miss-count threshold below is what actually
      // pulls it out of rotation, giving a consistent, observable
      // HEALTHY -> SUSPECT -> DEAD progression regardless of whether
      // the failure is "unreachable" or "self-reported down."
      const status = health.status === NodeStatus.DEAD ? NodeStatus.SUSPECT : NodeStatus.HEALTHY;
      this.options.ring.updateNodeStatus(node.nodeId, status, nowMs());
    } catch (err) {
      const misses = (this.missCounts.get(node.nodeId) ?? 0) + 1;
      this.missCounts.set(node.nodeId, misses);

      const status =
        misses >= this.options.deadAfterMisses
          ? NodeStatus.DEAD
          : misses >= this.options.suspectAfterMisses
            ? NodeStatus.SUSPECT
            : node.status; // below threshold: leave status as-is (hysteresis)

      this.options.ring.updateNodeStatus(node.nodeId, status, node.lastHeartbeat);
      this.options.logger.debug({ nodeId: node.nodeId, misses, status, err }, 'Health check miss');
    }
  }
}