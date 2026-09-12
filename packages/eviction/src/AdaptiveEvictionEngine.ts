/**
 * @flowcache/eviction — AdaptiveEvictionEngine.ts
 *
 * The core innovation of FlowCache. Implements `EvictionPolicy` /
 * `EvictionHook` itself (so it drops directly into
 * `new StorageEngine({ evictionHook: adaptiveEngine })`), but every
 * call is delegated to whichever concrete policy (LRU / LFU / TinyLFU)
 * is currently "active". A background timer periodically:
 *
 *   1. Pulls a `WorkloadSignals` snapshot from the `WorkloadMonitor`.
 *   2. Feeds it through `decidePolicy` (deterministic rule table).
 *   3. If the recommended policy differs from the active one — and
 *      enough samples have been observed, and we're past the
 *      switch cooldown (to prevent thrashing back and forth) — swaps
 *      in a freshly constructed policy, seeded from a snapshot of the
 *      current cache entries so it doesn't start from a blank slate.
 *
 * Every switch is recorded and emitted as a `policySwitch` event so the
 * metrics/dashboard layers can show policy-switching frequency and the
 * reasoning behind each decision.
 */

import { EventEmitter } from 'node:events';
import {
  EvictionPolicyType,
  type CacheEntry,
  type CacheKey,
  type PolicySwitchEvent,
  type WorkloadSignals,
} from '@flowcache/shared';
import type { EvictionHook } from '@flowcache/storage-engine';
import type { EvictionPolicy } from './EvictionPolicy.js';
import { createEvictionPolicy } from './PolicyFactory.js';
import { WorkloadMonitor } from './WorkloadMonitor.js';
import { decidePolicy } from './DecisionRules.js';

export interface AdaptiveEvictionEngineOptions {
  /** Policy to start with before any workload has been observed. */
  initialPolicy?: EvictionPolicyType;
  /** Minimum cumulative observed operations before the engine will
   *  make its first (or any) switching decision. Prevents thrashing on
   *  a cold start with almost no data. */
  minSamplesBeforeSwitch?: number;
  /** Minimum time between two switches, regardless of what the rules
   *  recommend, to prevent rapid oscillation between policies. */
  cooldownMs?: number;
  /** How often the engine re-evaluates workload signals and considers
   *  switching. */
  evaluationIntervalMs?: number;
  /** Max number of switch events retained in `getSwitchHistory()`. */
  maxHistoryLength?: number;
}

const DEFAULTS: Required<AdaptiveEvictionEngineOptions> = {
  initialPolicy: EvictionPolicyType.LRU,
  minSamplesBeforeSwitch: 200,
  cooldownMs: 15_000,
  evaluationIntervalMs: 5_000,
  maxHistoryLength: 200,
};

export class AdaptiveEvictionEngine extends EventEmitter implements EvictionHook {
  private active: EvictionPolicy;
  private readonly monitor = new WorkloadMonitor();
  private readonly options: Required<AdaptiveEvictionEngineOptions>;

  private lastSwitchAt = 0;
  private evaluationTimer: NodeJS.Timeout | null = null;
  private switchHistory: PolicySwitchEvent[] = [];
  private autoSwitchEnabled = true;

  private getMemoryUsageRatio: () => number = () => 0;
  private getCurrentEntries: () => readonly CacheEntry[] = () => [];

  constructor(options: AdaptiveEvictionEngineOptions = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
    this.active = createEvictionPolicy(this.options.initialPolicy);

    if (this.options.evaluationIntervalMs > 0) {
      this.evaluationTimer = setInterval(() => this.evaluate(), this.options.evaluationIntervalMs);
      this.evaluationTimer.unref?.();
    }
  }

  // -------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------

  /**
   * Connects the engine to a live storage engine: subscribes to its
   * hit/miss/write events (to feed the WorkloadMonitor) and registers a
   * getter for current memory-usage ratio and a getter for current
   * entries (used to seed a freshly-switched-in policy). `storageEvents`
   * is typed as a bare `NodeJS.EventEmitter` rather than the concrete
   * `StorageEngine` class to avoid a circular package dependency.
   */
  attachStorage(
    storageEvents: NodeJS.EventEmitter,
    getMemoryUsageRatio: () => number,
    getCurrentEntries: () => readonly CacheEntry[],
  ): void {
    this.getMemoryUsageRatio = getMemoryUsageRatio;
    this.getCurrentEntries = getCurrentEntries;

    storageEvents.on('hit', (key: CacheKey) => this.monitor.recordHit(key));
    storageEvents.on('miss', (key: CacheKey) => this.monitor.recordMiss(key));
    storageEvents.on('write', (key: CacheKey) => this.monitor.recordWrite(key));
  }

  // -------------------------------------------------------------------
  // EvictionHook delegation — every call passes straight through to
  // whichever policy is currently active.
  // -------------------------------------------------------------------

  recordAccess(key: CacheKey): void {
    this.active.recordAccess(key);
  }

  recordWrite(key: CacheKey): void {
    this.active.recordWrite(key);
  }

  recordRemoval(key: CacheKey): void {
    this.active.recordRemoval(key);
  }

  selectVictim(candidateKeys: readonly CacheKey[]): CacheKey | null {
    return this.active.selectVictim(candidateKeys);
  }

  // -------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------

  getCurrentPolicy(): EvictionPolicyType {
    return this.active.type;
  }

  getSignals(): WorkloadSignals {
    return this.monitor.computeSignals(this.getMemoryUsageRatio());
  }

  getSwitchHistory(): readonly PolicySwitchEvent[] {
    return this.switchHistory;
  }

  /** Forces an immediate switch, bypassing the rule table and cooldown.
   *  Used by the benchmark engine to run controlled side-by-side policy
   *  comparisons, and by operators for manual overrides via the API. */
  forceSwitch(policy: EvictionPolicyType, reason = 'manual override via API'): void {
    const signals = this.monitor.computeSignals(this.getMemoryUsageRatio());
    this.switchTo(policy, reason, signals);
  }

  /** Stops the background evaluation loop from making further automatic
   *  switches — used to pin a specific policy (via `forceSwitch`) for
   *  controlled benchmark comparisons or manual operator overrides. */
  pauseAutoSwitch(): void {
    this.autoSwitchEnabled = false;
  }

  /** Resumes automatic policy switching after `pauseAutoSwitch()`. */
  resumeAutoSwitch(): void {
    this.autoSwitchEnabled = true;
  }

  isAutoSwitchEnabled(): boolean {
    return this.autoSwitchEnabled;
  }

  // -------------------------------------------------------------------
  // Evaluation loop
  // -------------------------------------------------------------------

  private evaluate(): void {
    if (!this.autoSwitchEnabled) {
      return;
    }

    const signals = this.monitor.computeSignals(this.getMemoryUsageRatio());

    if (signals.windowSampleCount < this.options.minSamplesBeforeSwitch) {
      return;
    }

    const decision = decidePolicy(signals);
    if (decision.policy === this.active.type) {
      return;
    }

    const now = Date.now();
    if (now - this.lastSwitchAt < this.options.cooldownMs) {
      return;
    }

    this.switchTo(decision.policy, decision.reason, signals);
  }

  private switchTo(policy: EvictionPolicyType, reason: string, signals: WorkloadSignals): void {
    if (policy === this.active.type) return;

    const fromPolicy = this.active.type;
    const next = createEvictionPolicy(policy);
    next.seed(this.getCurrentEntries());

    this.active = next;
    this.lastSwitchAt = Date.now();

    const event: PolicySwitchEvent = {
      timestamp: this.lastSwitchAt,
      fromPolicy,
      toPolicy: policy,
      reason,
      signals,
    };

    this.switchHistory.push(event);
    if (this.switchHistory.length > this.options.maxHistoryLength) {
      this.switchHistory.shift();
    }

    this.emit('policySwitch', event);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  dispose(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    this.removeAllListeners();
  }
}