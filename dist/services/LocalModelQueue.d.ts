declare class LocalModelQueue {
    constructor();
    /**
     * Check whether a provider requires the local GPU lock.
     * Checks both base provider types and instance IDs.
  
  
     */
    isLocal(provider: Record<string, unknown>): boolean;
    /**
     * Get or create the semaphore queue for an instance.
  
  
     */
    _getQueue(instanceId: Record<string, unknown>): any;
    /**
     * Acquire a semaphore slot for an instance. Resolves immediately if a
     * slot is available, otherwise enqueues and waits (FIFO order).
     *
  
     *   default queue (backward compat for callers that don't pass an ID).
     * @returns {Promise<() => void>} A release function — MUST be called
     *   when inference is complete (use try/finally).
     */
    acquire(instanceId?: Record<string, unknown>): any;
    /** Number of requests waiting for a specific instance. */
    pending(instanceId?: Record<string, unknown>): any;
    /** Whether all slots are in use for a specific instance. */
    busy(instanceId?: Record<string, unknown>): any;
    /** Number of active slots for a specific instance. */
    get activeCount(): number;
    /** Max concurrency for a specific instance (or default). */
    maxConcurrency(instanceId?: Record<string, unknown>): any;
    /** Total requests processed across all instances. */
    get totalProcessed(): number;
}
declare const localModelQueue: LocalModelQueue;
export default localModelQueue;
//# sourceMappingURL=LocalModelQueue.d.ts.map