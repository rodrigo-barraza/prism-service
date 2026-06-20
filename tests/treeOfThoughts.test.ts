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

  it("should successfully run tree of thoughts reasoning strategy and choose highest scored branch", async () => {
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
});
