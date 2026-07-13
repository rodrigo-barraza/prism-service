/**
 * Synthesis orchestration — regression tests (audit H3).
 *
 * The turn loop moved server-side from the client's SynthesisComponent.
 * These tests pin the loop semantics that used to live in the browser:
 * turn alternation, role-swapped simulator history with the local-model
 * alternation fix, persona prompt, seed handling, conversationMeta only on
 * the record-creating append, final ensure-assistant turn, error/abort
 * behavior, and the SSE framing protocol.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: vi.fn(),
}));
vi.mock("#src/utils/ConversationUtilities", () => ({
  appendAndFinalize: vi.fn(),
}));
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  runSynthesisGeneration,
  buildSimulatorHistory,
  buildUserSimulationPrompt,
  type SynthesisGenerateInput,
} from "#src/services/SynthesisOrchestrationService";
import type { SseEvent } from "#src/types/SseTypes";

// ── Helpers ────────────────────────────────────────────────

function makeInput(
  overrides: Partial<SynthesisGenerateInput> = {},
): SynthesisGenerateInput {
  return {
    conversationId: "conv-1",
    systemPrompt: "You are a helpful assistant.",
    userPersona: "",
    category: "Chat",
    targetTurns: 1,
    seedMessages: [],
    settings: { provider: "openai", model: "gpt-test", temperature: 0.7 },
    saveRun: true,
    project: "test-project",
    username: "tester",
    ...overrides,
  };
}

/** Fake /chat pipeline: emits a chunk per call and resolves. */
function makeGenerateTurn(replies: string[]) {
  let callIndex = 0;
  const calls: Record<string, unknown>[] = [];
  const generateTurn = vi.fn(
    async (
      params: Record<string, unknown>,
      emit: (event: { type: string; [key: string]: unknown }) => void,
    ) => {
      calls.push(params);
      const reply = replies[Math.min(callIndex, replies.length - 1)];
      callIndex++;
      emit({ type: "chunk", content: reply });
      emit({ type: "done" });
    },
  );
  return { generateTurn, calls };
}

// ── Prompt / history builders ──────────────────────────────

describe("buildUserSimulationPrompt", () => {
  it("embeds the persona when provided", () => {
    const prompt = buildUserSimulationPrompt("A grumpy sysadmin");
    expect(prompt).toContain("A grumpy sysadmin");
    expect(prompt).toContain("Generate ONLY the next user message");
  });

  it("falls back to the default casual persona", () => {
    const prompt = buildUserSimulationPrompt("  ");
    expect(prompt).toContain("casual, curious human");
  });
});

describe("buildSimulatorHistory", () => {
  it("returns the conversation-starter prompt for an empty history", () => {
    const history = buildSimulatorHistory([]);
    expect(history).toEqual([
      {
        role: "user",
        content: "Start the conversation. Send the first message as the user.",
      },
    ]);
  });

  it("role-swaps and prepends a user message when the swap starts with assistant", () => {
    const history = buildSimulatorHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    // "hi" (user) becomes assistant → must be preceded by a user message
    expect(history[0]).toEqual({
      role: "user",
      content:
        "Continue the conversation. Generate the next natural user message.",
    });
    expect(history[1]).toEqual({ role: "assistant", content: "hi" });
    expect(history[2]).toEqual({ role: "user", content: "hello!" });
  });

  it("keeps a swap that already starts with user", () => {
    const history = buildSimulatorHistory([
      { role: "assistant", content: "welcome" },
    ]);
    expect(history).toEqual([{ role: "user", content: "welcome" }]);
  });
});

// ── The loop ───────────────────────────────────────────────

describe("runSynthesisGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alternates simulated-user and assistant turns and frames them with SSE events", async () => {
    const { generateTurn, calls } = makeGenerateTurn([
      "simulated user question",
      "genuine assistant answer",
    ]);
    const appendMessages = vi.fn().mockResolvedValue(undefined);
    const saveSynthesisRun = vi.fn().mockResolvedValue(undefined);
    const events: SseEvent[] = [];

    await runSynthesisGeneration(
      makeInput({ targetTurns: 1 }),
      (event) => events.push(event),
      {},
      { generateTurn, appendMessages, saveSynthesisRun },
    );

    // Two turns: user (simulator) then assistant
    expect(generateTurn).toHaveBeenCalledTimes(2);

    // First call: the simulator — skipConversation, persona system prompt
    expect(calls[0].skipConversation).toBe(true);
    expect(calls[0].conversationId).toBeUndefined();
    const simulatorMessages = calls[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(simulatorMessages[0].role).toBe("system");
    expect(simulatorMessages[0].content).toContain(
      "simulating a human user",
    );

    // Second call: the assistant — real system prompt + history, persisted
    expect(calls[1].conversationId).toBe("conv-1");
    const assistantMessages = calls[1].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(assistantMessages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(assistantMessages[1]).toEqual({
      role: "user",
      content: "simulated user question",
    });

    // Event framing
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "synthesis_start",
      "turn_start",
      "chunk",
      "turn_complete",
      "turn_start",
      "chunk",
      "turn_complete",
      "done",
    ]);
    const doneEvent = events.at(-1) as SseEvent & { synthesisRunId?: string };
    expect(doneEvent.conversationId).toBe("conv-1");
    expect(doneEvent.synthesisRunId).toBeTruthy();

    // The simulated user message is appended WITH meta (record-creating
    // append — no seeds existed); the assistant is persisted by /chat itself.
    expect(appendMessages).toHaveBeenCalledTimes(1);
    const [, , , appendedMessages, meta] = appendMessages.mock.calls[0];
    expect(appendedMessages[0]).toMatchObject({
      role: "user",
      content: "simulated user question",
    });
    expect(meta).toMatchObject({ synthetic: true });

    // Run document saved with the conversation link
    expect(saveSynthesisRun).toHaveBeenCalledTimes(1);
    expect(saveSynthesisRun.mock.calls[0][0]).toMatchObject({
      conversationId: "conv-1",
      project: "test-project",
      username: "tester",
      targetTurns: 1,
    });
  });

  it("persists seed messages with meta first, then omits meta on later appends", async () => {
    const { generateTurn, calls } = makeGenerateTurn(["reply"]);
    const appendMessages = vi.fn().mockResolvedValue(undefined);
    const events: SseEvent[] = [];

    await runSynthesisGeneration(
      makeInput({
        targetTurns: 1,
        seedMessages: [
          { role: "user", content: "seeded question" },
          { role: "assistant", content: "" }, // empty — filtered
        ],
      }),
      (event) => events.push(event),
      {},
      { generateTurn, appendMessages },
    );

    // Seeds appended first with meta (creates the record)
    const [, , , seedAppend, seedMeta] = appendMessages.mock.calls[0];
    expect(seedAppend).toHaveLength(1);
    expect(seedAppend[0]).toMatchObject({ role: "user", content: "seeded question" });
    expect(seedMeta).toMatchObject({ synthetic: true });

    // Seed ends with user → the single remaining turn is the assistant,
    // and its payload must NOT carry conversationMeta (record exists).
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(calls[0].conversationMeta).toBeUndefined();
    expect(calls[0].conversationId).toBe("conv-1");
  });

  it("appends a final assistant turn when the loop would end on a user message", async () => {
    const { generateTurn, calls } = makeGenerateTurn(["assistant closes"]);
    const appendMessages = vi.fn().mockResolvedValue(undefined);

    // targetTurns=1 with a full seeded pair ending in "user" → remaining=0,
    // but the conversation must still end with an assistant message.
    await runSynthesisGeneration(
      makeInput({
        targetTurns: 1,
        seedMessages: [
          { role: "assistant", content: "welcome" },
          { role: "user", content: "still waiting on an answer" },
        ],
      }),
      () => {},
      {},
      { generateTurn, appendMessages },
    );

    expect(generateTurn).toHaveBeenCalledTimes(1);
    const finalMessages = calls[0].messages as Array<{ role: string }>;
    expect(finalMessages.at(-1)?.role).toBe("user");
  });

  it("stops and emits error when a turn fails, without saving the run", async () => {
    const generateTurn = vi.fn(
      async (
        _params: Record<string, unknown>,
        emit: (event: { type: string; [key: string]: unknown }) => void,
      ) => {
        emit({ type: "error", message: "provider exploded" });
      },
    );
    const saveSynthesisRun = vi.fn();
    const events: SseEvent[] = [];

    await runSynthesisGeneration(
      makeInput({ targetTurns: 2 }),
      (event) => events.push(event),
      {},
      { generateTurn, appendMessages: vi.fn(), saveSynthesisRun },
    );

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "provider exploded",
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(saveSynthesisRun).not.toHaveBeenCalled();
  });

  it("stops without saving when aborted mid-run", async () => {
    const abortController = new AbortController();
    const generateTurn = vi.fn(
      async (
        _params: Record<string, unknown>,
        emit: (event: { type: string; [key: string]: unknown }) => void,
      ) => {
        emit({ type: "chunk", content: "partial" });
        abortController.abort();
      },
    );
    const saveSynthesisRun = vi.fn();
    const events: SseEvent[] = [];

    await runSynthesisGeneration(
      makeInput({ targetTurns: 3 }),
      (event) => events.push(event),
      { signal: abortController.signal },
      { generateTurn, appendMessages: vi.fn(), saveSynthesisRun },
    );

    // Aborted during the first turn — no further turns, no run save
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(saveSynthesisRun).not.toHaveBeenCalled();
  });

  it("uses the separate user-simulator model for user turns when provided", async () => {
    const { generateTurn, calls } = makeGenerateTurn(["q", "a"]);

    await runSynthesisGeneration(
      makeInput({
        targetTurns: 1,
        userSimSettings: {
          provider: "ollama",
          model: "sim-model",
          temperature: 1.1,
        },
      }),
      () => {},
      {},
      { generateTurn, appendMessages: vi.fn() },
    );

    // User turn uses the simulator model; assistant turn uses the main model
    expect(calls[0]).toMatchObject({
      provider: "ollama",
      model: "sim-model",
      temperature: 1.1,
    });
    expect(calls[1]).toMatchObject({ provider: "openai", model: "gpt-test" });
  });

  it("disables thinking by default for non-lm-studio providers and enables it for lm-studio", async () => {
    const { generateTurn, calls } = makeGenerateTurn(["q", "a"]);
    await runSynthesisGeneration(
      makeInput({ targetTurns: 1 }),
      () => {},
      {},
      { generateTurn, appendMessages: vi.fn() },
    );
    expect(calls[0].thinkingEnabled).toBe(false);

    const lmStudio = makeGenerateTurn(["q", "a"]);
    await runSynthesisGeneration(
      makeInput({
        targetTurns: 1,
        settings: { provider: "lm-studio", model: "local-model" },
      }),
      () => {},
      {},
      { generateTurn: lmStudio.generateTurn, appendMessages: vi.fn() },
    );
    expect(lmStudio.calls[0].thinkingEnabled).toBe(true);
  });
});
