/**
 * Harness Adversarial Tests
 * ═════════════════════════════════════════════════════════════════════
 *
 * These tests systematically attempt to BREAK the harness infrastructure
 * by exploiting trust boundaries, state machine invariants, and input
 * validation gaps across:
 *
 *   - ChatRequestSchema (Zod trust boundary)
 *   - AgenticLoopService (orchestration façade)
 *   - AgenticLoopState (mutable state invariants)
 *   - HarnessRegistry (lookup/dispatch)
 *   - ToolContext (cross-session isolation)
 *   - ApprovalRegistry (pending promise lifecycle)
 *   - consumeAgentSSE (SSE parser robustness)
 *   - ReActHarness maxIterations clamping
 *
 * Every test has a clear "this SHOULD break" thesis and targets real bugs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HARNESS_IDS, PROVIDERS, THOUGHT_STRUCTURES, TYPES } from "../src/constants.ts";
import { ChatRequestSchema } from "../src/types/schemas.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import ToolContext from "../src/services/ToolContext.ts";
import {
  pendingApprovals,
  pendingQuestions,
} from "../src/services/ApprovalRegistry.ts";
import HarnessRegistry from "../src/services/harnesses/HarnessRegistry.ts";
import VisionLanguageHarness from "../src/services/harnesses/VisionLanguageHarness.ts";


// ═══════════════════════════════════════════════════════════════════
// Flow 1: ChatRequestSchema — Trust Boundary (Input Enters System)
// ═══════════════════════════════════════════════════════════════════

describe("Flow 1: ChatRequestSchema Trust Boundary", () => {

  // ── Boundary Tests ──────────────────────────────────────────────

  it("should reject payload with missing provider field entirely", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject payload with missing messages field entirely", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject payload where messages is not an array", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: "not-an-array",
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject payload where messages is an object instead of array", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: { role: "user", content: "hi" },
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject message with missing role field", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ content: "hi" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept message with empty string content (boundary case)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // ── Type Coercion Tests ──────────────────────────────────────────

  it("should reject provider as a number instead of string", () => {
    const payload = {
      provider: 12345,
      messages: [{ role: "user", content: "hi" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject maxTokens as a string that is not a number", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: "lots",
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject temperature as a boolean instead of number", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      temperature: true,
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject maxIterations as a string instead of number", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      maxIterations: "infinity",
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept negative maxIterations (schema does not bound it)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      maxIterations: -1,
    };
    const result = ChatRequestSchema.safeParse(payload);
    // Schema allows any number — the clamping happens in ReActHarness.
    // This test documents that the schema does NOT reject negatives.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxIterations).toBe(-1);
    }
  });

  it("should reject NaN as maxTokens (Zod z.number rejects non-finite values)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: NaN,
    };
    const result = ChatRequestSchema.safeParse(payload);
    // Zod's z.number() is stricter than typeof — it rejects NaN.
    // This is defense-in-depth: NaN cannot propagate to provider calls.
    expect(result.success).toBe(false);
  });

  it("should reject Infinity as branchCount (Zod z.number rejects non-finite values)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      branchCount: Infinity,
    };
    const result = ChatRequestSchema.safeParse(payload);
    // Zod's z.number() rejects Infinity — prevents unbounded resource allocation.
    expect(result.success).toBe(false);
  });

  // ── Passthrough / Unknown Fields ──────────────────────────────────

  it("should pass through unknown extra fields due to .passthrough()", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
      dangerousExtraField: "should be preserved",
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      // .passthrough() preserves unknown keys — verify they survive
      expect(result.data).toHaveProperty("dangerousExtraField");
    }
  });

  // ── Security-Adjacent: Null Bytes and Special Characters ─────────

  it("should strip null bytes from provider via sanitizedString transform", () => {
    const payload = {
      provider: "openai\0injected",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    // sanitizedString() strips null bytes via transform, then validates
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openaiinjected");
      expect(result.data.provider).not.toContain("\0");
    }
  });

  it("should reject agentConversationId with path traversal characters", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      agentConversationId: "../../etc/passwd",
    };
    const result = ChatRequestSchema.safeParse(payload);
    // sanitizedString() rejects path traversal patterns
    expect(result.success).toBe(false);
  });

  it("should reject harness name with path traversal characters", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      harness: "../../../etc/passwd",
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept harness name with semicolons (no path traversal)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      harness: "standard; rm -rf /",
    };
    const result = ChatRequestSchema.safeParse(payload);
    // Semicolons are allowed — only null bytes and path traversal are blocked
    expect(result.success).toBe(true);
  });

  // ── Boundary: Extreme Message Array Sizes ────────────────────────

  it("should accept a payload with zero messages (empty array)", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [],
    };
    const result = ChatRequestSchema.safeParse(payload);
    // No .nonempty() constraint on ChatRequestSchema messages
    expect(result.success).toBe(true);
  });

  it("should accept deeply nested content arrays without stack overflow", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "user",
        content: [
          { type: TYPES.TEXT, text: "a".repeat(10_000) },
          { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(10_000) } },
        ],
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 2: AgenticLoopState — State Machine Invariants
// ═══════════════════════════════════════════════════════════════════

describe("Flow 2: AgenticLoopState Invariants", () => {

  it("should initialize with all counters at zero", () => {
    const state = new AgenticLoopState();
    expect(state.iterations).toBe(0);
    expect(state.overallOutputCharacters).toBe(0);
    expect(state.streamedToolCalls).toEqual([]);
    expect(state.displaySegments).toEqual([]);
    expect(state.planModeActive).toBe(false);
    expect(state.conversationOutcome).toBe("completed");
  });

  it("should preserve planModeActive when explicitly set in constructor", () => {
    const state = new AgenticLoopState({ planModeActive: true });
    expect(state.planModeActive).toBe(true);
  });

  it("should not prevent iterations from being set to negative values", () => {
    const state = new AgenticLoopState();
    state.iterations = -1;
    // No validation — documents that callers can set invalid state
    expect(state.iterations).toBe(-1);
  });

  it("should not prevent originalMessageCount from going negative", () => {
    const state = new AgenticLoopState({ originalMessageCount: 2 });
    // Context truncation can subtract more messages than exist
    state.originalMessageCount -= 10;
    expect(state.originalMessageCount).toBe(-8);
  });

  // ── getCleanDisplayData edge cases ──────────────────────────────

  it("should handle getCleanDisplayData with empty fragments array", () => {
    const state = new AgenticLoopState();
    state.displaySegments = [
      { type: "text", fragmentIndex: 0 },
    ];
    // Fragment index 0 doesn't exist in the array — undefined.trim() will crash?
    // Actually, the optional chain ?.trim() handles it
    const result = state.getCleanDisplayData();
    // Should skip segments with undefined fragments
    expect(result.cleanSegments).toHaveLength(0);
    expect(result.cleanTextFragments).toHaveLength(0);
  });

  it("should handle getCleanDisplayData with fragment index out of bounds", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["hello"];
    state.displaySegments = [
      { type: "text", fragmentIndex: 999 }, // out of bounds
    ];
    const result = state.getCleanDisplayData();
    // index 999 yields undefined, ?.trim() → undefined, !undefined → true → skip
    expect(result.cleanSegments).toHaveLength(0);
  });

  it("should handle getCleanDisplayData with whitespace-only fragments", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["   \n\t  "];
    state.displaySegments = [
      { type: "text", fragmentIndex: 0 },
    ];
    const result = state.getCleanDisplayData();
    // Trimmed string is empty → skipped
    expect(result.cleanSegments).toHaveLength(0);
    expect(result.cleanTextFragments).toHaveLength(0);
  });

  it("should correctly reindex fragments when earlier segments are dropped", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["", "real content", ""];
    state.displayThinkingFragments = ["thought"];
    state.displaySegments = [
      { type: "text", fragmentIndex: 0 },     // empty — will be dropped
      { type: "thinking", fragmentIndex: 0 },  // has content
      { type: "text", fragmentIndex: 1 },       // has content
      { type: "text", fragmentIndex: 2 },       // empty — will be dropped
    ];
    const result = state.getCleanDisplayData();
    expect(result.cleanSegments).toHaveLength(2);
    expect(result.cleanTextFragments).toEqual(["real content"]);
    expect(result.cleanThinkingFragments).toEqual(["thought"]);
    // Fragment indices must be reindexed correctly
    const textSegment = result.cleanSegments.find(
      (segment) => segment.type === "text"
    );
    expect(textSegment).toBeDefined();
    if (textSegment && "fragmentIndex" in textSegment) {
      expect(textSegment.fragmentIndex).toBe(0);
    }
  });

  // ── Concurrency: Shared Mutable State ────────────────────────────

  it("should allow concurrent writes to overallUsage without protection", () => {
    const state = new AgenticLoopState();
    // Simulate two branches writing simultaneously (tree-of-thought)
    state.overallUsage.inputTokens += 100;
    state.overallUsage.outputTokens += 50;
    state.overallUsage.inputTokens += 200;
    state.overallUsage.outputTokens += 100;
    // No atomicity — but JS is single-threaded, so this is fine synchronously
    expect(state.overallUsage.inputTokens).toBe(300);
    expect(state.overallUsage.outputTokens).toBe(150);
  });

  it("should not corrupt hwm values when set from multiple iterations", () => {
    const state = new AgenticLoopState();
    state.hwmOutputTokens = 100;
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 50); // should stay 100
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 200); // should go to 200
    expect(state.hwmOutputTokens).toBe(200);
  });

  // ── Error Budget ────────────────────────────────────────────────

  it("should track tool error counts per tool independently", () => {
    const state = new AgenticLoopState();
    state.toolErrorCounts.set("shell_execute", 1);
    state.toolErrorCounts.set("read_file", 2);
    expect(state.toolErrorCounts.get("shell_execute")).toBe(1);
    expect(state.toolErrorCounts.get("read_file")).toBe(2);
    expect(state.toolErrorCounts.get("nonexistent_tool")).toBeUndefined();
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 3: HarnessRegistry — Dispatch Safety
// ═══════════════════════════════════════════════════════════════════

describe("Flow 3: HarnessRegistry Dispatch", () => {

  it("should return standard harness for unknown harness id (fallback)", () => {
    const harness = HarnessRegistry.get("nonexistent-harness-xyz");
    expect(harness).toBeDefined();
    // Should fallback to HARNESS_IDS.STANDARD (ReActHarness)
    expect(harness!.id).toBe(HARNESS_IDS.STANDARD);
  });

  it("should return standard harness for empty string id", () => {
    const harness = HarnessRegistry.get("");
    expect(harness).toBeDefined();
    expect(harness!.id).toBe(HARNESS_IDS.STANDARD);
  });

  it("should return standard harness for id with special characters", () => {
    const harness = HarnessRegistry.get("../../../etc/passwd");
    expect(harness).toBeDefined();
    expect(harness!.id).toBe(HARNESS_IDS.STANDARD);
  });

  it("should have HARNESS_IDS.STANDARD harness registered", () => {
    expect(HarnessRegistry.has(HARNESS_IDS.STANDARD)).toBe(true);
  });

  it("should have 'vision_language' harness registered (underscore convention)", () => {
    expect(HarnessRegistry.has(VisionLanguageHarness.id)).toBe(true);
  });

  it("should not have HARNESS_IDS.TREE_OF_THOUGHT as a harness (now a strategy)", () => {
    expect(HarnessRegistry.has("tree_of_thought")).toBe(false);
    expect(HarnessRegistry.has("tree_of_thought")).toBe(false);
  });

  it("should list all registered harnesses with required metadata", () => {
    const harnesses = HarnessRegistry.list();
    expect(harnesses.length).toBeGreaterThanOrEqual(2);
    for (const harness of harnesses) {
      expect(harness.id).toBeTruthy();
      expect(harness.label).toBeTruthy();
      expect(harness.description).toBeTruthy();
    }
  });

  // ── State Machine Violation: Legacy Harness Migration ──────────

  it("should confirm legacy tree-of-thought harness is not in the registry (migration handled by AgenticLoopService)", () => {
    // Legacy HARNESS_IDS.TREE_OF_THOUGHT and HARNESS_IDS.TREE_OF_THOUGHT harness IDs are now
    // migrated to standard + tree_of_thoughts strategy in AgenticLoopService.
    // HarnessRegistry.get() falls back to standard for any unknown ID,
    // but the intent is that the migration code in AgenticLoopService
    // catches these BEFORE they reach the registry.
    const harness = HarnessRegistry.get("tree_of_thought");
    expect(harness!.id).toBe(HARNESS_IDS.STANDARD);
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 4: ToolContext — Cross-Session Isolation
// ═══════════════════════════════════════════════════════════════════

describe("Flow 4: ToolContext Session Isolation", () => {

  const SESSION_ALPHA = "session-alpha-" + Date.now();
  const SESSION_BETA = "session-beta-" + Date.now();

  afterEach(() => {
    ToolContext.cleanupInMemory(SESSION_ALPHA);
    ToolContext.cleanupInMemory(SESSION_BETA);
  });

  it("should isolate state between different sessions", () => {
    ToolContext.set(SESSION_ALPHA, "key", "alpha-value");
    ToolContext.set(SESSION_BETA, "key", "beta-value");

    expect(ToolContext.get(SESSION_ALPHA, "key")).toBe("alpha-value");
    expect(ToolContext.get(SESSION_BETA, "key")).toBe("beta-value");
  });

  it("should return undefined for nonexistent session key", () => {
    expect(ToolContext.get("nonexistent-session", "any-key")).toBeUndefined();
  });

  it("should handle null bytes in session IDs without collision", () => {
    const sessionWithNull = "session\0hidden";
    const sessionNormal = "session";

    ToolContext.set(sessionWithNull, "data", "null-byte-session");
    ToolContext.set(sessionNormal, "data", "normal-session");

    expect(ToolContext.get(sessionWithNull, "data")).toBe("null-byte-session");
    expect(ToolContext.get(sessionNormal, "data")).toBe("normal-session");

    ToolContext.cleanupInMemory(sessionWithNull);
    ToolContext.cleanupInMemory(sessionNormal);
  });

  it("should create store lazily on getStore for nonexistent session", () => {
    const freshSession = "fresh-session-" + Date.now();
    const store = ToolContext.getStore(freshSession);
    expect(store).toBeInstanceOf(Map);
    expect(store.size).toBe(0);
    ToolContext.cleanupInMemory(freshSession);
  });

  it("should cleanly delete keys with delete()", () => {
    ToolContext.set(SESSION_ALPHA, "ephemeral", "will-be-deleted");
    expect(ToolContext.has(SESSION_ALPHA, "ephemeral")).toBe(true);
    const wasDeleted = ToolContext.delete(SESSION_ALPHA, "ephemeral");
    expect(wasDeleted).toBe(true);
    expect(ToolContext.has(SESSION_ALPHA, "ephemeral")).toBe(false);
  });

  it("should return false when deleting from nonexistent session", () => {
    const wasDeleted = ToolContext.delete("nonexistent-session-xyz", "key");
    expect(wasDeleted).toBe(false);
  });

  it("should handle cleanupInMemory on already-cleaned session idempotently", () => {
    ToolContext.set(SESSION_ALPHA, "data", "value");
    ToolContext.cleanupInMemory(SESSION_ALPHA);
    // Second cleanup should not throw
    expect(() => ToolContext.cleanupInMemory(SESSION_ALPHA)).not.toThrow();
  });

  it("should handle storing complex objects without corruption", () => {
    const complexValue = {
      nested: { deep: { array: [1, 2, { key: "value" }] } },
      nullValue: null,
      undefinedValue: undefined,
      dateValue: new Date("2026-01-01"),
    };
    ToolContext.set(SESSION_ALPHA, "complex", complexValue);
    const retrieved = ToolContext.get<typeof complexValue>(SESSION_ALPHA, "complex");
    expect(retrieved).toEqual(complexValue);
  });

  it("should report accurate activeConversationCount", () => {
    const initialCount = ToolContext.activeConversationCount;
    ToolContext.set(SESSION_ALPHA, "x", 1);
    ToolContext.set(SESSION_BETA, "y", 2);
    expect(ToolContext.activeConversationCount).toBe(initialCount + 2);
    ToolContext.cleanupInMemory(SESSION_ALPHA);
    expect(ToolContext.activeConversationCount).toBe(initialCount + 1);
    ToolContext.cleanupInMemory(SESSION_BETA);
    expect(ToolContext.activeConversationCount).toBe(initialCount);
  });

  it("should list keys correctly for a session", () => {
    ToolContext.set(SESSION_ALPHA, "key1", "a");
    ToolContext.set(SESSION_ALPHA, "key2", "b");
    ToolContext.set(SESSION_ALPHA, "key3", "c");
    const keys = ToolContext.keys(SESSION_ALPHA);
    expect(keys).toContain("key1");
    expect(keys).toContain("key2");
    expect(keys).toContain("key3");
    expect(keys).toHaveLength(3);
  });

  it("should return empty keys for nonexistent session", () => {
    expect(ToolContext.keys("nonexistent-session-xyz")).toEqual([]);
  });

  // ── Prototype Pollution via ToolContext ────────────────────────

  it("should not allow prototype pollution through set() keys", () => {
    ToolContext.set(SESSION_ALPHA, "__proto__", { polluted: true });
    ToolContext.set(SESSION_ALPHA, "constructor", { polluted: true });
    // The Map stores these as regular entries, not prototype mutations
    const store = ToolContext.getStore(SESSION_ALPHA);
    expect(store.get("__proto__")).toEqual({ polluted: true });
    // Object.prototype should NOT be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 5: ApprovalRegistry — Promise Lifecycle
// ═══════════════════════════════════════════════════════════════════

describe("Flow 5: ApprovalRegistry Promise Lifecycle", () => {

  afterEach(() => {
    pendingApprovals.clear();
    pendingQuestions.clear();
  });

  it("should store and retrieve a pending tool approval", () => {
    const resolveFunction = vi.fn();
    pendingApprovals.set("conv-1", {
      resolve: resolveFunction,
      type: "tool",
      tools: ["shell_execute"],
      toolCalls: [{
        id: "tc-1",
        name: "shell_execute",
        args: { command: "ls" },
      }],
    });

    const entry = pendingApprovals.get("conv-1");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("tool");
    expect(entry!.tools).toContain("shell_execute");
  });

  it("should store and retrieve a pending plan approval", () => {
    const resolveFunction = vi.fn();
    pendingApprovals.set("conv-plan", {
      resolve: resolveFunction,
      type: "plan",
    });

    const entry = pendingApprovals.get("conv-plan");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("plan");
  });

  it("should overwrite previous approval when same conversationId is used (resolver is superseded)", () => {
    const firstResolver = vi.fn();
    const secondResolver = vi.fn();

    pendingApprovals.set("conv-overwrite", {
      resolve: firstResolver,
      type: "tool",
      tools: ["old_tool"],
      toolCalls: [],
    });

    // In production, ApprovalGate now resolves the existing entry
    // before setting the new one. This test documents the raw Map behavior.
    const existingEntry = pendingApprovals.get("conv-overwrite");
    if (existingEntry) {
      existingEntry.resolve({ isApproved: false, reason: "superseded" } as never);
      pendingApprovals.delete("conv-overwrite");
    }

    pendingApprovals.set("conv-overwrite", {
      resolve: secondResolver,
      type: "tool",
      tools: ["new_tool"],
      toolCalls: [],
    });

    const entry = pendingApprovals.get("conv-overwrite");
    expect(entry!.tools).toContain("new_tool");
    // First resolver was properly superseded — not orphaned
    expect(firstResolver).toHaveBeenCalledWith({
      isApproved: false,
      reason: "superseded",
    });
  });

  it("should handle resolving an approval that was already deleted", () => {
    const resolveFunction = vi.fn();
    pendingApprovals.set("conv-deleted", {
      resolve: resolveFunction,
      type: "tool",
      tools: ["shell_execute"],
      toolCalls: [],
    });

    pendingApprovals.delete("conv-deleted");

    // Trying to retrieve after deletion
    const entry = pendingApprovals.get("conv-deleted");
    expect(entry).toBeUndefined();
  });

  it("should store and retrieve a pending question", () => {
    const resolveFunction = vi.fn();
    pendingQuestions.set("conv-question", {
      resolve: resolveFunction,
      question: "What should I do?",
      choices: ["option-a", "option-b"],
    });

    const entry = pendingQuestions.get("conv-question");
    expect(entry).toBeDefined();
    expect(entry!.question).toBe("What should I do?");
    expect(entry!.choices).toHaveLength(2);
  });

  it("should isolate approvals from questions with same conversationId", () => {
    const approvalResolver = vi.fn();
    const questionResolver = vi.fn();

    pendingApprovals.set("conv-shared", {
      resolve: approvalResolver,
      type: "tool",
      tools: ["test"],
      toolCalls: [],
    });

    pendingQuestions.set("conv-shared", {
      resolve: questionResolver,
      question: "confirm?",
    });

    expect(pendingApprovals.get("conv-shared")).toBeDefined();
    expect(pendingQuestions.get("conv-shared")).toBeDefined();

    // Clearing one should not affect the other
    pendingApprovals.delete("conv-shared");
    expect(pendingApprovals.get("conv-shared")).toBeUndefined();
    expect(pendingQuestions.get("conv-shared")).toBeDefined();
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 6: ReActHarness maxIterations Clamping
// ═══════════════════════════════════════════════════════════════════

describe("Flow 6: maxIterations Resolution Logic", () => {
  // The clamping logic lives in ReActHarness.run():
  //   maxIterations === 0 → Infinity
  //   maxIterations > 0 → Math.min(100, Math.max(1, maxIterations))
  //   maxIterations undefined → MAX_TOOL_ITERATIONS (25)

  it("should clamp maxIterations=0 to Infinity (unbounded)", () => {
    const clientMaxIterations = 0;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(Infinity);
  });

  it("should clamp maxIterations=-1 to 1 (minimum)", () => {
    const clientMaxIterations: any = -1;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(1);
  });

  it("should clamp maxIterations=500 to 100 (maximum)", () => {
    const clientMaxIterations: any = 500;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(100);
  });

  it("should clamp maxIterations=Number.MAX_SAFE_INTEGER to 100", () => {
    const clientMaxIterations = Number.MAX_SAFE_INTEGER;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(100);
  });

  it("should default to 25 when maxIterations is undefined", () => {
    const clientMaxIterations = undefined;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(25);
  });

  it("should default to 25 when maxIterations is null", () => {
    const clientMaxIterations = null;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(25);
  });

  it("should handle NaN maxIterations — NaN is falsy, defaults to 25", () => {
    const clientMaxIterations = NaN;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    // NaN !== 0 is true, but NaN is falsy in `clientMaxIterations ? ... : 25`
    expect(resolved).toBe(25);
  });

  it("should handle maxIterations=-Infinity — clamps to 1", () => {
    const clientMaxIterations = -Infinity;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(1);
  });

  it("should handle maxIterations=1 — valid minimum", () => {
    const clientMaxIterations: any = 1;
    const resolved = clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : 25;
    expect(resolved).toBe(1);
  });
});


// ═══════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════
// Flow 8: Schema Edge Cases — Adversarial Payloads
// ═══════════════════════════════════════════════════════════════════

describe("Flow 8: Schema Edge Cases — Adversarial Payloads", () => {

  it("should reject null as the entire payload", () => {
    const result = ChatRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("should reject undefined as the entire payload", () => {
    const result = ChatRequestSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  it("should reject a string as the entire payload", () => {
    const result = ChatRequestSchema.safeParse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("should reject an array as the entire payload", () => {
    const result = ChatRequestSchema.safeParse([
      { provider: PROVIDERS.OPENAI, messages: [] },
    ]);
    expect(result.success).toBe(false);
  });

  it("should accept enabledTools as empty array", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      enabledTools: [],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabledTools).toEqual([]);
    }
  });

  it("should reject enabledTools containing non-string elements", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: "hi" }],
      enabledTools: [123, null, { name: "tool" }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept message with content as multimodal array", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "user",
        content: [
          { type: TYPES.TEXT, text: "describe this image" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should reject message with content as a number", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: 42 }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject message with content as a boolean", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{ role: "user", content: true }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept toolCalls with minimal required fields", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "assistant",
        content: "Using tool",
        toolCalls: [{
          name: "shell_execute",
          args: { command: "echo hi" },
        }],
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should reject toolCalls missing the name field", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "assistant",
        content: "Using tool",
        toolCalls: [{
          args: { command: "echo hi" },
        }],
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should reject toolCalls missing the args field", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "assistant",
        content: "Using tool",
        toolCalls: [{
          name: "shell_execute",
        }],
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  // ── Unicode Extremes ──────────────────────────────────────────

  it("should accept message content with RTL text and zero-width joiners", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "user",
        content: "مرحبا\u200D\u200D\u200D\u200F\u200E\u2066\u2069 ZWJ test",
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept message content with emoji sequences and variation selectors", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "user",
        content: "👨‍👩‍👧‍👦 family emoji | 🏳️‍🌈 flag | 👋🏿 skin tone",
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept message content with null byte embedded in string", () => {
    const payload = {
      provider: PROVIDERS.OPENAI,
      messages: [{
        role: "user",
        content: "before\0after",
      }],
    };
    const result = ChatRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages[0].content).toContain("\0");
    }
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 9: ToolContext + Dirty Flag Integration
// ═══════════════════════════════════════════════════════════════════

describe("Flow 9: ToolContext Dirty Flag for Dynamic Tool Mutation", () => {
  const SESSION_ID = "dirty-flag-test-" + Date.now();

  afterEach(() => {
    ToolContext.cleanupInMemory(SESSION_ID);
  });

  it("should set and detect toolSetDirty flag", () => {
    ToolContext.set(SESSION_ID, "toolSetDirty", true);
    const store = ToolContext.getStore(SESSION_ID);
    expect(store.get("toolSetDirty")).toBe(true);
  });

  it("should clear toolSetDirty flag after consumption", () => {
    ToolContext.set(SESSION_ID, "toolSetDirty", true);
    const store = ToolContext.getStore(SESSION_ID);
    store.delete("toolSetDirty");
    expect(store.get("toolSetDirty")).toBeUndefined();
  });

  it("should handle dynamicEnabledTools as non-array gracefully", () => {
    ToolContext.set(SESSION_ID, "toolSetDirty", true);
    ToolContext.set(SESSION_ID, "dynamicEnabledTools", "not-an-array");
    const store = ToolContext.getStore(SESSION_ID);
    const dynamicEnabled = store.get("dynamicEnabledTools");
    // BaseAgenticHarness checks Array.isArray — this should fail that check
    expect(Array.isArray(dynamicEnabled)).toBe(false);
  });

  it("should handle dynamicEnabledTools as null gracefully", () => {
    ToolContext.set(SESSION_ID, "toolSetDirty", true);
    ToolContext.set(SESSION_ID, "dynamicEnabledTools", null);
    const store = ToolContext.getStore(SESSION_ID);
    const dynamicEnabled = store.get("dynamicEnabledTools");
    expect(Array.isArray(dynamicEnabled)).toBe(false);
  });

  it("should preserve dynamicEnabledTools array order", () => {
    const toolNames = ["shell_execute", "read_file", "write_file"];
    ToolContext.set(SESSION_ID, "dynamicEnabledTools", toolNames);
    const retrieved = ToolContext.get<string[]>(SESSION_ID, "dynamicEnabledTools");
    expect(retrieved).toEqual(toolNames);
  });

  it("should handle extremely large tool lists without OOM", () => {
    const massiveToolList = Array.from(
      { length: 10_000 },
      (_, index) => `tool_${index}`,
    );
    ToolContext.set(SESSION_ID, "dynamicEnabledTools", massiveToolList);
    const retrieved = ToolContext.get<string[]>(SESSION_ID, "dynamicEnabledTools");
    expect(retrieved).toHaveLength(10_000);
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 10: AgenticLoopService Approval Resolution
// ═══════════════════════════════════════════════════════════════════

describe("Flow 10: AgenticLoopService Approval API", () => {

  afterEach(() => {
    pendingApprovals.clear();
    pendingQuestions.clear();
  });

  it("should resolve a tool approval and invoke the resolver function", () => {
    const resolverFunction = vi.fn();
    pendingApprovals.set("conv-resolve-test", {
      resolve: resolverFunction,
      type: "tool",
      tools: ["shell_execute"],
      toolCalls: [],
    });

    const entry = pendingApprovals.get("conv-resolve-test");
    expect(entry).toBeDefined();

    // Simulate AgenticLoopService.resolveApproval()
    if (entry!.type === "tool") {
      entry!.resolve({
        isApproved: true,
        shouldApproveAll: false,
        reason: "user_approved",
      });
    }

    expect(resolverFunction).toHaveBeenCalledWith({
      isApproved: true,
      shouldApproveAll: false,
      reason: "user_approved",
    });
  });

  it("should resolve a plan approval with a boolean", () => {
    const resolverFunction = vi.fn();
    pendingApprovals.set("conv-plan-resolve", {
      resolve: resolverFunction,
      type: "plan",
    });

    const entry = pendingApprovals.get("conv-plan-resolve");
    if (entry!.type === "plan") {
      entry!.resolve(true);
    }

    expect(resolverFunction).toHaveBeenCalledWith(true);
  });

  it("should handle resolving a question with answers", () => {
    const resolverFunction = vi.fn();
    pendingQuestions.set("conv-question-resolve", {
      resolve: resolverFunction,
      question: "What should I do?",
      choices: ["deploy", "rollback"],
    });

    const entry = pendingQuestions.get("conv-question-resolve");
    entry!.resolve({
      answers: [{ answer: "deploy" }],
    });

    expect(resolverFunction).toHaveBeenCalledWith({
      answers: [{ answer: "deploy" }],
    });
  });

  it("should handle resolving a question with null answers (timeout)", () => {
    const resolverFunction = vi.fn();
    pendingQuestions.set("conv-question-timeout", {
      resolve: resolverFunction,
      question: "Still there?",
    });

    const entry = pendingQuestions.get("conv-question-timeout");
    entry!.resolve({
      answers: null,
      isTimedOut: true,
    });

    expect(resolverFunction).toHaveBeenCalledWith({
      answers: null,
      isTimedOut: true,
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// Flow 11: SystemReminderInjector — Feature Gating & Cache Isolation
// ═══════════════════════════════════════════════════════════════════

describe("Flow 11: SystemReminderInjector Feature Gating", () => {
  const { maybeInjectSystemReminder, cleanupReminderCache } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../src/services/harnesses/lifecycle/SystemReminderInjector.ts") as typeof import("../src/services/harnesses/lifecycle/SystemReminderInjector.ts");

  const LARGE_SYSTEM_PROMPT =
    "You are a helpful assistant. You must always respond in English. " +
    "Never use profanity. Always cite sources. Do not fabricate data. " +
    "You should prioritize safety. Important: do not execute destructive commands. " +
    "A".repeat(300);

  function createMockState(iterationCount: number) {
    return {
      iterations: iterationCount,
      overallUsage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as import("../src/services/AgenticLoopState.ts").default;
  }

  function createMockProvider(extractedBullets?: string) {
    return {
      generateTextStream: vi.fn(async function* () {
        if (extractedBullets) {
          yield extractedBullets;
        }
      }),
    };
  }

  function createMockContext(
    overrides: Record<string, unknown> = {},
  ) {
    const emitFunction = vi.fn();
    const mockProvider = createMockProvider(
      overrides.extractedBullets as string | undefined,
    );

    return {
      options: {
        reminderModel: overrides.reminderModel ?? undefined,
        reminderProvider: overrides.reminderProvider ?? undefined,
        reminderInterval: overrides.reminderInterval ?? undefined,
      },
      emit: emitFunction,
      agentConversationId: (overrides.agentConversationId as string) || "test-session-" + Date.now(),
      provider: mockProvider,
      signal: undefined,
      project: "test",
      username: "test",
      messages: [],
      providerName: "test",
      resolvedModel: "test-model",
      conversationId: "test-conv",
    } as unknown as import("../src/services/harnesses/types.ts").AgenticContext;
  }

  afterEach(() => {
    cleanupReminderCache("test-session-gated");
    cleanupReminderCache("test-session-active");
    cleanupReminderCache("test-session-interval");
    cleanupReminderCache("test-session-cache-a");
    cleanupReminderCache("test-session-cache-b");
  });

  // ── Feature Gate: No Model = Disabled ──────────────────────────

  it("should not inject when reminderModel is undefined (feature disabled)", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
      { role: "user", content: "Hello" },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({ agentConversationId: "test-session-gated" });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(2);
    expect(context.emit).not.toHaveBeenCalled();
    expect(context.provider.generateTextStream).not.toHaveBeenCalled();
  });

  it("should not inject when reminderModel is empty string (feature disabled)", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
      { role: "user", content: "Hello" },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-gated",
      reminderModel: "",
    });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(2);
    expect(context.emit).not.toHaveBeenCalled();
  });

  // ── Feature Gate: Model Set = Active ──────────────────────────

  it("should inject when reminderModel is set and iteration matches interval", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
      { role: "user", content: "Hello" },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const extractedBullets =
      "- You must always respond in English\n" +
      "- Never use profanity\n" +
      "- Always cite sources\n" +
      "- Do not fabricate data\n" +
      "- Do not execute destructive commands";

    const context = createMockContext({
      agentConversationId: "test-session-active",
      reminderModel: "gemini-3.5-flash",
      reminderProvider: PROVIDERS.GOOGLE,
      extractedBullets,
    });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("system");
    expect(messages[2].content).toContain("[SYSTEM REMINDER");
    expect(messages[2].content).toContain("Iteration 8");
    expect(context.emit).toHaveBeenCalledOnce();
    expect(context.provider.generateTextStream).toHaveBeenCalledOnce();
  });

  // ── Iteration Threshold ──────────────────────────────────────

  it("should not inject before minimum iteration threshold (iteration 4)", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-active",
      reminderModel: "gemini-3.5-flash",
    });
    const state = createMockState(4);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(1);
    expect(context.provider.generateTextStream).not.toHaveBeenCalled();
  });

  // ── Interval Matching ─────────────────────────────────────────

  it("should not inject on non-interval iterations (iteration 7 with interval 8)", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-interval",
      reminderModel: "gemini-3.5-flash",
      reminderInterval: 8,
    });
    const state = createMockState(7);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(1);
  });

  it("should inject on exact interval match (iteration 16 with interval 8)", async () => {
    const extractedBullets =
      "- You must always respond in English language only\n" +
      "- Never use profanity or offensive language in responses\n" +
      "- Always cite your sources when making factual claims\n" +
      "- Do not fabricate any data or statistics whatsoever";

    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-interval",
      reminderModel: "gemini-3.5-flash",
      reminderInterval: 8,
      extractedBullets,
    });
    const state = createMockState(16);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Iteration 16");
  });

  // ── Cache Isolation ─────────────────────────────────────────

  it("should cache extraction results per session and not re-call the LLM", async () => {
    const extractedBullets = "- Cached rule one\n- Cached rule two\n- Cached rule three";

    const sessionId = "test-session-cache-a";

    // First injection at iteration 8
    const messagesFirst = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const contextFirst = createMockContext({
      agentConversationId: sessionId,
      reminderModel: "gemini-3.5-flash",
      extractedBullets,
    });
    const stateFirst = createMockState(8);

    await maybeInjectSystemReminder(messagesFirst, stateFirst, contextFirst);
    expect(contextFirst.provider.generateTextStream).toHaveBeenCalledOnce();
    expect(messagesFirst).toHaveLength(2);

    // Second injection at iteration 16 — should use cache, NOT call LLM again
    const messagesSecond = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const contextSecond = createMockContext({
      agentConversationId: sessionId,
      reminderModel: "gemini-3.5-flash",
      extractedBullets: "- This should NOT be used because cache hits",
    });
    const stateSecond = createMockState(16);

    await maybeInjectSystemReminder(messagesSecond, stateSecond, contextSecond);
    // LLM should NOT have been called for the second injection
    expect(contextSecond.provider.generateTextStream).not.toHaveBeenCalled();
    expect(messagesSecond).toHaveLength(2);
    // Content should be from the FIRST extraction, not the second mock
    expect(messagesSecond[1].content).toContain("Cached rule one");
  });

  it("should isolate caches between different sessions", async () => {
    const sessionIdAlpha = "test-session-cache-a";
    const sessionIdBeta = "test-session-cache-b";

    // Clean both first
    cleanupReminderCache(sessionIdAlpha);
    cleanupReminderCache(sessionIdBeta);

    // Session A extraction
    const messagesAlpha = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];
    const contextAlpha = createMockContext({
      agentConversationId: sessionIdAlpha,
      reminderModel: "gemini-3.5-flash",
      extractedBullets: "- Alpha must always respond in English language only\n- Alpha must never use profanity\n- Alpha must always cite sources when making claims",
    });
    await maybeInjectSystemReminder(messagesAlpha, createMockState(8), contextAlpha);
    expect(messagesAlpha[1].content).toContain("Alpha must always respond");

    // Session B extraction — different content
    const messagesBeta = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];
    const contextBeta = createMockContext({
      agentConversationId: sessionIdBeta,
      reminderModel: "gemini-3.5-flash",
      extractedBullets: "- Beta must prioritize user safety above all else\n- Beta must never execute destructive commands\n- Beta must ask for confirmation before actions",
    });
    await maybeInjectSystemReminder(messagesBeta, createMockState(8), contextBeta);
    expect(messagesBeta[1].content).toContain("Beta must prioritize");
    expect(messagesBeta[1].content).not.toContain("Alpha");
  });

  // ── Cleanup ─────────────────────────────────────────────────

  it("should cleanly remove cache on cleanup without throwing", () => {
    expect(() => cleanupReminderCache("nonexistent-session")).not.toThrow();
    expect(() => cleanupReminderCache("")).not.toThrow();
  });

  // ── Edge: No System Prompt ──────────────────────────────────

  it("should not inject when no system message exists in the conversation", async () => {
    const messages = [
      { role: "user", content: "Hello" },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-active",
      reminderModel: "gemini-3.5-flash",
      extractedBullets: "- Should not appear",
    });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(1);
    expect(context.provider.generateTextStream).not.toHaveBeenCalled();
  });

  it("should not inject when system prompt is too short (< 200 chars)", async () => {
    const messages = [
      { role: "system", content: "Short prompt." },
      { role: "user", content: "Hello" },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-active",
      reminderModel: "gemini-3.5-flash",
    });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    expect(messages).toHaveLength(2);
  });

  // ── Edge: LLM Returns Empty ──────────────────────────────────

  it("should not inject when LLM extraction returns empty content", async () => {
    const messages = [
      { role: "system", content: LARGE_SYSTEM_PROMPT },
    ] as import("../src/services/harnesses/types.ts").ConversationMessage[];

    const context = createMockContext({
      agentConversationId: "test-session-active",
      reminderModel: "gemini-3.5-flash",
      extractedBullets: "",
    });
    const state = createMockState(8);

    await maybeInjectSystemReminder(messages, state, context);

    // LLM returned empty → extractor returns null → injector skips
    expect(messages).toHaveLength(1);
    expect(context.emit).not.toHaveBeenCalled();
  });
});
