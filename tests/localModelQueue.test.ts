import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

// Mock dependencies
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/providers/instance-registry.ts", () => ({
  getInstance: vi.fn((instanceId: string) => {
    if (instanceId === "concurrency-five-instance") {
      return { concurrency: 5 };
    }
    if (instanceId === "concurrency-two-instance") {
      return { concurrency: 2 };
    }
    return null;
  }),
  isInstance: vi.fn((instanceId: string) => {
    return instanceId.startsWith("lm-studio-") || instanceId.includes("-instance");
  }),
}));

import localModelQueue from "../src/services/LocalModelQueue.ts";

describe("LocalModelQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isLocal", () => {
    it("should return true for base local provider types", () => {
      expect(localModelQueue.isLocal(PROVIDERS.LM_STUDIO)).toBe(true);
      expect(localModelQueue.isLocal(PROVIDERS.OLLAMA)).toBe(true);
      expect(localModelQueue.isLocal(PROVIDERS.VLLM)).toBe(true);
    });

    it("should return true for registered instance IDs", () => {
      expect(localModelQueue.isLocal("lm-studio-2")).toBe(true);
      expect(localModelQueue.isLocal("custom-instance")).toBe(true);
    });

    it("should return false for non-local providers", () => {
      expect(localModelQueue.isLocal(PROVIDERS.OPENAI)).toBe(false);
      expect(localModelQueue.isLocal(PROVIDERS.ANTHROPIC)).toBe(false);
    });
  });

  describe("acquire & release mechanics", () => {
    it("should resolve immediately when active request count is below concurrency limit", async () => {
      const releaseLock = await localModelQueue.acquire("concurrency-five-instance");
      expect(localModelQueue.busy("concurrency-five-instance")).toBe(false);
      expect(localModelQueue.pending("concurrency-five-instance")).toBe(0);
      
      releaseLock();
      expect(localModelQueue.busy("concurrency-five-instance")).toBe(false);
    });

    it("should queue subsequent requests when active count reaches concurrency limit", async () => {
      const instanceId = "concurrency-two-instance";
      
      // Acquire slot 1
      const releaseSlotOne = await localModelQueue.acquire(instanceId);
      expect(localModelQueue.busy(instanceId)).toBe(false);
      expect(localModelQueue.pending(instanceId)).toBe(0);

      // Acquire slot 2
      const releaseSlotTwo = await localModelQueue.acquire(instanceId);
      // Concurrency limit is 2 (mocked), so now it is busy
      expect(localModelQueue.busy(instanceId)).toBe(true);
      expect(localModelQueue.pending(instanceId)).toBe(0);

      // Try to acquire slot 3 (should block and go to queue)
      let isSlotThreeResolved = false;
      const slotThreePromise = localModelQueue.acquire(instanceId).then((release) => {
        isSlotThreeResolved = true;
        return release;
      });

      // Allow microtasks to run
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(isSlotThreeResolved).toBe(false);
      expect(localModelQueue.pending(instanceId)).toBe(1);

      // Release slot 1 to resolve slot 3
      releaseSlotOne();
      
      const releaseSlotThree = await slotThreePromise;
      expect(isSlotThreeResolved).toBe(true);
      expect(localModelQueue.pending(instanceId)).toBe(0);

      // Clean up other slots
      releaseSlotTwo();
      releaseSlotThree();
    });

    it("should execute queued requests in FIFO order", async () => {
      const instanceId = "concurrency-one-instance"; // defaults to concurrency 1
      
      const releaseSlotOne = await localModelQueue.acquire(instanceId);
      
      const resolutionOrder: string[] = [];
      const promiseA = localModelQueue.acquire(instanceId).then((release) => {
        resolutionOrder.push("A");
        return release;
      });
      const promiseB = localModelQueue.acquire(instanceId).then((release) => {
        resolutionOrder.push("B");
        return release;
      });

      // Release slot 1, should resolve A first
      releaseSlotOne();
      const releaseSlotA = await promiseA;
      
      // Release A, should resolve B
      releaseSlotA();
      const releaseSlotB = await promiseB;

      expect(resolutionOrder).toEqual(["A", "B"]);
      
      releaseSlotB();
    });
  });

  describe("activeCount and totalProcessed metrics", () => {
    it("should track processed request totals and active concurrency numbers", async () => {
      const instanceA = "metric-instance-a";
      const instanceB = "metric-instance-b";
      
      const initialProcessed = localModelQueue.totalProcessed;
      
      const releaseA = await localModelQueue.acquire(instanceA);
      const releaseB = await localModelQueue.acquire(instanceB);
      
      expect(localModelQueue.activeCount).toBeGreaterThanOrEqual(2);
      
      releaseA();
      releaseB();
      
      expect(localModelQueue.totalProcessed).toBe(initialProcessed + 2);
    });
  });
});
