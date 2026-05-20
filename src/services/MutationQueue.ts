import logger from "../utils/logger.ts";

// ────────────────────────────────────────────────────────────
// MutationQueue — File-Write Serialization for Coordinator Mode
// ────────────────────────────────────────────────────────────
// Prevents concurrent agent workers from writing to the same
// file simultaneously. Uses per-path FIFO queues with async
// lock semantics.
//
// In practice, workers operate in isolated git worktrees, so
// contention is rare. This is a safety net for shared files
// (e.g., package.json, config files) that might be accessed
// from the main repo during execution.
// ────────────────────────────────────────────────────────────

/**
 * @property {string} filePath - The locked file path
 * @property {Function} release - Call to release the lock
 */

interface LockHandle {
  filePath: string;
  release: () => void;
}

class MutationQueue {
  private _locks: Map<
    string,
    { queue: Array<() => void>; holder: string | null }
  >;

  constructor() {
    this._locks = new Map();
  }

  /**
   * Acquire an exclusive lock on a file path.
   * If another worker holds the lock, this call blocks until it's released.
   */
  async acquire(filePath: string, workerId: string = "any"): Promise<LockHandle> {
    if (!this._locks.has(filePath)) {
      this._locks.set(filePath, { queue: [], holder: null });
    }

    const lock = this._locks.get(filePath)!;

    // If no one holds the lock, acquire immediately
    if (!lock.holder) {
      lock.holder = workerId;
      logger.info(
        `[MutationQueue] Lock acquired: ${filePath} (worker: ${workerId})`,
      );
      return {
        filePath,
        release: () => this.release(filePath),
      };
    }

    // Otherwise, enqueue and wait
    logger.info(
      `[MutationQueue] Waiting for lock: ${filePath} (worker: ${workerId}, held by: ${lock.holder})`,
    );

    return new Promise<LockHandle>((resolve) => {
      lock.queue.push(() => {
        lock.holder = workerId;
        logger.info(
          `[MutationQueue] Lock acquired (from queue): ${filePath} (worker: ${workerId})`,
        );
        resolve({
          filePath,
          release: () => this.release(filePath),
        });
      });
    });
  }

  /**
   * Release a lock on a file path.
   * If there are queued waiters, the next one is granted the lock.
   */
  release(filePath: string): void {
    const lock = this._locks.get(filePath);
    if (!lock) return;

    const previousHolder = lock.holder;
    lock.holder = null;

    if (lock.queue.length > 0) {
      // Grant lock to next waiter
      const next = lock.queue.shift();
      if (next) next();
    } else {
      // No waiters — clean up the entry
      this._locks.delete(filePath);
    }

    logger.info(
      `[MutationQueue] Lock released: ${filePath} (was: ${previousHolder})`,
    );
  }

  /**
   * Execute a function while holding a lock on the given file path.
   * The lock is automatically released after the function completes (or throws).
   */
  async withLock<T>(
    filePath: string,
    fn: () => Promise<T> | T,
    workerId: string = "any",
  ): Promise<T> {
    const handle = await this.acquire(filePath, workerId);
    try {
      return await fn();
    } finally {
      handle.release();
    }
  }

  /**
   * Get the current lock status for debugging.
   */
  getStatus() {
    const entries: Array<{
      filePath: string;
      holder: string | null;
      queueLength: number;
    }> = [];
    for (const [filePath, lock] of this._locks) {
      entries.push({
        filePath,
        holder: lock.holder,
        queueLength: lock.queue.length,
      });
    }
    return entries;
  }

  /**
   * Force-release all locks. Use for cleanup on abort/shutdown.
   */
  releaseAll(): void {
    for (const [filePath] of this._locks) {
      this.release(filePath);
    }
    this._locks.clear();
    logger.info("[MutationQueue] All locks released");
  }
}

// Singleton instance
const mutationQueue = new MutationQueue();

export default mutationQueue;
export { MutationQueue };
