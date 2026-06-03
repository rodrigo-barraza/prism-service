/**
 * MutationQueue — tests for the per-path FIFO lock queue used by
 * CoordinatorService to prevent concurrent file writes from worker agents.
 *
 * If locking is broken, parallel workers can corrupt shared files
 * (package.json, configs). If release is broken, workers deadlock.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { MutationQueue } = await import("../src/services/MutationQueue.ts");

// ═══════════════════════════════════════════════════════════════
describe("MutationQueue.acquire / release", () => {
  it("should acquire a lock immediately when no one holds it", async () => {
    const queue = new MutationQueue();

    const handle = await queue.acquire("/package.json", "worker-1");

    expect(handle.filePath).toBe("/package.json");
    expect(typeof handle.release).toBe("function");

    handle.release();
  });

  it("should block second acquirer until first releases", async () => {
    const queue = new MutationQueue();
    const executionOrder: string[] = [];

    const handle1 = await queue.acquire("/package.json", "worker-1");
    executionOrder.push("worker-1-acquired");

    const acquirePromise2 = queue.acquire("/package.json", "worker-2");

    // worker-2 should be waiting
    let worker2Resolved = false;
    acquirePromise2.then(() => {
      worker2Resolved = true;
      executionOrder.push("worker-2-acquired");
    });

    // Give microtasks a chance to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(worker2Resolved).toBe(false);

    // Release worker-1 — worker-2 should now acquire
    handle1.release();
    const handle2 = await acquirePromise2;
    expect(worker2Resolved).toBe(true);

    executionOrder.push("worker-2-done");
    handle2.release();

    expect(executionOrder).toEqual([
      "worker-1-acquired",
      "worker-2-acquired",
      "worker-2-done",
    ]);
  });

  it("should allow concurrent locks on different paths", async () => {
    const queue = new MutationQueue();

    const handle1 = await queue.acquire("/file-a.ts", "worker-1");
    const handle2 = await queue.acquire("/file-b.ts", "worker-2");

    // Both should acquire immediately (different paths)
    expect(handle1.filePath).toBe("/file-a.ts");
    expect(handle2.filePath).toBe("/file-b.ts");

    handle1.release();
    handle2.release();
  });

  it("should clean up the lock entry when released with no waiters", async () => {
    const queue = new MutationQueue();

    const handle = await queue.acquire("/temp.ts", "worker-1");
    handle.release();

    const status = queue.getStatus();
    const tempEntry = status.find((entry) => entry.filePath === "/temp.ts");
    expect(tempEntry).toBeUndefined();
  });

  it("should process FIFO queue in order", async () => {
    const queue = new MutationQueue();
    const acquireOrder: string[] = [];

    const handle1 = await queue.acquire("/shared.json", "worker-1");

    const promise2 = queue.acquire("/shared.json", "worker-2");
    const promise3 = queue.acquire("/shared.json", "worker-3");

    promise2.then(() => acquireOrder.push("worker-2"));
    promise3.then(() => acquireOrder.push("worker-3"));

    handle1.release();
    const handle2 = await promise2;
    handle2.release();
    const handle3 = await promise3;
    handle3.release();

    expect(acquireOrder).toEqual(["worker-2", "worker-3"]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("MutationQueue.withLock", () => {
  it("should execute action under the lock and release automatically", async () => {
    const queue = new MutationQueue();

    const result = await queue.withLock(
      "/config.json",
      async () => {
        return "write-result";
      },
      "worker-1",
    );

    expect(result).toBe("write-result");
    // Lock should be released — status empty
    const status = queue.getStatus();
    expect(status.find((entry) => entry.filePath === "/config.json")).toBeUndefined();
  });

  it("should release the lock even when the action throws", async () => {
    const queue = new MutationQueue();

    await expect(
      queue.withLock(
        "/config.json",
        async () => {
          throw new Error("Write failed");
        },
        "worker-1",
      ),
    ).rejects.toThrow("Write failed");

    // Lock must be released despite the error
    const status = queue.getStatus();
    expect(status.find((entry) => entry.filePath === "/config.json")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("MutationQueue.getStatus", () => {
  it("should report holder and queue length for active locks", async () => {
    const queue = new MutationQueue();

    const handle = await queue.acquire("/package.json", "worker-a");
    queue.acquire("/package.json", "worker-b"); // queued, not resolved

    const status = queue.getStatus();
    const entry = status.find((statusEntry) => statusEntry.filePath === "/package.json");

    expect(entry).toBeDefined();
    expect(entry!.holder).toBe("worker-a");
    expect(entry!.queueLength).toBe(1);

    handle.release();
    // Let the queued worker acquire
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

// ═══════════════════════════════════════════════════════════════
describe("MutationQueue.releaseAll", () => {
  it("should clear all locks", async () => {
    const queue = new MutationQueue();

    await queue.acquire("/file-a.ts", "worker-1");
    await queue.acquire("/file-b.ts", "worker-2");

    queue.releaseAll();

    const status = queue.getStatus();
    expect(status).toHaveLength(0);
  });
});
