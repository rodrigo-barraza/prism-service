import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebhookDispatcher, { matchesFilter, matchesEventTypes } from "#src/services/WebhookDispatcher";
import WebhookEventBus from "#src/services/WebhookEventBus";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import type { WebhookEvent } from "#src/services/WebhookEventBus";

describe("WebhookDispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await WebhookDispatcher.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("matchesFilter", () => {
    const event: WebhookEvent = {
      webhookEventId: "evt-123",
      eventType: "chat.message",
      webhookTimestamp: "2026-06-20T11:30:46Z",
      data: {
        agentId: "agent-omni",
        status: "success",
        ignoredKey: ""
      }
    };

    it("should return true when all filter keys match", () => {
      const filter = { agentId: "agent-omni", status: "success" };
      expect(matchesFilter(event, filter)).toBe(true);
    });

    it("should return false when at least one filter key does not match", () => {
      const filter = { agentId: "agent-omni", status: "failed" };
      expect(matchesFilter(event, filter)).toBe(false);
    });

    it("should return true for empty filter", () => {
      expect(matchesFilter(event, {})).toBe(true);
    });

    it("should ignore empty string filter values", () => {
      const filter = { agentId: "agent-omni", status: "" };
      expect(matchesFilter(event, filter)).toBe(true);
    });

    it("should return false when event is missing the filter key", () => {
      const filter = { missingKey: "some-value" };
      expect(matchesFilter(event, filter)).toBe(false);
    });
  });

  describe("matchesEventTypes", () => {
    it("should return true for wildcard subscription", () => {
      expect(matchesEventTypes("chat.message", ["*"])).toBe(true);
    });

    it("should return true when exact event type matches subscription list", () => {
      expect(matchesEventTypes("chat.message", ["chat.message", "audio.synthesize"])).toBe(true);
    });

    it("should return false when exact event type is not in subscription list", () => {
      expect(matchesEventTypes("chat.message", ["audio.synthesize"])).toBe(false);
    });

    it("should return false for empty subscription list", () => {
      expect(matchesEventTypes("chat.message", [])).toBe(false);
    });
  });

  describe("WebhookDispatcher Lifecycle and Dispatch", () => {
    const mockSubscriptions = [
      {
        id: "sub-1",
        url: "http://webhook-target.dev/endpoint",
        secret: "my-secret",
        events: ["chat.message"],
        filter: { agentId: "agent-omni" },
        enabled: true
      }
    ];

    it("should initialize, load subscriptions from MongoDB, and process events", async () => {
      const toArrayMock = vi.fn().mockResolvedValue(mockSubscriptions);
      const findMock = vi.fn().mockReturnValue({ toArray: toArrayMock });
      const collectionMock = vi.fn().mockReturnValue({ find: findMock });
      const databaseMock = { collection: collectionMock };

      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        status: 200
      } as any);

      // Initialize
      await WebhookDispatcher.init();
      expect(WebhookDispatcher.activeSubscriptionCount).toBe(1);

      // Trigger Webhook Event through Event Bus
      WebhookEventBus.emit("chat.message", { agentId: "agent-omni" });

      // Resolve async calls
      await vi.advanceTimersByTimeAsync(20000);

      // Check if fetch was called with correct headers
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe("http://webhook-target.dev/endpoint");
      expect(calledOptions?.method).toBe("POST");
      expect(calledOptions?.headers).toMatchObject({
        "Content-Type": "application/json",
        "X-Webhook-Event": "chat.message"
      });
      // Verify signature header and ID header exist
      expect(calledOptions?.headers).toHaveProperty("X-Webhook-Signature");
      expect(calledOptions?.headers).toHaveProperty("X-Webhook-Id");
    });

    it("should retry on failure and eventually log error if all attempts fail", async () => {
      const toArrayMock = vi.fn().mockResolvedValue(mockSubscriptions);
      const findMock = vi.fn().mockReturnValue({ toArray: toArrayMock });
      const collectionMock = vi.fn().mockReturnValue({ find: findMock });
      const databaseMock = { collection: collectionMock };

      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network error"));

      await WebhookDispatcher.init();

      WebhookEventBus.emit("chat.message", { agentId: "agent-omni" });

      // Run timers step by step to simulate retries
      await vi.advanceTimersByTimeAsync(20000);

      // 3 attempts max
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("should recover from partial failures on retry", async () => {
      const toArrayMock = vi.fn().mockResolvedValue(mockSubscriptions);
      const findMock = vi.fn().mockReturnValue({ toArray: toArrayMock });
      const collectionMock = vi.fn().mockReturnValue({ find: findMock });
      const databaseMock = { collection: collectionMock };

      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      const fetchSpy = vi.spyOn(global, "fetch")
        .mockRejectedValueOnce(new Error("Failure 1"))
        .mockResolvedValueOnce({ ok: true, status: 200 } as any);

      await WebhookDispatcher.init();

      WebhookEventBus.emit("chat.message", { agentId: "agent-omni" });

      await vi.advanceTimersByTimeAsync(20000);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("should clear cached subscriptions and unsubscribe on destroy", async () => {
      const toArrayMock = vi.fn().mockResolvedValue(mockSubscriptions);
      const findMock = vi.fn().mockReturnValue({ toArray: toArrayMock });
      const collectionMock = vi.fn().mockReturnValue({ find: findMock });
      const databaseMock = { collection: collectionMock };

      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      await WebhookDispatcher.init();
      expect(WebhookDispatcher.activeSubscriptionCount).toBe(1);

      await WebhookDispatcher.destroy();
      expect(WebhookDispatcher.activeSubscriptionCount).toBe(0);
    });
  });
});
