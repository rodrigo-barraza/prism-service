import { describe, it, expect } from "vitest";
import { matchesFilter, matchesEventTypes } from "../WebhookDispatcher.ts";
import type { WebhookEvent } from "../WebhookEventBus.ts";

describe("WebhookDispatcher Filtering", () => {
  describe("matchesFilter", () => {
    const mockEvent = {
      eventType: "test.event",
      data: {
        project: "test-project",
        username: "test-user",
        other: "value",
      },
    } as unknown as WebhookEvent;

    it("returns true when all filter keys match", () => {
      const filter = { project: "test-project", username: "test-user" };
      expect(matchesFilter(mockEvent, filter)).toBe(true);
    });

    it("returns false when any filter key does not match", () => {
      const filter = { project: "wrong-project", username: "test-user" };
      expect(matchesFilter(mockEvent, filter)).toBe(false);
    });

    it("returns true for empty filter", () => {
      expect(matchesFilter(mockEvent, {})).toBe(true);
    });

    it("ignores null or empty string values in filter", () => {
      const filter = { project: "test-project", username: "" };
      expect(matchesFilter(mockEvent, filter)).toBe(true);
    });
  });

  describe("matchesEventTypes", () => {
    it("returns true when event type is in the list", () => {
      expect(matchesEventTypes("agent.started", ["agent.started", "agent.stopped"])).toBe(true);
    });

    it("returns true for wildcard *", () => {
      expect(matchesEventTypes("any.event", ["*"])).toBe(true);
    });

    it("returns false when event type is not in the list", () => {
      expect(matchesEventTypes("agent.error", ["agent.started", "agent.stopped"])).toBe(false);
    });
  });
});
