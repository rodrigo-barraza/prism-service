import { describe, it, expect, vi, beforeEach } from "vitest";
import DeviationRuleEngine, {
  DEVIATION_RULE_IDS,
  createDefaultDeviationRules,
  type DeviationRule,
} from "#src/services/harnesses/lifecycle/DeviationRuleEngine";
import BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";
import { createUsageAccumulator } from "#src/utils/CostCalculator";
import { STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  AgenticContext,
  PassState,
  ResolvedTools,
  ToolCall,
} from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    complete: vi.fn(),
    recordChunkTiming: vi.fn(),
    getConversationStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      tokPerSec: null,
      avgTtft: null,
    }),
  },
}));

function createToolCall(
  name: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2, 8)}`, name, args };
}

/** Text degenerate enough for the RepetitionDetector's n-gram checks. */
const DEGENERATE_TEXT = "I will try to call the tool again now. ".repeat(40);

const VARIED_TEXT =
  "The quick brown fox jumps over the lazy dog while seventeen distinct " +
  "engineers review forty-two unrelated pull requests about caching, " +
  "hydrology, typography, orbital mechanics, and sourdough fermentation " +
  "before lunch arrives with ninety-nine unique sandwich combinations for " +
  "every single person in the building today and tomorrow morning. " +
  "Later, a completely different paragraph discusses migratory birds, " +
  "voltage regulators, medieval cartography, and the economics of shade.";

describe("DeviationRuleEngine — rules as data", () => {
  let engine: DeviationRuleEngine;

  beforeEach(() => {
    engine = new DeviationRuleEngine();
    engine.beginPass();
  });

  describe("repetition rule", () => {
    it("fires on degenerate repeated text and reports the rule id + existing status message", () => {
      const verdict = engine.observeTextChunk(DEGENERATE_TEXT);

      expect(verdict).not.toBeNull();
      expect(verdict!.ruleId).toBe(DEVIATION_RULE_IDS.REPETITION);
      expect(verdict!.statusMessage).toBe(STATUS_MESSAGES.REPETITION_DETECTED);
      expect(verdict!.reminderLocaleKey).toBe(
        "harness.deviationRules.repetition",
      );
    });

    it("does not fire on varied text", () => {
      expect(engine.observeTextChunk(VARIED_TEXT)).toBeNull();
    });

    it("beginPass resets accumulated text between passes", () => {
      // Half the degenerate text is not enough on its own after a reset
      const half = DEGENERATE_TEXT.slice(0, DEGENERATE_TEXT.length / 2);
      engine.observeTextChunk(half);
      engine.beginPass();
      expect(engine.observeTextChunk(VARIED_TEXT)).toBeNull();
    });

    it("perturbRetryOptions bumps temperature and repeat penalty for retries", () => {
      const perturbed = engine.perturbRetryOptions(
        DEVIATION_RULE_IDS.REPETITION,
        { temperature: 0.5 },
        1,
      );
      expect(perturbed.temperature).toBeGreaterThan(0.5);
      expect(
        (perturbed as Record<string, unknown>).repeatPenalty,
      ).toBeGreaterThan(1.0);
    });

    it("perturbRetryOptions is a no-op for rules without a perturbation", () => {
      const options = { temperature: 0.5 };
      expect(
        engine.perturbRetryOptions(
          DEVIATION_RULE_IDS.SEMANTIC_STALL,
          options,
          1,
        ),
      ).toBe(options);
    });
  });

  describe("semantic stall rule (pre-emptive)", () => {
    it("fires when a streamed tool call would repeat identically for the 3rd consecutive iteration", () => {
      const repeated = createToolCall("read_file", { path: "/src/app.ts" });
      engine.recordCompletedIteration([repeated]);
      engine.recordCompletedIteration([repeated]);

      const verdict = engine.observeToolCall(
        createToolCall("read_file", { path: "/src/app.ts" }),
      );

      expect(verdict).not.toBeNull();
      expect(verdict!.ruleId).toBe(DEVIATION_RULE_IDS.SEMANTIC_STALL);
      expect(verdict!.statusMessage).toBe(
        STATUS_MESSAGES.SEMANTIC_STALL_DETECTED,
      );
      expect(verdict!.reminderVariables?.toolName).toBe("read_file");
    });

    it("does not fire before enough consecutive identical iterations", () => {
      const repeated = createToolCall("read_file", { path: "/src/app.ts" });
      engine.recordCompletedIteration([repeated]);

      expect(
        engine.observeToolCall(
          createToolCall("read_file", { path: "/src/app.ts" }),
        ),
      ).toBeNull();
    });

    it("does not fire when arguments differ", () => {
      const first = createToolCall("read_file", { path: "/a.ts" });
      engine.recordCompletedIteration([first]);
      engine.recordCompletedIteration([first]);

      expect(
        engine.observeToolCall(createToolCall("read_file", { path: "/b.ts" })),
      ).toBeNull();
    });

    it("a varied iteration in between breaks the consecutive run", () => {
      const repeated = createToolCall("read_file", { path: "/a.ts" });
      engine.recordCompletedIteration([repeated]);
      engine.recordCompletedIteration([
        createToolCall("write_file", { path: "/b.ts" }),
      ]);

      expect(
        engine.observeToolCall(createToolCall("read_file", { path: "/a.ts" })),
      ).toBeNull();
    });
  });

  describe("reminders", () => {
    it("buildReminder resolves the localized rule text with variables", () => {
      const verdict = engine.observeTextChunk(DEGENERATE_TEXT)!;
      const reminder = engine.buildReminder(verdict, "en");
      expect(reminder).toContain("DEVIATION RULE");
      expect(reminder).not.toContain("{{pattern}}");
    });

    it("caveman locale has its own deviation reminder strings", () => {
      const verdict = engine.observeTextChunk(DEGENERATE_TEXT)!;
      const reminder = engine.buildReminder(verdict, "caveman");
      expect(reminder).toContain("DEVIATION RULE");
      expect(reminder).not.toContain("[MISSING:");
    });
  });

  describe("extensibility — rules are data", () => {
    it("a custom rule participates without harness changes", () => {
      const customRule: DeviationRule = {
        id: "no-shouting",
        statusMessage: STATUS_MESSAGES.REPETITION_DETECTED,
        reminderLocaleKey: "harness.deviationRules.repetition",
        onTextChunk(chunkText) {
          return chunkText.includes("AAAA")
            ? { detail: "shouting detected" }
            : null;
        },
      };
      const customEngine = new DeviationRuleEngine([
        customRule,
        ...createDefaultDeviationRules(),
      ]);
      customEngine.beginPass();

      const verdict = customEngine.observeTextChunk("AAAA");
      expect(verdict?.ruleId).toBe("no-shouting");
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Harness integration: abort + rollback (no duplicate final content)
// ────────────────────────────────────────────────────────────────

function createHarness() {
  const state = new AgenticLoopState();
  const emittedEvents: Array<Record<string, unknown>> = [];
  const context = {
    emit: (event: Record<string, unknown>) => emittedEvents.push(event),
    signal: null,
    resolvedModel: "test-model",
    providerName: "test",
    project: "test",
    username: "tester",
    agentConversationId: "session-deviation",
    conversationId: "conv-deviation",
    options: {},
  } as unknown as AgenticContext;
  const tools: ResolvedTools = { finalTools: [], resolvedEnabledTools: [] };
  const harness = new BaseAgenticHarness(context, state, tools);
  return { harness, state, emittedEvents };
}

function createPass(): PassState {
  return {
    streamedText: "",
    finalStreamedText: "",
    streamedThinking: "",
    thinkingSignature: "",
    pendingToolCalls: [],
    streamedImages: [],
    start: performance.now(),
    firstTokenTime: null,
    generationEnd: null,
    thinkingStartTime: null,
    thinkingEndTime: null,
    outputCharacters: 0,
    usage: createUsageAccumulator(),
    options: {},
    requestId: null,
    pendingRequestDocumentIdPromise: Promise.resolve(null),
  };
}

async function* degenerateStream(teardownSpy: { returned: boolean }) {
  try {
    // Yield in chunks so detection happens mid-stream, then keep going —
    // the harness must abort before the stream finishes on its own.
    for (let index = 0; index < 200; index++) {
      yield "I will try to call the tool again now. ";
    }
  } finally {
    teardownSpy.returned = true;
  }
}

describe("BaseAgenticHarness — mid-stream deviation abort", () => {
  it("consumeStream aborts the in-flight stream and stamps pass.deviation", async () => {
    const { harness, state } = createHarness();
    const pass = createPass();
    const teardownSpy = { returned: false };

    await harness.consumeStream(degenerateStream(teardownSpy), pass, new Set());

    expect(pass.deviation).toBeDefined();
    expect(pass.deviation!.ruleId).toBe(DEVIATION_RULE_IDS.REPETITION);
    expect(teardownSpy.returned).toBe(true);
    // The stream was cut off well before its 200 chunks completed
    expect(state.finalStreamedText.length).toBeLessThan(
      200 * "I will try to call the tool again now. ".length,
    );
  });

  it("a streamed tool call repeating past iterations aborts BEFORE recording or disclosing the call", async () => {
    const { harness, state, emittedEvents } = createHarness();
    const pass = createPass();

    const repeated = createToolCall("read_file", { path: "/src/app.ts" });
    harness["deviationEngine"].recordCompletedIteration([repeated]);
    harness["deviationEngine"].recordCompletedIteration([repeated]);

    async function* toolCallStream() {
      yield {
        type: "toolCall",
        id: "tc-repeat",
        name: "read_file",
        args: { path: "/src/app.ts" },
      };
    }

    await harness.consumeStream(toolCallStream(), pass, new Set(["read_file"]));

    expect(pass.deviation?.ruleId).toBe(DEVIATION_RULE_IDS.SEMANTIC_STALL);
    // The cancelled call never reached pass/loop state or the SSE channel
    expect(pass.pendingToolCalls).toHaveLength(0);
    expect(state.streamedToolCalls).toHaveLength(0);
    expect(
      emittedEvents.filter((event) => event.type === "tool_execution"),
    ).toHaveLength(0);
  });

  it("rollbackStreamStateToSnapshot discards the aborted pass's partial content", async () => {
    const { harness, state } = createHarness();

    // A previous, completed pass left content in loop state
    const firstPass = createPass();
    async function* cleanStream() {
      yield "Previous iteration answer. ";
    }
    await harness.consumeStream(cleanStream(), firstPass, new Set());
    const snapshot = harness.captureStreamStateSnapshot();
    const textBefore = state.finalStreamedText;
    const fragmentsBefore = JSON.stringify(state.displayTextFragments);

    // The next pass degenerates and is aborted mid-stream
    const abortedPass = createPass();
    const teardownSpy = { returned: false };
    await harness.consumeStream(
      degenerateStream(teardownSpy),
      abortedPass,
      new Set(),
    );
    expect(abortedPass.deviation).toBeDefined();
    expect(JSON.stringify(state.displayTextFragments)).not.toBe(
      fragmentsBefore,
    );

    harness.rollbackStreamStateToSnapshot(snapshot);

    // No trace of the aborted pass remains in the final-content sources
    expect(state.finalStreamedText).toBe(textBefore);
    expect(JSON.stringify(state.displayTextFragments)).toBe(fragmentsBefore);
    expect(
      state.getCleanDisplayData().cleanTextFragments.join(""),
    ).not.toContain("I will try to call the tool again now.");
  });

  it("a clean retry after rollback produces exactly one copy of the final text", async () => {
    const { harness, state } = createHarness();
    const snapshot = harness.captureStreamStateSnapshot();

    const abortedPass = createPass();
    const teardownSpy = { returned: false };
    await harness.consumeStream(
      degenerateStream(teardownSpy),
      abortedPass,
      new Set(),
    );
    expect(abortedPass.deviation).toBeDefined();

    harness.rollbackStreamStateToSnapshot(snapshot);

    const retryPass = createPass();
    async function* retryStream() {
      yield "Here is the corrected answer.";
    }
    await harness.consumeStream(retryStream(), retryPass, new Set());

    expect(retryPass.deviation).toBeUndefined();
    expect(state.finalStreamedText).toBe("Here is the corrected answer.");
    const { cleanTextFragments } = state.getCleanDisplayData();
    expect(cleanTextFragments).toEqual(["Here is the corrected answer."]);
  });
});
