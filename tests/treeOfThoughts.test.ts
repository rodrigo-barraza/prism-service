import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import { runTreeOfThoughts } from "../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";
import { APPROVAL_TIERS } from "../src/services/AutoApprovalEngine.ts";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { runExhaustionRecoveryPass } from "../src/services/harnesses/lifecycle/ExhaustionRecovery.ts";
import { validateAfterToolExecution } from "../src/services/harnesses/lifecycle/ValidationInterceptor.ts";
import { isOutputTruncated } from "../src/services/harnesses/lifecycle/OutputTruncationRecovery.ts";
import { checkCostBudget } from "../src/services/harnesses/lifecycle/CostBudgetEnforcer.ts";
import { checkAndWaitForApproval } from "../src/services/harnesses/lifecycle/ApprovalGate.ts";
import { handleCodexPlanningResponse } from "../src/services/harnesses/lifecycle/CodexPlanningDetector.ts";
import { handleExitPlanMode } from "../src/services/harnesses/lifecycle/PlanModeController.ts";
import RequestLogger from "../src/services/RequestLogger.ts";

vi.mock("../src/services/harnesses/lifecycle/PlanModeController.ts", async () => {
  const actual = await vi.importActual("../src/services/harnesses/lifecycle/PlanModeController.ts") as any;
  return {
    ...actual,
    handleExitPlanMode: vi.fn().mockImplementation((...args) => actual.handleExitPlanMode(...args)),
  };
});


// Mock logger to avoid printing in tests
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/services/harnesses/lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: vi.fn().mockReturnValue("mock-stash-ref"),
  restoreSandboxCheckpoint: vi.fn(),
}));

vi.mock("../src/services/harnesses/lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/harnesses/lifecycle/OutputTruncationRecovery.ts", () => ({
  isOutputTruncated: vi.fn().mockReturnValue(false),
  injectContinuationContext: vi.fn().mockReturnValue(100),
  injectErrorAsConversationMessage: vi.fn(),
  buildProviderErrorMessage: vi.fn().mockReturnValue("provider-error"),
  buildExhaustedRecoveryMessage: vi.fn().mockReturnValue("exhausted-error"),
  MAX_OUTPUT_TRUNCATION_RECOVERIES: 3,
}));

vi.mock("../src/services/harnesses/lifecycle/ExhaustionRecovery.ts", () => ({
  runExhaustionRecoveryPass: vi.fn().mockResolvedValue({ messages: [] }),
}));

vi.mock("../src/services/harnesses/lifecycle/CostBudgetEnforcer.ts", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/services/harnesses/lifecycle/ApprovalGate.ts", () => ({
  checkAndWaitForApproval: vi.fn().mockResolvedValue({ isApproved: true, shouldApproveAll: false }),
}));

vi.mock("../src/services/harnesses/lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/services/harnesses/lifecycle/HookInitializer.ts", async () => {
  const actual = await vi.importActual("../src/services/harnesses/lifecycle/HookInitializer.ts") as any;
  return {
    ...actual,
    createStandardHooks: vi.fn().mockImplementation((opts) => {
      const result = actual.createStandardHooks(opts);
      const originalRun = result.hooks.run.bind(result.hooks);
      result.hooks.run = async (name: string, context: any) => {
        await originalRun(name, context);
        if (name === "beforePrompt") {
          context._assembledSystemPrompt = "injected-system-prompt-test";
          context._injectedSkills = ["skill-test-1", "skill-test-2"];
        }
      };
      return result;
    })
  };
});


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
      proactiveBacktracks: 0,
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
      createProviderStream: vi.fn().mockImplementation((messages, options) => mockProvider.generateTextStream(messages, "", options)),
      consumeStream: vi.fn().mockImplementation(async (stream, passState) => {
        let text = "";
        for await (const chunk of stream) {
          if (typeof chunk === "string") {
            text += chunk;
          }
        }
        if (text) {
          passState.streamedText = text;
          passState.finalStreamedText = text;
        } else {
          passState.streamedText = "Thought branch output";
          passState.finalStreamedText = "Thought branch output";
        }
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

  it("should generate N branches and score them, and retain top-b branches in BFS mode", async () => {
    mockAgenticContext.options.branchCount = 4;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.valueThreshold = 5.0;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=8, efficiency=8, completeness=8\n2: correctness=4, risk=4, efficiency=4, completeness=4\n3: correctness=6, risk=6, efficiency=6, completeness=6\n4: correctness=3, risk=3, efficiency=3, completeness=3";
      } else {
        yield "Thought branch output";
      }
    });

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(4);
    expect(mockAgenticLoopState.frontierCandidates.length).toBe(1);
    expect(mockAgenticLoopState.frontierCandidates[0].score).toBeCloseTo(6.0, 5);
  });

  it("should fall back to next frontier candidate on validation failure in BFS mode", async () => {
    mockAgenticContext.workspaceRoot = "/workspace/mock";
    mockAgenticContext.options.branchCount = 3;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.valueThreshold = 5.0;
    mockAgenticContext.options.enableSandbox = true;
    mockAgenticContext.options.maxIterations = 1;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=8, efficiency=8, completeness=8\n2: correctness=6, risk=6, efficiency=6, completeness=6\n3: correctness=4, risk=4, efficiency=4, completeness=4";
      } else {
        yield "Thought branch output";
      }
    });

    let passStateCreationCount = 0;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      passStateCreationCount++;
      return {
        streamedText: "Thought branch output " + passStateCreationCount,
        finalStreamedText: "Thought branch output " + passStateCreationCount,
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [{ id: "call-" + passStateCreationCount, name: "read_file", args: {} }],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        generationEnd: null,
        outputCharacters: 0,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-" + passStateCreationCount,
      };
    });

    vi.mocked(validateAfterToolExecution)
      .mockResolvedValueOnce([{ filePath: "test.ts", validatorType: "lint", rawOutput: "Lint error", toolName: "read_file", errors: ["Lint error"] }])
      .mockResolvedValueOnce([]);

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(validateAfterToolExecution).toHaveBeenCalledTimes(1);
    expect(mockAgenticLoopState.branchesBacktracked).toBe(1);
    expect(mockAgenticLoopState.frontierCandidates.length).toBe(0);
  });

  it("should re-branch after all frontier candidates fail in BFS mode", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.valueThreshold = 5.0;
    mockAgenticContext.options.enableSandbox = true;
    mockAgenticContext.options.maxIterations = 2;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=8, efficiency=8, completeness=8\n2: correctness=6, risk=6, efficiency=6, completeness=6";
      } else {
        yield "Thought branch output";
      }
    });

    let passStateCreationCount = 0;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      passStateCreationCount++;
      return {
        streamedText: "Branch output",
        finalStreamedText: "Branch output",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [{ id: "call-" + passStateCreationCount, name: "read_file", args: {} }],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        generationEnd: null,
        outputCharacters: 0,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-" + passStateCreationCount,
      };
    });

    vi.mocked(validateAfterToolExecution)
      .mockResolvedValueOnce([{ filePath: "test.ts", validatorType: "lint", rawOutput: "Error 1", toolName: "read_file", errors: ["Error 1"] }])
      .mockResolvedValueOnce([{ filePath: "test.ts", validatorType: "lint", rawOutput: "Error 2", toolName: "read_file", errors: ["Error 2"] }]);

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(2);
  });

  it("should explore DFS siblings sequentially and handle budget exhaustion", async () => {
    mockAgenticContext.options.searchStrategy = "dfs";
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.valueThreshold = 12.0;

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(2);
    expect(mockAgenticLoopState.branchesBacktracked).toBe(2);
  });

  it("should perform proactive backtracking when all branches score below threshold in BFS mode", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.valueThreshold = 8.0;
    mockAgenticContext.options.maxIterations = 2;
    mockAgenticLoopState.iterations = 1;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=4, risk=4, efficiency=4, completeness=4\n2: correctness=4, risk=4, efficiency=4, completeness=4";
      } else {
        yield "Low score branch output";
      }
    });

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesBacktracked).toBe(1);
    expect(treeOfThoughtsResult.messages.some((msg: any) => msg.content && msg.content.includes("PROACTIVE BACKTRACK"))).toBe(true);
  });

  it("should execute tools and carry results back in tree of thoughts", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      return {
        streamedText: "Use a tool first.",
        finalStreamedText: "Use a tool first.",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [{ id: "call-tool", name: "read_file", args: {} }],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-tool",
      };
    });

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(treeOfThoughtsResult).toBeDefined();
  });

  it("should handle output truncation and execute exhaustion recovery pass", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.searchStrategy = "bfs";
    mockAgenticContext.options.maxIterations = 5;

    vi.mocked(isOutputTruncated).mockReturnValueOnce(true).mockReturnValue(false);

    mockAgenticLoopState.iterations = 4;
    mockAgenticLoopState.streamedToolCalls = [{ id: "call-1", name: "read_file", args: {} } as any];

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
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
      options,
      requestId: "req-exhaust",
    }));

    mockHarnessInstance.consumeStream = vi.fn().mockImplementation(async (stream, passState) => {
      passState.streamedText = "";
      passState.finalStreamedText = "";
    });

    const treeOfThoughtsResult = await runTreeOfThoughts(mockHarnessInstance as any);

    expect(treeOfThoughtsResult).toBeDefined();
    expect(runExhaustionRecoveryPass).toHaveBeenCalled();
  });

  it("should support system prompt assembly, skills status emission, and planFirst status in BFS/DFS mode", async () => {
    mockAgenticContext.options.planFirst = true;
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticContext.conversationMeta.systemPrompt).toBe("injected-system-prompt-test");
    expect(mockAgenticContext.options.systemPrompt).toBe("injected-system-prompt-test");
    expect(mockAgenticContext.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    }));
    expect(mockAgenticContext.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: ["skill-test-1", "skill-test-2"],
    }));
  });

  it("should abort sequential sibling exploration in DFS when signal is aborted", async () => {
    mockAgenticContext.options.searchStrategy = "dfs";
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.valueThreshold = 12.0; // forces sequential sibling loop
    mockAgenticContext.options.maxIterations = 1;

    const abortController = new AbortController();
    mockAgenticContext.signal = abortController.signal;

    // Simulate abortion inside the loop by aborting during the first generateBranch
    let branchGenCount = 0;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      branchGenCount++;
      if (branchGenCount === 1) {
        abortController.abort();
      }
      return {
        streamedText: "DFS Sibling",
        finalStreamedText: "DFS Sibling",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-dfs",
      };
    });

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(1); // Aborted after 1
  });

  it("should enforce cost budget and break iteration loop early", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 2;
    vi.mocked(checkCostBudget).mockReturnValueOnce(true);

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(1); // Exited early
  });

  it("should handle tool rejection by approval gate and execute rejection tool results", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "Tool call branch",
      finalStreamedText: "Tool call branch",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [{ id: "call-reject", name: "read_file", args: {} }],
      streamedImages: [],
      start: Date.now(),
      firstTokenTime: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      options,
      requestId: "req-reject",
    }));

    vi.mocked(checkAndWaitForApproval).mockResolvedValueOnce({ isApproved: false, shouldApproveAll: false });

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("system"); // retry guidance or blocked error is system message
  });

  it("should restore sandbox checkpoint on validation failure if frontierCandidates is empty", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.beamWidth = 1; // empty frontierCandidates
    mockAgenticContext.options.enableSandbox = true;
    mockAgenticContext.workspaceRoot = "/mock/root";
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "Failure branch",
      finalStreamedText: "Failure branch",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [{ id: "call-fail", name: "read_file", args: {} }],
      streamedImages: [],
      start: Date.now(),
      firstTokenTime: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      options,
      requestId: "req-fail",
    }));

    // Trigger validation errors
    vi.mocked(validateAfterToolExecution).mockResolvedValueOnce([
      { filePath: "file.ts", validatorType: "test", rawOutput: "syntax error", toolName: "read_file", errors: [] },
    ]);

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.branchesBacktracked).toBe(1);
    expect(mockAgenticContext.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
      restoredCheckpoint: true,
    }));
  });

  it("should return unchanged messages when planApproved is false in tool execution plan phase", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    // Simulate entry to planning mode inside iteration
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      if (options.tools?.some((t: any) => t.name === "exit_plan_mode")) {
        // Planning loop empty output triggers planApproved = false
        return {
          streamedText: "",
          finalStreamedText: "",
          streamedThinking: "",
          thinkingSignature: "",
          pendingToolCalls: [],
          streamedImages: [],
          start: Date.now(),
          firstTokenTime: null,
          usage: { inputTokens: 10, outputTokens: 5 },
          options,
          requestId: "req-plan-empty",
        };
      }
      return {
        streamedText: "Plan first",
        finalStreamedText: "Plan first",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [{ id: "call-1", name: "enter_plan_mode", args: {} }], // Triggers planning mode check
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        usage: { inputTokens: 10, outputTokens: 5 },
        options,
        requestId: "req-iter",
      };
    });

    vi.mocked(handleExitPlanMode).mockResolvedValueOnce({ shouldContinueLoop: false });

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    // Return early due to planApproved = false in tool execution loop
    expect(mockAgenticLoopState.planModeActive).toBe(true);
  });

  it("should handle thinking-only response and inject continuation prompt", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 2;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "Internal reasoning details",
      thinkingSignature: "sig-123",
      pendingToolCalls: [],
      streamedImages: [],
      start: Date.now(),
      firstTokenTime: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      options,
      requestId: "req-think",
    }));

    mockHarnessInstance.consumeStream = vi.fn().mockImplementation(async (stream, passState) => {
      passState.streamedText = "";
      passState.finalStreamedText = "";
      passState.streamedThinking = "Internal reasoning details";
    });

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    const assistantMsg = result.messages.find((msg: any) => msg.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.thinking).toBe("Internal reasoning details");
  });

  it("should break when model output is completely empty", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [],
      streamedImages: [],
      start: Date.now(),
      firstTokenTime: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      options,
      requestId: "req-empty",
    }));

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
  });

  it("should fail to log scoring request on request logger error", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    vi.mocked(RequestLogger.logBackgroundLlmCall).mockRejectedValueOnce(new Error("Scoring log write error"));

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
  });

  it("should handle simple scoring format fallback, score zero override, and catch scoring errors", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    // Test case 1: Simple score format + zero score override
    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: 8.5\n2: 0";
      } else {
        yield "Branch output";
      }
    });

    const result1 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result1).toBeDefined();
    expect(mockAgenticLoopState.selectedBranchScores[0]).toBe(8.5);

    // Reset scoring arrays & iterations
    mockAgenticLoopState.selectedBranchScores = [];
    mockAgenticLoopState.iterations = 0;

    // Test case 2: Scoring throw catch block
    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        throw new Error("Scoring critical failure");
      } else {
        yield "Branch output";
      }
    });

    const result2 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result2).toBeDefined();
    expect(mockAgenticLoopState.selectedBranchScores[0]).toBe(5); // Default fallback score
  });

  it("should handle planning phase loop aborts, empty response, and exhaustion", async () => {
    // Test case 1: Abort during planning mode init
    mockAgenticLoopState.planModeActive = true;
    mockAgenticContext.options.maxIterations = 1;
    mockAgenticContext.signal = { aborted: true } as any;

    const result1 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result1).toBeDefined();
    expect(mockAgenticLoopState.planModeActive).toBe(true); // planning failed to approve

    // Test case 2: planning loop empty response
    mockAgenticContext.signal = undefined;
    mockAgenticLoopState.planModeActive = true;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "",
      pendingToolCalls: [],
      usage: { inputTokens: 5, outputTokens: 5 },
      options,
    }));

    const result2 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result2).toBeDefined();

    // Test case 3: planning loop exhaustion
    mockAgenticLoopState.planModeActive = true;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "Still planning...",
      finalStreamedText: "Still planning...",
      streamedThinking: "",
      pendingToolCalls: [], // no exit_plan_mode
      usage: { inputTokens: 5, outputTokens: 5 },
      options,
    }));

    const result3 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result3).toBeDefined();

    // Test case 4: planning loop text/thinking but no tool calls continue path
    mockAgenticLoopState.planModeActive = true;
    let planningIter = 0;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      planningIter++;
      if (planningIter === 1) {
        return {
          streamedText: "Planning reasoning text",
          finalStreamedText: "Planning reasoning text",
          streamedThinking: "Internal reasoning details",
          pendingToolCalls: [], // no tool calls
          usage: { inputTokens: 5, outputTokens: 5 },
          options,
        };
      }
      // exit loop next
      mockAgenticLoopState.planModeActive = false;
      return {
        streamedText: "Exit planning",
        finalStreamedText: "Exit planning",
        streamedThinking: "",
        pendingToolCalls: [{ id: "call-exit", name: "exit_plan_mode", args: {} }],
        usage: { inputTokens: 5, outputTokens: 5 },
        options,
      };
    });

    const result4 = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result4).toBeDefined();
  });

  it("should continue loop if codex planning response requires it", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 2;

    vi.mocked(handleCodexPlanningResponse).mockReturnValueOnce({ shouldContinueLoop: true });

    const result = await runTreeOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(2);
  });
});
