import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger to avoid spamming the console
vi.mock("../../utils/logger.ts", () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import AgentSessionRegistry from "../AgentSessionRegistry.ts";

describe("AgentSessionRegistry Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up active sessions before each test
    // activeSessions is private/local to the file, but we can call cleanup for test IDs
    AgentSessionRegistry.cleanup("test-session-1");
    AgentSessionRegistry.cleanup("test-session-2");
  });

  it("should register a new session and return an AbortController", () => {
    const controller = AgentSessionRegistry.register("test-session-1");
    expect(controller).toBeDefined();
    expect(controller.signal).toBeDefined();
    expect(controller.signal.aborted).toBe(false);
    expect(AgentSessionRegistry.isActive("test-session-1")).toBe(true);
    expect(AgentSessionRegistry.activeCount).toBe(1);
  });

  it("should abort existing session when registering a new session with the same conversationId", () => {
    const firstController = AgentSessionRegistry.register("test-session-1");
    expect(firstController.signal.aborted).toBe(false);

    const secondController = AgentSessionRegistry.register("test-session-1");
    expect(firstController.signal.aborted).toBe(true);
    expect(secondController.signal.aborted).toBe(false);
    expect(AgentSessionRegistry.isActive("test-session-1")).toBe(true);
    expect(AgentSessionRegistry.activeCount).toBe(1);
  });

  it("should stop an active session and return true", () => {
    const controller = AgentSessionRegistry.register("test-session-1");
    expect(controller.signal.aborted).toBe(false);

    const stopped = AgentSessionRegistry.stop("test-session-1");
    expect(stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(AgentSessionRegistry.isActive("test-session-1")).toBe(false);
  });

  it("should return false when stopping a non-existent session", () => {
    const stopped = AgentSessionRegistry.stop("non-existent-session");
    expect(stopped).toBe(false);
  });

  it("should return false for isActive if session was never registered", () => {
    expect(AgentSessionRegistry.isActive("unregistered-session")).toBe(false);
  });

  it("should cleanup a session successfully", () => {
    AgentSessionRegistry.register("test-session-1");
    expect(AgentSessionRegistry.isActive("test-session-1")).toBe(true);

    AgentSessionRegistry.cleanup("test-session-1");
    expect(AgentSessionRegistry.isActive("test-session-1")).toBe(false);
    expect(AgentSessionRegistry.activeCount).toBe(0);
  });

  it("should track the correct active count across multiple sessions", () => {
    expect(AgentSessionRegistry.activeCount).toBe(0);

    AgentSessionRegistry.register("test-session-1");
    expect(AgentSessionRegistry.activeCount).toBe(1);

    AgentSessionRegistry.register("test-session-2");
    expect(AgentSessionRegistry.activeCount).toBe(2);

    AgentSessionRegistry.cleanup("test-session-1");
    expect(AgentSessionRegistry.activeCount).toBe(1);

    AgentSessionRegistry.cleanup("test-session-2");
    expect(AgentSessionRegistry.activeCount).toBe(0);
  });
});
