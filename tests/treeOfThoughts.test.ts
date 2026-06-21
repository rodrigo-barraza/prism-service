import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import { runTreeOfThoughts } from "../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";
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

describe("TreeOfThoughtsStrategy", () => {
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
          yield "1: correctness=9, risk=9, efficiency=9, completeness=9\n2: correctness=4, risk=8, efficiency=5, completeness=6";
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
        searchStrategy: "bfs",
        autoApprove: true,
      },
      messages: [
        { role: "user", content: "Implement target feature" },
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

  it("should successfully run tree of thoughts thought structure and choose highest scored branch", async () => {
    const result = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(1);
    expect(mockAgenticLoopState.branchesExplored).toBe(2); // 2 branches configured
    expect(result.messages).toBeDefined();
  });

  it("should abort run Tree of Thoughts early when signal is aborted", async () => {
    const abortController = new AbortController();
    mockAgenticContext.signal = abortController.signal;
    abortController.abort();

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result.messages.length).toBe(1); // Unchanged
    expect(mockAgenticLoopState.iterations).toBe(1);
  });

  it("should run sequential sibling exploration in DFS mode and accept sibling immediately if above threshold", async () => {
    mockAgenticContext.options.searchStrategy = "dfs";
    mockAgenticContext.options.branchCount = 3;
    mockAgenticContext.options.valueThreshold = 8.0;

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(1); // Accepted first sibling immediately (score 10 >= 8.0)
    expect(mockAgenticLoopState.branchesBacktracked).toBe(0);
  });

  it("should run sequential sibling exploration in DFS mode, backtrack, and fall back to best sibling if none exceed threshold", async () => {
    mockAgenticContext.options.searchStrategy = "dfs";
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.valueThreshold = 12.0; // All siblings get 10, so both will be pruned (10 < 12.0)

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(2); // Explored both siblings
    expect(mockAgenticLoopState.branchesBacktracked).toBe(2); // Pruned both siblings
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
      } else {
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
      }
    });

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.planModeActive).toBe(false); // Successfully exited plan mode
    expect(passStateCreationCount).toBe(4); // 2 for planning, 2 for parallel BFS branches in main loop iteration
  });
});
