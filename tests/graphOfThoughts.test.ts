import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import { runGraphOfThoughts } from "../src/services/harnesses/strategies/GraphOfThoughtsStrategy.ts";
import { APPROVAL_TIERS } from "../src/services/AutoApprovalEngine.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

// Mock logger to avoid printing in tests
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("GraphOfThoughtsStrategy", () => {
  let mockProvider: any;
  let mockHarnessInstance: any;
  let mockAgenticContext: any;
  let mockAgenticLoopState: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* (messages: any[]) {
        const lastMessage = messages[messages.length - 1]?.content || "";
        if (lastMessage.includes("Rate each candidate approach")) {
          // Response for scoring
          yield "1: correctness=8, risk=9, efficiency=7, completeness=8\n2: correctness=5, risk=8, efficiency=6, completeness=7";
        } else if (lastMessage.includes("GRAPH-OF-THOUGHTS SYNTHESIS PASS")) {
          // Response for synthesis
          yield "Synthesized graph thoughts output";
        } else {
          // Response for branch generation
          yield "Thought branch output";
        }
      }),
    };

    mockAgenticContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
      conversationId: "conv-id-789",
      emit: vi.fn(),
      provider: mockProvider,
      options: {
        branchCount: 2,
        autoApprove: true,
      },
      messages: [
        { role: "user", content: "Perform Graph of Thoughts optimization" },
      ],
    };

    mockAgenticLoopState = {
      iterations: 0,
      branchesExplored: 0,
      branchesBacktracked: 0,
      selectedBranchScores: [],
      originalMessageCount: 1,
      planModeActive: false,
      planModeText: "",
      frontierCandidates: [],
      toolErrorCounts: new Map(),
      streamedToolCalls: [],
    };

    mockHarnessInstance = {
      context: mockAgenticContext,
      state: mockAgenticLoopState,
      tools: {
        finalTools: [
          { name: "read_file", description: "Read file contents" },
        ],
        resolvedEnabledTools: ["read_file"],
      },
      enforceContextWindow: vi.fn().mockImplementation((messages) => messages),
      createPassState: vi.fn().mockImplementation((options) => ({
        streamedText: "Thought branch output",
        finalStreamedText: "Thought branch output",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        generationEnd: null,
        outputCharacters: 0,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-1",
      })),
      registerTrackerRequest: vi.fn(),
      createProviderStream: vi.fn().mockImplementation(() => mockProvider.generateTextStream([], "", {})),
      consumeStream: vi.fn().mockImplementation(async (stream, passState) => {
        passState.streamedText = "Thought branch output";
        passState.finalStreamedText = "Thought branch output";
      }),
      logIteration: vi.fn(),
      emitGenerationProgress: vi.fn(),
      emitUsageUpdate: vi.fn(),
      checkAndApplyToolSetChanges: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("should successfully run graph of thoughts thought structure with synthesis pass", async () => {
    const result = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(1);
    expect(mockAgenticLoopState.branchesExplored).toBe(2);
    expect(mockHarnessInstance.finalize).toHaveBeenCalled();
    expect(result.messages).toBeDefined();
  });

  it("should abort run Graph of Thoughts early when signal is aborted", async () => {
    const abortController = new AbortController();
    mockAgenticContext.signal = abortController.signal;
    abortController.abort();

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result.messages.length).toBe(1);
    expect(mockAgenticLoopState.iterations).toBe(1);
  });

  it("should successfully run graph of thoughts when branchCount is 1, skipping synthesis pass", async () => {
    mockAgenticContext.options.branchCount = 1;

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(1);
    expect(mockAgenticLoopState.iterations).toBe(1);
  });

  it("should handle planning mode, block unauthorized tool calls, and exit plan mode successfully when auto-approved", async () => {
    mockAgenticLoopState.planModeActive = true;
    mockAgenticContext.options.autoApprove = true;
    mockAgenticContext.options.maxIterations = 1;
    mockAgenticContext.options.branchCount = 2;

    let passStateCreationCount = 0;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      passStateCreationCount++;
      if (passStateCreationCount === 1) {
        return {
          streamedText: "Let's read some files first.",
          finalStreamedText: "Let's read some files first.",
          streamedThinking: "",
          thinkingSignature: "",
          pendingToolCalls: [{ id: "call-1", name: "read_file", args: {} }],
          streamedImages: [],
          start: Date.now(),
          firstTokenTime: null,
          generationEnd: null,
          outputCharacters: 0,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
          options,
          requestId: "req-plan-1",
        };
      } else if (passStateCreationCount === 2) {
        return {
          streamedText: "Exiting planning mode now.",
          finalStreamedText: "Exiting planning mode now.",
          streamedThinking: "",
          thinkingSignature: "",
          pendingToolCalls: [{ id: "call-2", name: "exit_plan_mode", args: {} }],
          streamedImages: [],
          start: Date.now(),
          firstTokenTime: null,
          generationEnd: null,
          outputCharacters: 0,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
          options,
          requestId: "req-plan-2",
        };
      } else {
        return {
          streamedText: "Branch output.",
          finalStreamedText: "Branch output.",
          streamedThinking: "",
          thinkingSignature: "",
          pendingToolCalls: [],
          streamedImages: [],
          start: Date.now(),
          firstTokenTime: null,
          generationEnd: null,
          outputCharacters: 0,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
          options,
          requestId: "req-branch",
        };
      }
    });

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.planModeActive).toBe(false); // Exited plan mode
    // passStateCreationCount should be: 2 for planning, 2 for parallel BFS branches, 1 for synthesis pass = 5
    expect(passStateCreationCount).toBe(5);
  });

  it("should catch and propagate loop execution errors", async () => {
    mockHarnessInstance.consumeStream = vi.fn().mockRejectedValue(new Error("Mock network timeout"));

    await expect(runGraphOfThoughts(mockHarnessInstance as any)).rejects.toThrow("Mock network timeout");
  });
});
