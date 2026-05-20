/**
 * @typedef {object} LockHandle
 * @property {string} filePath - The locked file path
 * @property {Function} release - Call to release the lock
 */
declare class MutationQueue {
    constructor();
    /**
     * Acquire an exclusive lock on a file path.
     * If another worker holds the lock, this call blocks until it's released.
     *
  
  
     */
    acquire(filePath: any, workerId?: any): Promise<unknown>;
    /**
     * Release a lock on a file path.
     * If there are queued waiters, the next one is granted the lock.
     *
  
     */
    release(filePath: any): void;
    /**
     * Execute a function while holding a lock on the given file path.
     * The lock is automatically released after the function completes (or throws).
     *
  
  
     * @returns {Promise<*>} Result of fn()
     */
    withLock(filePath: any, fn: any, workerId?: any): Promise<any>;
    /**
     * Get the current lock status for debugging.
     * @returns {Array<{ filePath: string, holder: string|null, queueLength: number }>}
     */
    getStatus(): any[];
    /**
     * Force-release all locks. Use for cleanup on abort/shutdown.
     */
    releaseAll(): void;
}
declare const mutationQueue: MutationQueue;
export default mutationQueue;
export { MutationQueue };
//# sourceMappingURL=MutationQueue.d.ts.map