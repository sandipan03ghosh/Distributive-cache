/**
 * @flowcache/cache-node — fault/FaultInjector.ts
 *
 * Holds this node's current fault-injection state and exposes small,
 * cheap checks the request pipeline and replication path consult on
 * every operation:
 *   - KILL / RESTART toggle `isKilled()`, which the health check and
 *     `/cache/*` routes use to fail fast (503) while "down," and the
 *     RecoveryEngine uses to re-run recovery on RESTART.
 *   - DELAY_REPLICATION sets an artificial delay applied before the
 *     node publishes a replication event.
 *   - DROP_MESSAGES sets a probability that a given replication
 *     publish is skipped entirely, simulating message loss.
 *
 * This is intentionally simple in-memory state, not a separate
 * service — fault injection needs to affect *this* node's behavior
 * directly, in-process.
 */

import { EventEmitter } from 'node:events';
import type { FaultInjectionCommand } from '@flowcache/shared';

interface FaultState {
  killed: boolean;
  replicationDelayMs: number;
  dropRate: number;
}

export class FaultInjector extends EventEmitter {
  private state: FaultState = { killed: false, replicationDelayMs: 0, dropRate: 0 };

  async apply(command: FaultInjectionCommand): Promise<void> {
    switch (command.type) {
      case 'KILL':
        this.state.killed = true;
        this.emit('killed');
        break;

      case 'RESTART':
        this.state.killed = false;
        this.emit('restarted');
        break;

      case 'DELAY_REPLICATION':
        this.state.replicationDelayMs = command.durationMs ?? 2000;
        this.emit('replicationDelaySet', this.state.replicationDelayMs);
        break;

      case 'DROP_MESSAGES':
        this.state.dropRate = clamp01(command.dropRate ?? 0.5);
        this.emit('dropRateSet', this.state.dropRate);
        break;

      default: {
        const exhaustiveCheck: never = command.type;
        throw new Error(`Unknown fault injection command type: ${String(exhaustiveCheck)}`);
      }
    }
  }

  isKilled(): boolean {
    return this.state.killed;
  }

  getReplicationDelayMs(): number {
    return this.state.replicationDelayMs;
  }

  shouldDropReplicationMessage(): boolean {
    return Math.random() < this.state.dropRate;
  }

  getState(): Readonly<FaultState> {
    return { ...this.state };
  }

  /** Clears all injected faults — used after a RESTART so the node
   *  comes back fully healthy rather than merely un-killed. */
  reset(): void {
    this.state = { killed: false, replicationDelayMs: 0, dropRate: 0 };
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}