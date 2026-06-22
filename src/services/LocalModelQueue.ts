// ─── Per-Instance Counting Semaphore for Local GPU Models ───

import logger from "../utils/logger.ts";
import { getInstance, isInstance } from "../providers/instance-registry.ts";
import { LOCAL_PROVIDER_TYPES } from "./local-provider/constants.ts";

// Providers that hit the local GPU — sourced from LocalProviderGateway
const LOCAL_PROVIDERS = LOCAL_PROVIDER_TYPES;

/** Per-instance semaphore queues */
const queues = new Map<string, InstanceQueue>();

/** Default concurrency for instances not in the registry. */
const DEFAULT_CONCURRENCY = 1;

class InstanceQueue {
  instanceId: string;
  maxConcurrency: number;
  _queue: (() => void)[];
  _activeCount: number;
  _totalProcessed: number;

  constructor(instanceId: string, maxConcurrency: number) {
    this.instanceId = instanceId;
    this.maxConcurrency = maxConcurrency;
    this._queue = [];
    this._activeCount = 0;
    this._totalProcessed = 0;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
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

  get pending(): number {
    return this._queue.length;
  }
  get busy(): boolean {
    return this._activeCount >= this.maxConcurrency;
  }
  get activeCount(): number {
    return this._activeCount;
  }
  get totalProcessed(): number {
    return this._totalProcessed;
  }
  get totalInflight(): number {
    return this._activeCount + this._queue.length;
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
  isLocal(provider: string): boolean {
    if (LOCAL_PROVIDERS.has(provider as any)) return true;
    // Check if it's a multi-instance ID (e.g. "lm-studio-2")
    if (isInstance(provider)) return true;
    return false;
  }
  _getQueue(instanceId: string): InstanceQueue {
    const existing = queues.get(instanceId);
    if (existing) return existing;

    // Look up concurrency from instance registry
    const instance = getInstance(instanceId);
    const concurrency = instance?.concurrency || DEFAULT_CONCURRENCY;

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
   */
  acquire(instanceId: string = "_default"): Promise<() => void> {
    return this._getQueue(instanceId).acquire();
  }

  /** Number of requests waiting for a specific instance. */
  pending(instanceId: string = "_default"): number {
    return queues.get(instanceId)?.pending || 0;
  }

  /** Whether all slots are in use for a specific instance. */
  busy(instanceId: string = "_default"): boolean {
    return queues.get(instanceId)?.busy || false;
  }

  /** Number of active slots for a specific instance. */
  get activeCount(): number {
    let total = 0;
    for (const queue of queues.values()) total += queue.activeCount;
    return total;
  }

  /** Max concurrency for a specific instance (or default). */
  maxConcurrency(instanceId: string = "_default"): number {
    return queues.get(instanceId)?.maxConcurrency || DEFAULT_CONCURRENCY;
  }

  /** Total requests processed across all instances. */
  get totalProcessed(): number {
    let total = 0;
    for (const queue of queues.values()) total += queue.totalProcessed;
    return total;
  }
}

// Singleton — one queue manager for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;
