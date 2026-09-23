/**
 * Prompt 17, Landing 3 — independent branches (arXiv 2608.23541: agents that
 * read each other's solutions converge within a round) and reviewer
 * authority (2609.14767: a reviewer's reject/redo pays only when it can
 * verify the work).
 *
 * The provider is scripted; every branch writes a unique marker, and the
 * assertions read the payloads branch GENERATION sent to it: a marker may
 * reach a later generation only as committed history (an assistant message
 * the turn kept), never as a sibling's output handed over in a prompt.
 *
 * On master: Tree-of-Thoughts DFS put each pruned sibling's text into the
 * next sibling's prompt ("these approaches FAILED"), and the LLM scorer —
 * which reads 500-character previews and runs nothing — discarded every
 * branch below its threshold and forced a redo (ToT and GoT), ToT carrying
 * the discarded branch's text into the re-branch. Graph-of-Thoughts never
 * leaked a sibling into a generation prompt (its synthesis pass reads them
 * all, after scoring, by design).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import { runTreeOfThoughts } from "#src/services/harnesses/strategies/TreeOfThoughtsStrategy";
import { runGraphOfThoughts } from "#src/services/harnesses/strategies/GraphOfThoughtsStrategy";
import { validateAfterToolExecution } from "#src/services/harnesses/lifecycle/ValidationInterceptor";
import AgenticLoopState from "#src/services/AgenticLoopState";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/ExhaustionRecovery", () => ({
  runExhaustionRecoveryPass: vi.fn().mockResolvedValue({ messages: [] }),
}));
vi.mock("#src/services/harnesses/lifecycle/ApprovalGate", () => ({
  checkAndWaitForApproval: vi.fn().mockImplementation(async (toolCalls: unknown[]) => ({
    executableToolCalls: toolCalls,
    blockedResults: [],
    deniedToolCalls: [],
    shouldApproveAll: false,
  })),
  orderResultsLikeCalls: (_toolCalls: unknown[], results: unknown[]) => results,
  approvalRecordFor: () => ({}),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
  executeToolBatch: vi.fn().mockImplementation(async (toolCalls: Array<{ id: string; name: string }>) =>
    toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { content: "file text" } })),
  ),
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
  },
}));

const MARKER = /branch-output-\d+/g;
const SCORING = "Rate each candidate approach";
const SYNTHESIS = "[GRAPH-OF-THOUGHTS SYNTHESIS PASS]";

interface Script {
  /** Whether branch generation at this iteration proposes a tool call. */
  callsToolAt: (iteration: number) => boolean;
  /** The score (1–10) every candidate gets at this iteration; DFS scores one at a time. */
  scoreAt: (iteration: number, candidateMarkers: string[]) => number;
}

function buildHarness(options: Record<string, unknown>, script: Script) {
  const generationPayloads: Array<{ iteration: number; messages: Array<{ role: string; content: string }> }> = [];
  let branchCounter = 0;

  // The real loop state — a hand-written one hid a field the strategies read.
  const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: false });

  const provider = {
    generateTextStream: vi.fn().mockImplementation(async function* (
      messages: Array<{ role: string; content: string }>,
    ) {
      const iteration = state.iterations;
      const last = String(messages[messages.length - 1]?.content ?? "");
      if (last.includes(SCORING)) {
        const candidates = last.match(MARKER) ?? [];
        const score = script.scoreAt(iteration, candidates);
        const count = (last.match(/\[Candidate \d+\]/g) ?? []).length;
        yield Array.from(
          { length: count },
          (_, index) => `${index + 1}: correctness=${score}, risk=${score}, efficiency=${score}, completeness=${score}`,
        ).join("\n");
        return;
      }
      const marker = `branch-output-${++branchCounter}`;
      if (!last.includes(SYNTHESIS)) {
        generationPayloads.push({ iteration, messages: structuredClone(messages) });
      }
      yield `${marker}: my approach.`;
      if (script.callsToolAt(iteration)) {
        yield { toolCall: { id: `call-${marker}`, name: "read_file", args: { path: "a.ts" } } };
      }
    }),
  };

  const context = {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3.6-flash",
    agentConversationId: "branching-session",
    conversationId: "branching-conversation",
    emit: vi.fn(),
    provider,
    options: { autoApprove: true, ...options },
    messages: [{ role: "user", content: "Fix the bug in a.ts" }],
  };

  const harness = {
    context,
    state,
    tools: {
      finalTools: [{ name: "read_file", description: "Read a file" }],
      resolvedEnabledTools: ["read_file"],
    },
    enforceContextWindow: vi.fn().mockImplementation((messages) => messages),
    estimateRequestOverheadTokens: vi.fn().mockReturnValue(0),
    createPassState: vi.fn().mockImplementation((passOptions) => ({
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [],
      streamedImages: [],
      start: Date.now(),
      firstTokenTime: null,
      generationEnd: null,
      outputCharacters: 0,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
      options: passOptions,
      requestId: "",
    })),
    registerTrackerRequest: vi.fn(),
    createProviderStream: vi.fn().mockImplementation((messages, passOptions) =>
      provider.generateTextStream(messages, "", passOptions),
    ),
    consumeStream: vi.fn().mockImplementation(async (stream, pass) => {
      for await (const chunk of stream) {
        if (typeof chunk === "string") {
          pass.streamedText += chunk;
          pass.finalStreamedText += chunk;
        } else if (chunk?.toolCall) {
          pass.pendingToolCalls.push(chunk.toolCall);
        }
      }
    }),
    logIteration: vi.fn(),
    emitGenerationProgress: vi.fn(),
    emitUsageUpdate: vi.fn(),
    requestToolOptions(this: { tools: { finalTools: unknown[] } }) {
      return { tools: this.tools.finalTools };
    },
    checkAndApplyToolSetChanges: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
  };

  return { harness, state, generationPayloads };
}

/**
 * Branch outputs a generation prompt carried OUTSIDE committed assistant
 * history — i.e. a sibling's work handed to it. Committed history is the
 * turn's own path, which every later branch builds on.
 */
function siblingLeaks(payloads: Array<{ iteration: number; messages: Array<{ role: string; content: string }> }>) {
  const leaks: string[] = [];
  for (const [index, payload] of payloads.entries()) {
    for (const message of payload.messages) {
      if (message.role === "assistant") continue;
      for (const marker of String(message.content).match(MARKER) ?? []) {
        leaks.push(`generation #${index + 1} (iteration ${payload.iteration}) got ${marker} in a ${message.role} message`);
      }
    }
  }
  return leaks;
}

beforeEach(() => {
  vi.mocked(validateAfterToolExecution).mockReset();
  vi.mocked(validateAfterToolExecution).mockResolvedValue([]);
});

describe("Tree of Thoughts — siblings are generated independently", () => {
  it("DFS: a pruned sibling's output never reaches the next sibling's prompt", async () => {
    // Siblings 1 and 2 score below the threshold, sibling 3 above it.
    const { harness, generationPayloads } = buildHarness(
      { searchStrategy: "dfs", branchCount: 3, valueThreshold: 5 },
      {
        callsToolAt: () => false,
        scoreAt: (_iteration, candidates) => (candidates.includes("branch-output-3") ? 9 : 2),
      },
    );

    await runTreeOfThoughts(harness as never);

    expect(generationPayloads).toHaveLength(3);
    expect(siblingLeaks(generationPayloads)).toEqual([]);
    // Each sibling still gets its own diversity instruction.
    expect(JSON.stringify(generationPayloads[1].messages)).toContain("[BRANCH 2/3]");
  });

  it("BFS: a round the scorer rates low is not thrown away and redone — the best branch runs", async () => {
    // Iteration 1 commits a tool call; at iteration 2 every branch scores 2
    // (below the 5.0 threshold); iteration 3 answers.
    const { harness, state, generationPayloads } = buildHarness(
      { searchStrategy: "bfs", branchCount: 2, valueThreshold: 5, maxIterations: 5 },
      {
        callsToolAt: (iteration) => iteration < 3,
        scoreAt: (iteration) => (iteration === 2 ? 2 : 8),
      },
    );

    const { messages } = await runTreeOfThoughts(harness as never);

    expect(siblingLeaks(generationPayloads)).toEqual([]);
    // The low-rated round's best branch was executed, not discarded.
    expect(state.iterations).toBe(3);
    const committedToolCalls = messages.filter(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    expect(committedToolCalls).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("PROACTIVE BACKTRACK");
  });

  it("a VERIFIED failure keeps its redo authority: the validator's errors reach the re-branch", async () => {
    vi.mocked(validateAfterToolExecution)
      .mockResolvedValueOnce([
        { filePath: "a.ts", validatorType: "typescript", rawOutput: "TS2322: Type 'string' is not assignable", toolName: "write_file", errors: [] },
      ] as never)
      .mockResolvedValue([]);
    const { harness, generationPayloads } = buildHarness(
      { searchStrategy: "bfs", branchCount: 2, valueThreshold: 5, maxIterations: 4 },
      { callsToolAt: (iteration) => iteration < 3, scoreAt: () => 8 },
    );

    await runTreeOfThoughts(harness as never);

    const reBranch = generationPayloads.find((payload) => payload.iteration === 2)!;
    expect(JSON.stringify(reBranch.messages)).toContain("TS2322");
  });
});

describe("Graph of Thoughts — siblings are generated independently", () => {
  it("generation prompts never carry a sibling's output (synthesis reads them after scoring)", async () => {
    const { harness, generationPayloads } = buildHarness(
      { branchCount: 3, valueThreshold: 5, maxIterations: 4 },
      { callsToolAt: (iteration) => iteration < 2, scoreAt: () => 8 },
    );

    await runGraphOfThoughts(harness as never);

    expect(generationPayloads.length).toBeGreaterThanOrEqual(5);
    expect(siblingLeaks(generationPayloads)).toEqual([]);
  });

  it("a round the scorer rates low is synthesized from its best branch, not thrown away and redone", async () => {
    const { harness, state, generationPayloads } = buildHarness(
      { branchCount: 2, valueThreshold: 5, maxIterations: 5 },
      {
        callsToolAt: (iteration) => iteration < 3,
        scoreAt: (iteration) => (iteration === 2 ? 2 : 8),
      },
    );

    const { messages } = await runGraphOfThoughts(harness as never);

    expect(state.iterations).toBe(3);
    expect(generationPayloads.filter((payload) => payload.iteration === 2)).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("PROACTIVE BACKTRACK");
  });
});
