import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebhookEvent } from "../src/services/WebhookEventBus.ts";
import { PROVIDERS } from "../src/constants.ts";

// ═══════════════════════════════════════════════════════════════
//  WebhookEventBus — unit tests
// ═══════════════════════════════════════════════════════════════

const { default: WebhookEventBus } = await import(
  "../src/services/WebhookEventBus.ts"
);

describe("WebhookEventBus — pub/sub lifecycle", () => {
  let receivedEvents: WebhookEvent[] = [];
  const listener = (event: WebhookEvent) => {
    receivedEvents.push(event);
  };

  beforeEach(() => {
    receivedEvents = [];
    WebhookEventBus.unsubscribe(listener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(listener);
  });

  it("should emit events to subscribed listeners", () => {
    WebhookEventBus.subscribe(listener);

    WebhookEventBus.emit("test.event", { key: "value" });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe("test.event");
    expect(receivedEvents[0].data).toEqual({ key: "value" });
  });

  it("should include webhookEventId and webhookTimestamp in every event", () => {
    WebhookEventBus.subscribe(listener);

    WebhookEventBus.emit("test.event", { payload: true });

    const event = receivedEvents[0];
    expect(event.webhookEventId).toBeDefined();
    expect(typeof event.webhookEventId).toBe("string");
    expect(event.webhookTimestamp).toBeDefined();
    expect(typeof event.webhookTimestamp).toBe("string");
    expect(new Date(event.webhookTimestamp).toISOString()).toBe(
      event.webhookTimestamp,
    );
  });

  it("should generate unique webhookEventId for each event", () => {
    WebhookEventBus.subscribe(listener);

    WebhookEventBus.emit("event.a", {});
    WebhookEventBus.emit("event.b", {});

    expect(receivedEvents[0].webhookEventId).not.toBe(
      receivedEvents[1].webhookEventId,
    );
  });

  it("should not emit to listeners after unsubscribe", () => {
    WebhookEventBus.subscribe(listener);
    WebhookEventBus.unsubscribe(listener);

    WebhookEventBus.emit("test.event", {});

    expect(receivedEvents).toHaveLength(0);
  });

  it("should support multiple concurrent listeners", () => {
    const secondReceivedEvents: WebhookEvent[] = [];
    const secondListener = (event: WebhookEvent) => {
      secondReceivedEvents.push(event);
    };

    WebhookEventBus.subscribe(listener);
    WebhookEventBus.subscribe(secondListener);

    WebhookEventBus.emit("multi.event", { data: "shared" });

    expect(receivedEvents).toHaveLength(1);
    expect(secondReceivedEvents).toHaveLength(1);
    expect(receivedEvents[0].webhookEventId).toBe(
      secondReceivedEvents[0].webhookEventId,
    );

    WebhookEventBus.unsubscribe(secondListener);
  });

  it("should not throw when a listener throws an error", () => {
    const brokenListener = () => {
      throw new Error("Listener exploded");
    };

    WebhookEventBus.subscribe(brokenListener);
    WebhookEventBus.subscribe(listener);

    expect(() => WebhookEventBus.emit("error.test", {})).not.toThrow();

    expect(receivedEvents).toHaveLength(1);

    WebhookEventBus.unsubscribe(brokenListener);
  });

  it("should report correct listenerCount", () => {
    const initialCount = WebhookEventBus.listenerCount;

    WebhookEventBus.subscribe(listener);
    expect(WebhookEventBus.listenerCount).toBe(initialCount + 1);

    WebhookEventBus.unsubscribe(listener);
    expect(WebhookEventBus.listenerCount).toBe(initialCount);
  });

  it("should be a no-op when unsubscribing an unregistered listener", () => {
    const unregisteredListener = () => {};

    expect(() =>
      WebhookEventBus.unsubscribe(unregisteredListener),
    ).not.toThrow();
  });

  it("should not double-subscribe the same listener reference", () => {
    WebhookEventBus.subscribe(listener);
    WebhookEventBus.subscribe(listener);

    WebhookEventBus.emit("dedup.test", {});

    expect(receivedEvents).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookEventBus — replay buffer
// ═══════════════════════════════════════════════════════════════

describe("WebhookEventBus — replay buffer", () => {
  it("should store events in the replay buffer", () => {
    WebhookEventBus.emit("buffer.test", { sequence: 1 });
    WebhookEventBus.emit("buffer.test", { sequence: 2 });

    const buffer = WebhookEventBus.getReplayBuffer();

    expect(buffer.length).toBeGreaterThanOrEqual(2);
    const lastTwoEvents = buffer.slice(-2);
    expect(lastTwoEvents[0].data).toEqual({ sequence: 1 });
    expect(lastTwoEvents[1].data).toEqual({ sequence: 2 });
  });

  it("should filter replay buffer by 'since' timestamp", () => {
    const oneSecondAgo = new Date(Date.now() - 1000).toISOString();

    WebhookEventBus.emit("since.test", { afterSince: true });

    const filtered = WebhookEventBus.getReplayBuffer(oneSecondAgo);

    expect(filtered.length).toBeGreaterThanOrEqual(1);
    const relevantEvent = filtered.find(
      (event) =>
        event.eventType === "since.test" &&
        event.data.afterSince === true,
    );
    expect(relevantEvent).toBeDefined();
  });

  it("should return an empty array when 'since' is in the future", () => {
    const futureTimestamp = new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString();

    const filtered = WebhookEventBus.getReplayBuffer(futureTimestamp);

    expect(filtered).toHaveLength(0);
  });

  it("should return a copy of the buffer (not a reference)", () => {
    WebhookEventBus.emit("copy.test", {});
    const bufferA = WebhookEventBus.getReplayBuffer();
    const bufferB = WebhookEventBus.getReplayBuffer();

    expect(bufferA).not.toBe(bufferB);
  });
});

// ═══════════════════════════════════════════════════════════════
//  ActiveGenerationTracker — webhook event integration
// ═══════════════════════════════════════════════════════════════

const { default: ActiveGenerationTracker } = await import(
  "../src/services/ActiveGenerationTracker.ts"
);

describe("ActiveGenerationTracker — webhook events", () => {
  let capturedEvents: WebhookEvent[] = [];
  const captureListener = (event: WebhookEvent) => {
    capturedEvents.push(event);
  };

  beforeEach(() => {
    capturedEvents = [];
    WebhookEventBus.subscribe(captureListener);
    while (ActiveGenerationTracker.count > 0) {
      ActiveGenerationTracker.decrement();
    }
    capturedEvents = [];
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(captureListener);
    while (ActiveGenerationTracker.count > 0) {
      ActiveGenerationTracker.decrement();
    }
  });

  it("should emit generation.started on increment", () => {
    ActiveGenerationTracker.increment();

    const startedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.started",
    );
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].data.activeCount).toBe(1);
  });

  it("should emit generation.completed on decrement", () => {
    ActiveGenerationTracker.increment();
    capturedEvents = [];

    ActiveGenerationTracker.decrement();

    const completedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.completed",
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data.activeCount).toBe(0);
  });

  it("should include metadata in generation.started when provided", () => {
    ActiveGenerationTracker.increment({
      agent: "meepo",
      model: "claude-sonnet-4-20250514",
      provider: PROVIDERS.ANTHROPIC,
      conversationId: "conv-123",
    });

    const startedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.started",
    );
    const eventData = startedEvents[0].data;

    expect(eventData.agent).toBe("meepo");
    expect(eventData.model).toBe("claude-sonnet-4-20250514");
    expect(eventData.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(eventData.conversationId).toBe("conv-123");
  });

  it("should emit generation.started without metadata when none is provided", () => {
    ActiveGenerationTracker.increment();

    const startedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.started",
    );

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].data.activeCount).toBe(1);
  });

  it("should track sequential increment/decrement cycles correctly", () => {
    ActiveGenerationTracker.increment();
    ActiveGenerationTracker.increment();
    ActiveGenerationTracker.decrement();
    ActiveGenerationTracker.increment();

    const startedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.started",
    );
    const completedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.completed",
    );

    expect(startedEvents).toHaveLength(3);
    expect(completedEvents).toHaveLength(1);

    expect(ActiveGenerationTracker.count).toBe(2);
  });

  it("should floor active count at 0 on extra decrements", () => {
    ActiveGenerationTracker.decrement();

    const completedEvents = capturedEvents.filter(
      (event) => event.eventType === "generation.completed",
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data.activeCount).toBe(0);
    expect(ActiveGenerationTracker.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookEventBus — event type filtering (used by SSE route)
// ═══════════════════════════════════════════════════════════════

describe("WebhookEventBus — event type contract", () => {
  let capturedEvents: WebhookEvent[] = [];
  const captureListener = (event: WebhookEvent) => {
    capturedEvents.push(event);
  };

  beforeEach(() => {
    capturedEvents = [];
    WebhookEventBus.subscribe(captureListener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(captureListener);
  });

  it("should propagate request.created event type", () => {
    WebhookEventBus.emit("request.created", {
      requestId: "req-001",
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-sonnet-4-20250514",
      agent: "meepo",
      estimatedCost: 0.0234,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].eventType).toBe("request.created");
    expect(capturedEvents[0].data.requestId).toBe("req-001");
    expect(capturedEvents[0].data.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(capturedEvents[0].data.agent).toBe("meepo");
    expect(capturedEvents[0].data.estimatedCost).toBe(0.0234);
  });

  it("should propagate request.tool_call.started event type", () => {
    WebhookEventBus.emit("request.tool_call.started", {
      requestId: "req-002",
      toolName: "web_search",
      toolCallId: "tc-001",
      toolArgs: { query: "typescript generics" },
      agent: "meepo",
      iteration: 1,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].eventType).toBe("request.tool_call.started");
    expect(capturedEvents[0].data.toolName).toBe("web_search");
    expect(capturedEvents[0].data.toolCallId).toBe("tc-001");
    expect(capturedEvents[0].data.iteration).toBe(1);
  });

  it("should propagate request.tool_call.completed event type", () => {
    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: "req-003",
      toolName: "execute_code",
      toolCallId: "tc-002",
      durationMs: 1500,
      status: "done",
      toolResult: { output: "Hello world" },
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].eventType).toBe("request.tool_call.completed");
    expect(capturedEvents[0].data.durationMs).toBe(1500);
    expect(capturedEvents[0].data.status).toBe("done");
  });

  it("should propagate request.tool_call.completed with error status", () => {
    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: "req-004",
      toolName: "read_file",
      toolCallId: "tc-003",
      durationMs: 50,
      status: "error",
      toolResult: { error: "File not found" },
    });

    expect(capturedEvents[0].data.status).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookEventBus — fan-out ordering
// ═══════════════════════════════════════════════════════════════

describe("WebhookEventBus — fan-out ordering", () => {
  it("should deliver events in the order they were emitted", () => {
    const receivedOrder: number[] = [];
    const orderListener = (event: WebhookEvent) => {
      receivedOrder.push(event.data.sequence as number);
    };

    WebhookEventBus.subscribe(orderListener);

    for (let index = 0; index < 10; index++) {
      WebhookEventBus.emit("order.test", { sequence: index });
    }

    expect(receivedOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    WebhookEventBus.unsubscribe(orderListener);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookEventBus — zero overhead when no listeners
// ═══════════════════════════════════════════════════════════════

describe("WebhookEventBus — zero overhead", () => {
  it("should not throw when emitting with no listeners", () => {
    expect(() => {
      WebhookEventBus.emit("no.listeners", { silent: true });
    }).not.toThrow();
  });

  it("should still buffer events even with no listeners", () => {
    const preBufferLength = WebhookEventBus.getReplayBuffer().length;

    WebhookEventBus.emit("buffered.only", { sequence: 1 });

    const postBufferLength = WebhookEventBus.getReplayBuffer().length;
    expect(postBufferLength).toBe(preBufferLength + 1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookDispatcher — HMAC signing
// ═══════════════════════════════════════════════════════════════

import crypto from "crypto";

describe("WebhookDispatcher — HMAC signature verification", () => {
  it("should produce a valid HMAC-SHA256 signature for a given payload and secret", () => {
    const payload = JSON.stringify({
      webhookEventId: "test-uuid",
      eventType: "request.created",
      data: { key: "value" },
    });
    const secret = "test-secret-key-abc123";

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    expect(expectedSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof expectedSignature).toBe("string");
  });

  it("should produce different signatures for different secrets", () => {
    const payload = JSON.stringify({ eventType: "test", data: {} });

    const signatureWithSecretA = crypto
      .createHmac("sha256", "secret-a")
      .update(payload)
      .digest("hex");
    const signatureWithSecretB = crypto
      .createHmac("sha256", "secret-b")
      .update(payload)
      .digest("hex");

    expect(signatureWithSecretA).not.toBe(signatureWithSecretB);
  });

  it("should produce different signatures for different payloads", () => {
    const secret = "shared-secret";

    const signatureForPayloadA = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify({ eventType: "a" }))
      .digest("hex");
    const signatureForPayloadB = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify({ eventType: "b" }))
      .digest("hex");

    expect(signatureForPayloadA).not.toBe(signatureForPayloadB);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Event filtering logic (extracted for unit testing)
// ═══════════════════════════════════════════════════════════════

describe("WebhookEventBus — server-side event filtering", () => {
  it("should support filtering events by eventType", () => {
    const filteredEvents: WebhookEvent[] = [];
    const filterEvents = ["request.created", "generation.started"];

    const filteringListener = (event: WebhookEvent) => {
      if (filterEvents.includes(event.eventType)) {
        filteredEvents.push(event);
      }
    };

    WebhookEventBus.subscribe(filteringListener);

    WebhookEventBus.emit("request.created", { id: 1 });
    WebhookEventBus.emit("request.tool_call.started", { id: 2 });
    WebhookEventBus.emit("generation.started", { id: 3 });
    WebhookEventBus.emit("generation.completed", { id: 4 });

    expect(filteredEvents).toHaveLength(2);
    expect(filteredEvents[0].eventType).toBe("request.created");
    expect(filteredEvents[1].eventType).toBe("generation.started");

    WebhookEventBus.unsubscribe(filteringListener);
  });

  it("should support filtering events by agent field in data", () => {
    const meepoEvents: WebhookEvent[] = [];
    const targetAgent = "meepo";

    const agentFilterListener = (event: WebhookEvent) => {
      if (event.data.agent === targetAgent) {
        meepoEvents.push(event);
      }
    };

    WebhookEventBus.subscribe(agentFilterListener);

    WebhookEventBus.emit("request.created", {
      agent: "meepo",
      model: "claude-sonnet-4-20250514",
    });
    WebhookEventBus.emit("request.created", {
      agent: "phoenix",
      model: "gpt-4.1",
    });
    WebhookEventBus.emit("request.created", {
      agent: "meepo",
      model: "gemini-3-flash",
    });

    expect(meepoEvents).toHaveLength(2);

    WebhookEventBus.unsubscribe(agentFilterListener);
  });

  it("should support filtering events by provider field in data", () => {
    const anthropicEvents: WebhookEvent[] = [];

    const providerFilterListener = (event: WebhookEvent) => {
      if (event.data.provider === PROVIDERS.ANTHROPIC) {
        anthropicEvents.push(event);
      }
    };

    WebhookEventBus.subscribe(providerFilterListener);

    WebhookEventBus.emit("request.created", { provider: PROVIDERS.ANTHROPIC });
    WebhookEventBus.emit("request.created", { provider: PROVIDERS.GOOGLE });
    WebhookEventBus.emit("request.created", { provider: PROVIDERS.ANTHROPIC });

    expect(anthropicEvents).toHaveLength(2);

    WebhookEventBus.unsubscribe(providerFilterListener);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Animation timeline contract
// ═══════════════════════════════════════════════════════════════

describe("Webhook animation timeline — event sequence contract", () => {
  let timeline: Array<{ eventType: string; timestamp: string }> = [];
  const timelineListener = (event: WebhookEvent) => {
    timeline.push({
      eventType: event.eventType,
      timestamp: event.webhookTimestamp,
    });
  };

  beforeEach(() => {
    timeline = [];
    WebhookEventBus.subscribe(timelineListener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(timelineListener);
  });

  it("should produce the correct animation sequence for a tool-use agentic turn", () => {
    WebhookEventBus.emit("generation.started", {
      activeCount: 1,
      agent: "meepo",
      model: "claude-sonnet-4-20250514",
    });

    WebhookEventBus.emit("request.tool_call.started", {
      toolName: "web_search",
      toolCallId: "tc-001",
      agent: "meepo",
    });

    WebhookEventBus.emit("request.tool_call.completed", {
      toolName: "web_search",
      toolCallId: "tc-001",
      durationMs: 1200,
      status: "done",
    });

    WebhookEventBus.emit("request.created", {
      requestId: "req-001",
      agent: "meepo",
      toolsUsed: true,
      toolApiNames: ["web_search"],
      estimatedCost: 0.015,
    });

    WebhookEventBus.emit("generation.completed", { activeCount: 0 });

    const eventSequence = timeline.map((entry) => entry.eventType);
    expect(eventSequence).toEqual([
      "generation.started",
      "request.tool_call.started",
      "request.tool_call.completed",
      "request.created",
      "generation.completed",
    ]);
  });

  it("should support multiple parallel tool calls in the timeline", () => {
    WebhookEventBus.emit("generation.started", { activeCount: 1 });

    WebhookEventBus.emit("request.tool_call.started", {
      toolName: "read_file",
      toolCallId: "tc-a",
    });
    WebhookEventBus.emit("request.tool_call.started", {
      toolName: "web_search",
      toolCallId: "tc-b",
    });

    WebhookEventBus.emit("request.tool_call.completed", {
      toolName: "web_search",
      toolCallId: "tc-b",
      durationMs: 800,
      status: "done",
    });
    WebhookEventBus.emit("request.tool_call.completed", {
      toolName: "read_file",
      toolCallId: "tc-a",
      durationMs: 1500,
      status: "done",
    });

    WebhookEventBus.emit("request.created", {
      toolsUsed: true,
      toolApiNames: ["read_file", "web_search"],
    });
    WebhookEventBus.emit("generation.completed", { activeCount: 0 });

    const toolStarted = timeline.filter(
      (entry) => entry.eventType === "request.tool_call.started",
    );
    const toolCompleted = timeline.filter(
      (entry) => entry.eventType === "request.tool_call.completed",
    );

    expect(toolStarted).toHaveLength(2);
    expect(toolCompleted).toHaveLength(2);
  });

  it("should handle tool call error status in animation timeline", () => {
    WebhookEventBus.emit("generation.started", { activeCount: 1 });

    WebhookEventBus.emit("request.tool_call.started", {
      toolName: "execute_code",
      toolCallId: "tc-err",
    });

    WebhookEventBus.emit("request.tool_call.completed", {
      toolName: "execute_code",
      toolCallId: "tc-err",
      durationMs: 250,
      status: "error",
      toolResult: { error: "Syntax error in code" },
    });

    const errorEvent = timeline.find(
      (entry) => entry.eventType === "request.tool_call.completed",
    );
    expect(errorEvent).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  PostExecutionEmitter — webhook integration contract
// ═══════════════════════════════════════════════════════════════

describe("PostExecutionEmitter — request.tool_call.completed webhook contract", () => {
  let capturedWebhookEvents: WebhookEvent[] = [];
  const webhookCaptureListener = (event: WebhookEvent) => {
    capturedWebhookEvents.push(event);
  };

  beforeEach(() => {
    capturedWebhookEvents = [];
    WebhookEventBus.subscribe(webhookCaptureListener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(webhookCaptureListener);
  });

  it("should emit request.tool_call.completed with correct shape for successful tool", () => {
    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: "req-abc",
      toolName: "web_search",
      toolCallId: "tc-123",
      toolResult: { results: ["result1", "result2"] },
      durationMs: 450,
      status: "done",
      agent: "meepo",
      conversationId: "conv-xyz",
      agentConversationId: "sess-789",
      project: "coding",
      username: "rodrigo",
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-sonnet-4-20250514",
    });

    const completedEvents = capturedWebhookEvents.filter(
      (event) => event.eventType === "request.tool_call.completed",
    );
    expect(completedEvents).toHaveLength(1);

    const data = completedEvents[0].data;
    expect(data.toolName).toBe("web_search");
    expect(data.toolCallId).toBe("tc-123");
    expect(data.durationMs).toBe(450);
    expect(data.status).toBe("done");
    expect(data.agent).toBe("meepo");
    expect(data.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(data.model).toBe("claude-sonnet-4-20250514");
  });

  it("should emit request.tool_call.completed with error status for failed tool", () => {
    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: "req-def",
      toolName: "read_file",
      toolCallId: "tc-456",
      toolResult: { error: "ENOENT: no such file or directory" },
      durationMs: 12,
      status: "error",
      agent: null,
      conversationId: "conv-ghi",
    });

    const completedEvents = capturedWebhookEvents.filter(
      (event) => event.eventType === "request.tool_call.completed",
    );
    expect(completedEvents[0].data.status).toBe("error");
    expect(completedEvents[0].data.durationMs).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════
//  BaseAgenticHarness — webhook integration contract
// ═══════════════════════════════════════════════════════════════

describe("BaseAgenticHarness — request.tool_call.started webhook contract", () => {
  let capturedWebhookEvents: WebhookEvent[] = [];
  const webhookCaptureListener = (event: WebhookEvent) => {
    capturedWebhookEvents.push(event);
  };

  beforeEach(() => {
    capturedWebhookEvents = [];
    WebhookEventBus.subscribe(webhookCaptureListener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(webhookCaptureListener);
  });

  it("should emit request.tool_call.started with correct shape", () => {
    WebhookEventBus.emit("request.tool_call.started", {
      requestId: "req-start-001",
      toolName: "execute_code",
      toolCallId: "tc-start-001",
      toolArgs: { language: "python", code: "print('hello')" },
      agent: "meepo",
      conversationId: "conv-start-001",
      agentConversationId: "sess-start-001",
      project: "coding",
      username: "rodrigo",
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3-flash",
      iteration: 2,
    });

    const startedEvents = capturedWebhookEvents.filter(
      (event) => event.eventType === "request.tool_call.started",
    );
    expect(startedEvents).toHaveLength(1);

    const data = startedEvents[0].data;
    expect(data.toolName).toBe("execute_code");
    expect(data.toolCallId).toBe("tc-start-001");
    expect(data.toolArgs).toEqual({
      language: "python",
      code: "print('hello')",
    });
    expect(data.agent).toBe("meepo");
    expect(data.iteration).toBe(2);
    expect(data.provider).toBe(PROVIDERS.GOOGLE);
    expect(data.model).toBe("gemini-3-flash");
  });
});

// ═══════════════════════════════════════════════════════════════
//  Subscription event/filter matching logic (pure functions)
// ═══════════════════════════════════════════════════════════════

import { matchesEventTypes, matchesFilter } from "../src/services/WebhookDispatcher.ts";

function createWebhookEvent(data: Record<string, unknown>): WebhookEvent {
  return {
    webhookEventId: "test-event-id",
    webhookTimestamp: new Date().toISOString(),
    eventType: "test.event",
    data,
  };
}

describe("Webhook subscription — event matching logic", () => {
  it("should match wildcard '*' event subscription", () => {
    expect(matchesEventTypes("request.created", ["*"])).toBe(true);
    expect(matchesEventTypes("generation.started", ["*"])).toBe(true);
    expect(
      matchesEventTypes("request.tool_call.started", ["*"]),
    ).toBe(true);
  });

  it("should match specific event types", () => {
    const subscribedEvents = ["request.created", "generation.started"];

    expect(matchesEventTypes("request.created", subscribedEvents)).toBe(true);
    expect(matchesEventTypes("generation.started", subscribedEvents)).toBe(
      true,
    );
    expect(
      matchesEventTypes("request.tool_call.started", subscribedEvents),
    ).toBe(false);
  });

  it("should not match unsubscribed event types", () => {
    expect(
      matchesEventTypes("generation.completed", ["request.created"]),
    ).toBe(false);
  });

  it("should match when filter is empty", () => {
    expect(
      matchesFilter(
        createWebhookEvent({ agent: "meepo", provider: PROVIDERS.ANTHROPIC }),
        {},
      ),
    ).toBe(true);
  });

  it("should match when filter fields match event data", () => {
    expect(
      matchesFilter(
        createWebhookEvent({ agent: "meepo", provider: PROVIDERS.ANTHROPIC }),
        { agent: "meepo" },
      ),
    ).toBe(true);
  });

  it("should not match when filter fields differ from event data", () => {
    expect(
      matchesFilter(
        createWebhookEvent({ agent: "meepo", provider: PROVIDERS.ANTHROPIC }),
        { agent: "phoenix" },
      ),
    ).toBe(false);
  });

  it("should match when multiple filter fields all match", () => {
    expect(
      matchesFilter(
        createWebhookEvent({ agent: "meepo", provider: PROVIDERS.ANTHROPIC, project: "coding" }),
        { agent: "meepo", provider: PROVIDERS.ANTHROPIC },
      ),
    ).toBe(true);
  });

  it("should not match when one filter field mismatches", () => {
    expect(
      matchesFilter(
        createWebhookEvent({ agent: "meepo", provider: PROVIDERS.ANTHROPIC }),
        { agent: "meepo", provider: PROVIDERS.GOOGLE },
      ),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookRoutes — REST & SSE integration tests
// ═══════════════════════════════════════════════════════════════

import request from "supertest";
import { app } from "./setup.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";

describe("WebhookRoutes — REST & SSE integration", () => {
  let mockSubscriptions: any[] = [];
  const mockDb = {
    collection: () => ({
      insertOne: async (doc: any) => {
        mockSubscriptions.push(doc);
        return { insertedId: doc.id };
      },
      find: () => {
        return {
          project: (proj: any) => {
            const projected = mockSubscriptions.map(s => {
              const copy = { ...s };
              if (proj && proj.secret === 0) delete copy.secret;
              return copy;
            });
            return {
              sort: () => ({
                toArray: async () => projected
              }),
              toArray: async () => projected
            };
          },
          toArray: async () => mockSubscriptions
        };
      },
      findOneAndUpdate: async (filter: any, update: any, options: any) => {
        const sub = mockSubscriptions.find(s => s.id === filter.id);
        if (!sub) return null;
        if (update.$set) {
          Object.assign(sub, update.$set);
        }
        const copy = { ...sub };
        if (options && options.projection && options.projection.secret === 0) {
          delete copy.secret;
        }
        return copy;
      },
      deleteOne: async (filter: any) => {
        const index = mockSubscriptions.findIndex(s => s.id === filter.id);
        if (index === -1) return { deletedCount: 0 };
        mockSubscriptions.splice(index, 1);
        return { deletedCount: 1 };
      }
    })
  };

  beforeEach(() => {
    mockSubscriptions = [];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  it("POST /webhooks/subscriptions should register a subscription", async () => {
    const payload = {
      url: "https://example.com/webhook",
      events: ["request.created"],
      filter: { agent: "meepo" }
    };

    const response = await request(app)
      .post("/webhooks/subscriptions")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .send(payload)
      .expect(201);

    expect(response.body.subscription).toBeDefined();
    expect(response.body.subscription.url).toBe(payload.url);
    expect(response.body.subscription.secret).toBeDefined();
    expect(response.body.subscription.enabled).toBe(true);
    expect(mockSubscriptions).toHaveLength(1);
  });

  it("POST /webhooks/subscriptions should reject invalid URLs and protocols", async () => {
    await request(app)
      .post("/webhooks/subscriptions")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .send({ url: "ftp://example.com" })
      .expect(400);

    await request(app)
      .post("/webhooks/subscriptions")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .send({ url: "not-a-url" })
      .expect(400);
  });

  it("GET /webhooks/subscriptions should list registered subscriptions without secrets", async () => {
    mockSubscriptions.push({
      id: "sub-1",
      url: "https://example.com/1",
      secret: "supersecret",
      events: ["*"],
      enabled: true
    });

    const response = await request(app)
      .get("/webhooks/subscriptions")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .expect(200);

    expect(response.body.subscriptions).toHaveLength(1);
    expect(response.body.subscriptions[0].url).toBe("https://example.com/1");
    expect(response.body.subscriptions[0].secret).toBeUndefined();
  });

  it("PATCH /webhooks/subscriptions/:id should update properties", async () => {
    mockSubscriptions.push({
      id: "sub-2",
      url: "https://example.com/2",
      secret: "secret-key",
      events: ["*"],
      enabled: true
    });

    const response = await request(app)
      .patch("/webhooks/subscriptions/sub-2")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .send({ enabled: false, url: "https://example.com/new-url" })
      .expect(200);

    expect(response.body.subscription.enabled).toBe(false);
    expect(response.body.subscription.url).toBe("https://example.com/new-url");
    expect(response.body.subscription.secret).toBeUndefined();
    expect(mockSubscriptions[0].enabled).toBe(false);
  });

  it("DELETE /webhooks/subscriptions/:id should remove subscription", async () => {
    mockSubscriptions.push({
      id: "sub-3",
      url: "https://example.com/3",
      secret: "secret-key",
      events: ["*"],
      enabled: true
    });

    await request(app)
      .delete("/webhooks/subscriptions/sub-3")
      .set("x-project", "test-project")
      .set("x-username", "test-user")
      .expect(200);

    expect(mockSubscriptions).toHaveLength(0);
  });

  it("GET /webhooks/requests/stream should establish SSE connection and return connected message", async () => {
    const server = app.listen(0);
    const address = server.address() as any;
    const port = address.port;

    try {
      const controller = new AbortController();
      const response = await fetch(`http://localhost:${port}/webhooks/requests/stream?events=*`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("connected");

      controller.abort();
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  WebhookDispatcher — lifecycle & resource leaks tests
// ═══════════════════════════════════════════════════════════════

import WebhookDispatcher from "../src/services/WebhookDispatcher.ts";

describe("WebhookDispatcher — resource leak & lifecycle", () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should clear timeout handle even when fetch fails/rejects", async () => {
    const spyClearTimeout = vi.spyOn(globalThis, "clearTimeout");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection reset"));

    const mockSubscriptions = [
      {
        id: "sub-1",
        url: "https://failed-webhook.site/post",
        secret: "test-secret",
        events: ["*"],
        filter: {},
        enabled: true
      }
    ];

    const mockDb = {
      collection: () => ({
        find: () => ({
          toArray: async () => mockSubscriptions
        })
      })
    };
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);

    await WebhookDispatcher.init();

    WebhookEventBus.emit("test.event", { val: 123 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spyClearTimeout).toHaveBeenCalled();

    await WebhookDispatcher.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════
//  BaseAgenticHarness — native MCP tool calls tests
// ═══════════════════════════════════════════════════════════════

import ReActHarness from "../src/services/harnesses/ReActHarness.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";

describe("BaseAgenticHarness — native MCP tool call emits", () => {
  let capturedWebhookEvents: WebhookEvent[] = [];
  const captureListener = (event: WebhookEvent) => {
    capturedWebhookEvents.push(event);
  };

  beforeEach(() => {
    capturedWebhookEvents = [];
    WebhookEventBus.subscribe(captureListener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(captureListener);
  });

  it("should emit webhook events for native MCP tool calls when status is calling and done", async () => {
    const mockContext = {
      options: {},
      agent: "meepo",
      project: "coding",
      username: "rodrigo",
      messages: [],
      agentConversationId: "sess-1",
      provider: {
        generateTextStream: vi.fn(),
      },
      providerName: PROVIDERS.ANTHROPIC,
      resolvedModel: "claude-sonnet-4",
      emit: vi.fn(),
      requestId: "req-1",
      conversationId: "conv-1",
    };
    const mockState = new AgenticLoopState({
      originalMessageCount: 0,
      planModeActive: false,
    });
    const mockTools = {
      finalTools: [],
      customToolMap: new Map(),
      resolvedEnabledTools: [],
    };

    const harness = new ReActHarness(mockContext as any, mockState as any, mockTools as any);
    const passState = harness.createPassState({});
    const allowedTools = new Set<string>();

    const callingChunk = {
      type: "toolCall",
      native: true,
      status: "calling",
      name: "mcp_read_file",
      id: "ntc-0",
      args: { path: "package.json" }
    };

    await harness.processStreamChunk(callingChunk, passState, allowedTools);

    const startedEvents = capturedWebhookEvents.filter(
      (event) => event.eventType === "request.tool_call.started",
    );
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].data.toolName).toBe("mcp_read_file");
    expect(startedEvents[0].data.toolCallId).toBe("ntc-0");
    expect(startedEvents[0].data.toolArgs).toEqual({ path: "package.json" });

    const doneChunk = {
      type: "toolCall",
      native: true,
      status: "done",
      name: "mcp_read_file",
      id: "ntc-0",
      result: { content: "file content" }
    };

    await harness.processStreamChunk(doneChunk, passState, allowedTools);

    const completedEvents = capturedWebhookEvents.filter(
      (event) => event.eventType === "request.tool_call.completed",
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data.toolName).toBe("mcp_read_file");
    expect(completedEvents[0].data.toolCallId).toBe("ntc-0");
    expect(completedEvents[0].data.toolResult).toEqual({ content: "file content" });
    expect(completedEvents[0].data.status).toBe("done");
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('Webhook Route adversarial — URL validation', () => {
  const agent = request(app);

  it('should reject webhook subscription with missing URL — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ events: ['*'] });
    expect(response.status).toBe(400);
  });

  it('should reject webhook subscription with non-string URL — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 12345 });
    expect(response.status).toBe(400);
  });

  it('should reject webhook subscription with invalid URL format — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'not-a-valid-url' });
    expect(response.status).toBe(400);
  });

  it('should reject webhook subscription with ftp:// protocol — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'ftp://evil.com/webhook' });
    expect(response.status).toBe(400);
  });

  it('should reject webhook subscription with file:// protocol — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'file:///etc/passwd' });
    expect(response.status).toBe(400);
  });

  it('should reject webhook subscription with javascript: protocol — 400 validation error', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'javascript:alert(1)' });
    expect(response.status).toBe(400);
  });
});
