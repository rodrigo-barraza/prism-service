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
  constructor(instanceId: Record<string, unknown>, maxConcurrency: Record<string, unknown>) {
    // @ts-ignore
    this.instanceId = instanceId;
    // @ts-ignore
    this.maxConcurrency = maxConcurrency;
    /** @type {Array<() => void>} FIFO queue of pending resolve callbacks */
    // @ts-ignore
    this._queue = [];
    // @ts-ignore
    this._activeCount = 0;
    // @ts-ignore
    this._totalProcessed = 0;
  }

  acquire() {
    // @ts-ignore - TODO: strict typing
    return new Promise((resolve: Record<string, unknown>) => {
      const release = () => {
        // @ts-ignore
        this._activeCount--;
        // @ts-ignore
        this._totalProcessed++;
        // @ts-ignore
        const next = this._queue.shift();
        if (next) {
          // @ts-ignore
          this._activeCount++;
          next();
        }
      };

      // @ts-ignore
      if (this._activeCount < this.maxConcurrency) {
        // @ts-ignore
        this._activeCount++;
        // @ts-ignore - TODO: strict typing
        resolve(release);
      } else {
        // @ts-ignore
        this._queue.push(() => resolve(release));
        logger.info(
          // @ts-ignore
          `[LocalModelQueue:${this.instanceId}] Queued request (${this._queue.length} waiting, ${this._activeCount}/${this.maxConcurrency} active)`,
        );
      }
    });
  }

  // @ts-ignore
  get pending() {
    // @ts-ignore
    return this._queue.length;
  }
  // @ts-ignore
  get busy() {
    // @ts-ignore
    return this._activeCount >= this.maxConcurrency;
  }
  // @ts-ignore
  get activeCount() {
    // @ts-ignore
    return this._activeCount;
  }
  // @ts-ignore
  get totalProcessed() {
    // @ts-ignore
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
  isLocal(provider: Record<string, unknown>) {
    // @ts-ignore - TODO: strict typing
    if (LOCAL_PROVIDERS.has(provider)) return true;
    // Check if it's a multi-instance ID (e.g. "lm-studio-2")
    // @ts-ignore - TODO: strict typing
    if (isInstance(provider)) return true;
    return false;
  }

  /**
   * Get or create the semaphore queue for an instance.


   */
  _getQueue(instanceId: Record<string, unknown>) {
    if (queues.has(instanceId)) return queues.get(instanceId);

    // Look up concurrency from instance registry
    // @ts-ignore - TODO: strict typing
    const instance = getInstance(instanceId);
    const concurrency = instance?.concurrency || DEFAULT_CONCURRENCY;

    // @ts-ignore - TODO: strict typing
    const queue = new InstanceQueue(instanceId, concurrency);
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
  // @ts-ignore - TODO: strict typing
  acquire(instanceId: Record<string, unknown> = "_default") {
    return this._getQueue(instanceId).acquire();
  }

  /** Number of requests waiting for a specific instance. */
  // @ts-ignore - TODO: strict typing
  pending(instanceId: Record<string, unknown> = "_default") {
    return queues.get(instanceId)?.pending || 0;
  }

  /** Whether all slots are in use for a specific instance. */
  // @ts-ignore - TODO: strict typing
  busy(instanceId: Record<string, unknown> = "_default") {
    return queues.get(instanceId)?.busy || false;
  }

  /** Number of active slots for a specific instance. */
  get activeCount() {
    let total = 0;
    // @ts-ignore
    for ( const q of queues.values()) total += q.activeCount;
    return total;
  }

  /** Max concurrency for a specific instance (or default). */
  // @ts-ignore - TODO: strict typing
  maxConcurrency(instanceId: Record<string, unknown> = "_default") {
    return queues.get(instanceId)?.maxConcurrency || DEFAULT_CONCURRENCY;
  }

  /** Total requests processed across all instances. */
  get totalProcessed() {
    let total = 0;
    // @ts-ignore
    for ( const q of queues.values()) total += q.totalProcessed;
    return total;
  }
}

// Singleton — one queue manager for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;
