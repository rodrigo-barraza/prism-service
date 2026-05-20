// ─── Per-Instance Counting Semaphore for Local GPU Models ───

import logger from "../utils/logger.ts";
import { getInstance, isInstance } from "../providers/instance-registry.ts";
import { LOCAL_PROVIDER_TYPES } from "./LocalProviderGateway.ts";

// Providers that hit the local GPU — sourced from LocalProviderGateway
const LOCAL_PROVIDERS = LOCAL_PROVIDER_TYPES;

/** @type {Map<string, InstanceQueue>} Per-instance semaphore queues */
const queues = new Map();

/** Default concurrency for instances not in the registry. */
const DEFAULT_CONCURRENCY = 1;

class InstanceQueue {
  instanceId: any;
  maxConcurrency: any;
  _queue: (() => void)[];
  _activeCount: number;
  _totalProcessed: number;

  constructor(instanceId: any, maxConcurrency: any) {
    this.instanceId = instanceId;
    this.maxConcurrency = maxConcurrency;
    this._queue = [];
    this._activeCount = 0;
    this._totalProcessed = 0;
  }

  acquire() {
    return new Promise((resolve: any) => {
      const release = () => {
        this._activeCount--;
        this._totalProcessed++;
        const next = this._queue.shift();
        if (next) {
          this._activeCount++;
          next();
        }
      };

      if (this._activeCount < this.maxConcurrency) {
        this._activeCount++;
        resolve(release);
      } else {
        this._queue.push(() => resolve(release));
        logger.info(
          `[LocalModelQueue:${this.instanceId}] Queued request (${this._queue.length} waiting, ${this._activeCount}/${this.maxConcurrency} active)`,
        );
      }
    });
  }

  get pending() {
    return this._queue.length;
  }
  get busy() {
    return this._activeCount >= this.maxConcurrency;
  }
  get activeCount() {
    return this._activeCount;
  }
  get totalProcessed() {
    return this._totalProcessed;
  }
}

class LocalModelQueue {
  constructor() {
    logger.info(
      `[LocalModelQueue] Initialized (default concurrency: ${DEFAULT_CONCURRENCY})`,
    );
  }

  /**
   * Check whether a provider requires the local GPU lock.
   * Checks both base provider types and instance IDs.


   */
  isLocal(provider: any) {
        if (LOCAL_PROVIDERS.has((provider as any))) return true;
    // Check if it's a multi-instance ID (e.g. "lm-studio-2")
        if (isInstance((provider as any))) return true;
    return false;
  }

  /**
   * Get or create the semaphore queue for an instance.


   */
  _getQueue(instanceId: any) {
    if (queues.has(instanceId)) return queues.get(instanceId);

    // Look up concurrency from instance registry
        const instance = getInstance((instanceId as any));
    const concurrency = instance?.concurrency || DEFAULT_CONCURRENCY;

        const queue = new InstanceQueue(instanceId, (concurrency as any));
    queues.set(instanceId, queue);
    logger.info(
      `[LocalModelQueue] Created queue for "${instanceId}" (concurrency: ${concurrency})`,
    );
    return queue;
  }

  /**
   * Acquire a semaphore slot for an instance. Resolves immediately if a
   * slot is available, otherwise enqueues and waits (FIFO order).
   *

   *   default queue (backward compat for callers that don't pass an ID).
   * @returns {Promise<() => void>} A release function — MUST be called
   *   when inference is complete (use try/finally).
   */
    acquire(instanceId: any = "_default") {
    return this._getQueue(instanceId).acquire();
  }

  /** Number of requests waiting for a specific instance. */
    pending(instanceId: any = "_default") {
    return queues.get(instanceId)?.pending || 0;
  }

  /** Whether all slots are in use for a specific instance. */
    busy(instanceId: any = "_default") {
    return queues.get(instanceId)?.busy || false;
  }

  /** Number of active slots for a specific instance. */
  get activeCount() {
    let total = 0;
        for ( const q of queues.values()) total += q.activeCount;
    return total;
  }

  /** Max concurrency for a specific instance (or default). */
    maxConcurrency(instanceId: any = "_default") {
    return queues.get(instanceId)?.maxConcurrency || DEFAULT_CONCURRENCY;
  }

  /** Total requests processed across all instances. */
  get totalProcessed() {
    let total = 0;
        for ( const q of queues.values()) total += q.totalProcessed;
    return total;
  }
}

// Singleton — one queue manager for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;
