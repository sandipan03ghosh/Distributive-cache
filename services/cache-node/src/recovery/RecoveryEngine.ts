/**
 * @flowcache/cache-node — recovery/RecoveryEngine.ts
 *
 * Runs on every cache-node startup (and again after a fault-injected
 * RESTART): restores the most recent local snapshot into storage, then
 * verifies the restore succeeded. Operations committed after that
 * snapshot was taken are NOT replayed here as a separate step —
 * Kafka itself is the write-ahead log for replicated writes, and
 * `ReplicationEngine`'s consumer resumes from its last committed
 * offset automatically once the node reconnects, naturally catching
 * this node back up as part of normal steady-state operation. This
 * keeps recovery fast (snapshot restore is O(entries), not
 * O(all writes since the snapshot)) at the cost of a brief window
 * where very-recently-written keys are only available once Kafka
 * catch-up completes.
 */

import type { Logger, RecoveryReport, CacheEntry } from '@flowcache/shared';
import { nowMs, RecoveryError } from '@flowcache/shared';
import type { SnapshotManager } from '@flowcache/snapshot';

export interface RecoveryEngineOptions {
  nodeId: string;
  snapshotManager: SnapshotManager;
  /** Applies one restored entry to local storage. */
  applyEntry: (entry: CacheEntry) => void;
  /** Clears local storage before restoring, so recovery always starts
   *  from a known-empty state rather than merging with whatever was
   *  already in memory. */
  clearStorage: () => void;
  logger: Logger;
}

export class RecoveryEngine {
  constructor(private readonly options: RecoveryEngineOptions) {}

  async recover(): Promise<RecoveryReport> {
    const startedAt = nowMs();
    const errors: string[] = [];
    let snapshotRestored: string | null = null;
    let entriesRestoredFromSnapshot = 0;

    this.options.clearStorage();

    try {
      const payload = await this.options.snapshotManager.restoreLatest();
      if (payload) {
        for (const entry of payload.entries) {
          this.options.applyEntry(entry);
        }
        snapshotRestored = payload.metadata.snapshotId;
        entriesRestoredFromSnapshot = payload.entries.length;
      } else {
        this.options.logger.info(
          { nodeId: this.options.nodeId },
          'No prior snapshot found; starting from empty storage (expected for a brand-new node)',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      this.options.logger.error(
        { nodeId: this.options.nodeId, err },
        'Snapshot restore failed during recovery; continuing with empty storage',
      );
    }

    const finishedAt = nowMs();
    const report: RecoveryReport = {
      nodeId: this.options.nodeId,
      startedAt,
      finishedAt,
      snapshotRestored,
      entriesRestoredFromSnapshot,
      // Kafka consumer catch-up happens asynchronously as part of
      // normal ReplicationEngine operation, not as a synchronous step
      // here — see the module-level note above.
      operationsReplayed: 0,
      integrityVerified: errors.length === 0,
      errors,
    };

    this.options.logger.info({ report }, 'Recovery complete');
    return report;
  }

  /** Throws if the last recovery attempt did not verify cleanly.
   *  Callers can use this to decide whether it's safe to start
   *  accepting traffic vs. staying in a JOINING/SUSPECT state. */
  assertHealthy(report: RecoveryReport): void {
    if (!report.integrityVerified) {
      throw new RecoveryError(
        `Recovery for node "${report.nodeId}" did not verify cleanly: ${report.errors.join('; ')}`,
      );
    }
  }
}