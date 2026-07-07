import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../../../constants.ts";
import { runGraphOfThoughts } from "../strategies/GraphOfThoughtsStrategy.ts";
import { APPROVAL_TIERS } from "../../AutoApprovalEngine.ts";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { runExhaustionRecoveryPass } from "../lifecycle/ExhaustionRecovery.ts";
import { validateAfterToolExecution } from "../lifecycle/ValidationInterceptor.ts";
import { isOutputTruncated } from "../lifecycle/OutputTruncationRecovery.ts";
import { checkCostBudget } from "../lifecycle/CostBudgetEnforcer.ts";
import { checkAndWaitForApproval } from "../lifecycle/ApprovalGate.ts";
import { handleCodexPlanningResponse } from "../lifecycle/CodexPlanningDetector.ts";
import { handleExitPlanMode } from "../lifecycle/PlanModeController.ts";
import RequestLogger from "../../RequestLogger.ts";

// Mock logger to avoid printing in tests
vi.mock("../../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: vi.fn().mockReturnValue("mock-stash-ref"),
  restoreSandboxCheckpoint: vi.fn(),
}));

vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lifecycle/OutputTruncationRecovery.ts", () => ({
  isOutputTruncated: vi.fn().mockReturnValue(false),
  injectContinuationContext: vi.fn().mockReturnValue(100),
  injectErrorAsConversationMessage: vi.fn(),
  buildProviderErrorMessage: vi.fn().mockReturnValue("provider-error"),
  buildExhaustedRecoveryMessage: vi.fn().mockReturnValue("exhausted-error"),
  MAX_OUTPUT_TRUNCATION_RECOVERIES: 3,
}));

vi.mock("../lifecycle/ExhaustionRecovery.ts", () => ({
  runExhaustionRecoveryPass: vi.fn().mockResolvedValue({ messages: [] }),
}));

vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
}));

vi.mock("../lifecycle/ApprovalGate.ts", () => ({
  checkAndWaitForApproval: vi.fn().mockResolvedValue({ isApproved: true, shouldApproveAll: false }),
}));

vi.mock("../lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));

vi.mock("../../RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lifecycle/HookInitializer.ts", async () => {
  const actual = await vi.importActual("../lifecycle/HookInitializer.ts") as any;
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

vi.mock("../lifecycle/PlanModeController.ts", async () => {
  const actual = await vi.importActual("../lifecycle/PlanModeController.ts") as any;
  return {
    ...actual,
    handleExitPlanMode: vi.fn().mockImplementation((...args) => actual.handleExitPlanMode(...args)),
  };
});


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
    expect(result.messages.length).toBe(2);
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

  it("should generate parallel branches and handle scoring failure gracefully", async () => {
    mockAgenticContext.options.branchCount = 3;
    mockAgenticContext.options.maxIterations = 1;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        throw new Error("Scoring service unavailable");
      } else {
        yield "Thought branch output";
      }
    });

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesExplored).toBe(3);
    expect(mockAgenticLoopState.selectedBranchScores[0]).toBe(5.0);
  });

  it("should synthesize outputs from multiple branches in aggregation pass", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    let synthesisPromptContent = "";
    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=8, efficiency=8, completeness=8\n2: correctness=6, risk=6, efficiency=6, completeness=6";
      } else if (lastMessage.includes("GRAPH-OF-THOUGHTS SYNTHESIS PASS")) {
        synthesisPromptContent = lastMessage;
        yield "Merged and synthesized output";
      } else {
        yield "Thought branch output " + messages.length;
      }
    });

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(synthesisPromptContent).toContain("[GRAPH-OF-THOUGHTS SYNTHESIS PASS]");
    expect(synthesisPromptContent).toContain("Branch 1");
    expect(synthesisPromptContent).toContain("Branch 2");
  });

  it("should support tool execution inside Graph of Thoughts synthesized pass", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      return {
        streamedText: "Execute tools now.",
        finalStreamedText: "Execute tools now.",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [{ id: "call-got-tool", name: "read_file", args: {} }],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-got-tool",
      };
    });

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(graphOfThoughtsResult).toBeDefined();
  });

  it("should prune low-scoring branches and exclude them from synthesis pass", async () => {
    mockAgenticContext.options.branchCount = 3;
    mockAgenticContext.options.maxIterations = 1;
    mockAgenticContext.options.valueThreshold = 6.0;

    let synthesisPromptContent = "";
    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=8, efficiency=8, completeness=8\n2: correctness=4, risk=4, efficiency=4, completeness=4\n3: correctness=7, risk=7, efficiency=7, completeness=7";
      } else if (lastMessage.includes("GRAPH-OF-THOUGHTS SYNTHESIS PASS")) {
        synthesisPromptContent = lastMessage;
        yield "Synthesized response";
      } else {
        yield "Branch output";
      }
    });

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(synthesisPromptContent).toContain("Branch 1");
    expect(synthesisPromptContent).not.toContain("Branch 2");
    expect(synthesisPromptContent).toContain("Branch 3");
  });

  it("should perform proactive backtracking when all branches score below threshold in GoT", async () => {
    mockAgenticContext.options.branchCount = 2;
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

    const graphOfThoughtsResult = await runGraphOfThoughts(mockHarnessInstance as any);

    expect(graphOfThoughtsResult).toBeDefined();
    expect(mockAgenticLoopState.branchesBacktracked).toBe(1);
    expect(graphOfThoughtsResult.messages.some((msg: any) => msg.content && msg.content.includes("PROACTIVE BACKTRACK"))).toBe(true);
  });

  it("should support system prompt assembly, skills status emission, and planFirst status in BFS/DFS mode in GoT", async () => {
    mockAgenticContext.options.planFirst = true;
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
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

  it("should abort after branch synthesis in GoT when signal is aborted", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    const abortController = new AbortController();
    mockAgenticContext.signal = abortController.signal;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      // Abort after synthesis pass call begins
      if (options.branchIndex === undefined) {
        abortController.abort();
      }
      return {
        streamedText: "Synthesis pass",
        finalStreamedText: "Synthesis pass",
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: [],
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: "req-got",
      };
    });

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
  });

  it("should enforce cost budget and break iteration loop early in GoT", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 2;
    vi.mocked(checkCostBudget).mockReturnValueOnce(true);

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(1);
  });

  it("should handle tool rejection by approval gate in GoT synthesized pass", async () => {
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

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("system");
  });

  it("should trigger validation errors in synthesized tool execution", async () => {
    mockAgenticContext.options.branchCount = 2;
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

    vi.mocked(validateAfterToolExecution).mockResolvedValueOnce([
      { filePath: "file.ts", validatorType: "test", rawOutput: "syntax error", toolName: "read_file", errors: [] },
    ]);

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.branchesBacktracked).toBe(1);
  });

  it("should return unchanged messages when planApproved is false in tool execution plan phase in GoT", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 1;

    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => {
      if (options.tools?.some((t: any) => t.name === "exit_plan_mode")) {
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

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.planModeActive).toBe(true);
  });

  it("should handle thinking-only response in GoT synthesized pass", async () => {
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

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    const assistantMsg = result.messages.find((msg: any) => msg.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.thinking).toBe("Internal reasoning details");
  });

  it("should break when GoT model output is completely empty", async () => {
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

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
  });

  it("should fail to log scoring request on request logger error in GoT", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    vi.mocked(RequestLogger.logBackgroundLlmCall).mockRejectedValueOnce(new Error("Scoring log write error"));

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
  });

  it("should handle simple scoring format fallback, score zero override, and catch scoring errors in GoT", async () => {
    mockAgenticContext.options.branchCount = 2;
    mockAgenticContext.options.maxIterations = 1;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        yield "1: 8.5\n2: 0";
      } else {
        yield "Branch output";
      }
    });

    const result1 = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result1).toBeDefined();
    expect(mockAgenticLoopState.selectedBranchScores[0]).toBe(8.5);

    mockAgenticLoopState.selectedBranchScores = [];
    mockAgenticLoopState.iterations = 0;

    mockProvider.generateTextStream = vi.fn().mockImplementation(async function* (messages: any[]) {
      const lastMessage = messages[messages.length - 1]?.content || "";
      if (lastMessage.includes("Rate each candidate approach")) {
        throw new Error("Scoring critical failure");
      } else {
        yield "Branch output";
      }
    });

    const result2 = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result2).toBeDefined();
    expect(mockAgenticLoopState.selectedBranchScores[0]).toBe(5);
  });

  it("should handle planning phase loop aborts, empty response, and exhaustion in GoT", async () => {
    // Test case 1: Abort during planning mode init
    mockAgenticLoopState.planModeActive = true;
    mockAgenticContext.options.maxIterations = 1;
    mockAgenticContext.signal = { aborted: true } as any;

    const result1 = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result1).toBeDefined();
    expect(mockAgenticLoopState.planModeActive).toBe(true);

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

    const result2 = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result2).toBeDefined();

    // Test case 3: planning loop exhaustion
    mockAgenticLoopState.planModeActive = true;
    mockHarnessInstance.createPassState = vi.fn().mockImplementation((options) => ({
      streamedText: "Still planning...",
      finalStreamedText: "Still planning...",
      streamedThinking: "",
      pendingToolCalls: [],
      usage: { inputTokens: 5, outputTokens: 5 },
      options,
    }));

    const result3 = await runGraphOfThoughts(mockHarnessInstance as any);
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
          pendingToolCalls: [],
          usage: { inputTokens: 5, outputTokens: 5 },
          options,
        };
      }
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

    const result4 = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result4).toBeDefined();
  });

  it("should continue loop if codex planning response requires it in GoT", async () => {
    mockAgenticContext.options.branchCount = 1;
    mockAgenticContext.options.maxIterations = 2;

    vi.mocked(handleCodexPlanningResponse).mockReturnValueOnce({ shouldContinueLoop: true });

    const result = await runGraphOfThoughts(mockHarnessInstance as any);
    expect(result).toBeDefined();
    expect(mockAgenticLoopState.iterations).toBe(2);
  });
});
