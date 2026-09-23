/**
 * A sub-agent's async task finishes INSIDE its run (real ReActHarness).
 *
 * Seen live 2026-09-22: a sub-agent called run_async_task, was told "END
 * YOUR TURN NOW — you will be notified", and ended — but a sub-agent's turn
 * is its whole run, and a completion that arrives after it is dropped
 * (AsyncTaskTools: "Sub-agents never wake a turn on their own"). Its task
 * finished unseen, the rest of its work never happened, and its parent
 * reported it done. Now a sub-agent's dispatch keeps it working, and where
 * its loop would end with its own tasks still running, it waits for them
 * and answers their results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
  ResolvedTools,
} from "#src/services/harnesses/types";

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: {
    set: vi.fn(),
    patch: vi.fn(),
    patchSubAgent: vi.fn(),
    removeSubAgent: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    remove: vi.fn(),
  },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn(), cleanup: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/harnesses/lifecycle/HookInitializer", () => ({
  createStandardHooks: () => ({
    hooks: {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
      }),
    },
    approvalEngine: {},
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

// The tool batch runs each call through the REAL ToolOrchestratorService
// dispatch (run_async_task is a Prism-internal tool), with the context the
// ToolExecutor builds for a sub-agent's loop.
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
  executeToolBatch: async (
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    context: AgenticContext,
  ) => {
    const { default: ToolOrchestratorService } = await import(
      "#src/services/tool-orchestrator/ToolOrchestratorService"
    );
    return Promise.all(
      toolCalls.map(async (toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        durationMilliseconds: 1,
        result: await ToolOrchestratorService.executeTool(toolCall.name, toolCall.args, {
          project: context.project,
          username: context.username,
          agent: context.agent || null,
          agentConversationId: context.agentConversationId,
          conversationId: context.conversationId,
          _providerName: context.providerName,
          _resolvedModel: context.resolvedModel,
          _emit: context.emit,
          enabledTools: ["run_async_task", "wait_for_tasks", "slow_lookup"],
          _recursionDepth: 1,
          _maxRecursionDepth: 2,
          _autoApprove: true,
        }),
      })),
    );
  },
  executeToolSingle: vi.fn(),
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
vi.mock("#src/services/harnesses/lifecycle/PostExecutionEmitter", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/ContextPressureManager", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({
    messages,
    compactionPerformed: false,
  })),
}));
vi.mock("#src/services/harnesses/lifecycle/ContextExhaustionGuard", () => ({
  isContextExhausted: vi.fn().mockReturnValue(false),
  logContextExhaustion: vi.fn(),
  emitContextExhaustedStatus: vi.fn(),
  buildContextExhaustedMessage: vi.fn().mockReturnValue("context-exhausted"),
}));
vi.mock("#src/services/harnesses/lifecycle/KVCacheReporter", () => ({
  logKVCacheHitRate: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolDiscoveryNudge", () => ({
  injectToolDiscoveryNudge: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/TrackerFinalizer", () => ({
  finalizePassTracker: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/CodexPlanningDetector", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));
vi.mock("#src/services/harnesses/lifecycle/SystemReminderInjector", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/CostBudgetEnforcer", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
  enforceCostBudget: vi.fn().mockResolvedValue(false),
  recordLoopSpend: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/PlanModeController", () => ({
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolRetryInterceptor", () => ({
  buildToolRetryGuidance: vi.fn().mockReturnValue(null),
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));

import ReActHarness from "#src/services/harnesses/ReActHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import OrchestratorService from "#src/services/OrchestratorService";
import AsyncTaskRegistry from "#src/services/AsyncTaskRegistry";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import { PROVIDERS } from "#src/constants";

const SUB_AGENT_SESSION = "sub-agent-async-session";

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

function buildSubAgentHarness(script: Turn[]) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
    generateTextStreamLive: undefined,
    discoverContextWindow: vi.fn(),
  };
  const context = {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3.6-flash",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 },
    traceId: "trace-sub-async",
    agentConversationId: SUB_AGENT_SESSION,
    parentAgentConversationId: "parent-session",
    conversationId: SUB_AGENT_SESSION,
    provider: mockProvider,
    options: { maxIterations: 8, autoApprove: true, agenticLoopEnabled: true, maxTokens: 8192, isSubAgent: true },
    messages: [{ role: "user", content: "Look up the answer and report it." }],
    emit: vi.fn(),
    signal: undefined,
    requestId: "req-sub-async",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "run_async_task", description: "Run a tool in the background", parameters: {} },
      { name: "wait_for_tasks", description: "Wait", parameters: {} },
    ] as unknown as ResolvedTools["finalTools"],
    resolvedEnabledTools: ["run_async_task", "wait_for_tasks"],
  };
  const harness = new ReActHarness(context, state, tools);
  const harnessInternals = harness as unknown as Record<string, unknown>;
  harnessInternals.createProviderStream = vi.fn().mockImplementation(async (messages: ConversationMessage[]) => {
    iteration++;
    seenMessages.push(messages.map((message) => ({ ...message })));
    return mockProvider.generateTextStream();
  });
  harnessInternals.consumeStream = vi.fn().mockImplementation(async (_stream: unknown, pass: PassState) => {
    const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tool") {
      pass.streamedText = "";
      pass.finalStreamedText = "";
      const toolCall = { id: `call-${iteration}`, name: turn.toolName, args: turn.args ?? {} };
      pass.pendingToolCalls = [toolCall];
      state.streamedToolCalls.push({ ...toolCall });
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      state.finalStreamedText = turn.text;
    }
    pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
  });
  harnessInternals.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  harnessInternals.finalize = vi.fn().mockResolvedValue(undefined);
  harnessInternals.logIteration = vi.fn();
  harnessInternals.emitGenerationProgress = vi.fn();
  harnessInternals.emitUsageUpdate = vi.fn();
  harnessInternals.checkAndApplyToolSetChanges = vi.fn();
  return { harness, seenMessages, iterations: () => iteration };
}

describe("a sub-agent's async task completes inside its run (real harness)", () => {
  let release: (value: unknown) => void = () => {};
  let isSubAgentSpy: ReturnType<typeof vi.spyOn>;
  let executeToolSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TurnInputMailbox._clearAll();
    AsyncTaskRegistry.clear();
    // In production the orchestrator knows its live sub-agents.
    isSubAgentSpy = vi
      .spyOn(OrchestratorService, "isSubAgentConversation")
      .mockImplementation((conversationId: string) => conversationId === SUB_AGENT_SESSION);
    // The background tool: settles when the test says so.
    const original = ToolOrchestratorService.executeTool.bind(ToolOrchestratorService);
    executeToolSpy = vi
      .spyOn(ToolOrchestratorService, "executeTool")
      .mockImplementation(async (name: string, args?: Record<string, unknown>, context?: never) =>
        name === "slow_lookup"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : original(name, args, context),
      );
  });

  afterEach(() => {
    isSubAgentSpy.mockRestore();
    executeToolSpy.mockRestore();
    AsyncTaskRegistry.clear();
    TurnInputMailbox._clearAll();
  });

  it("RED: it does not end at the dispatch, waits where it would end, and answers the result", async () => {
    const { harness, seenMessages, iterations } = buildSubAgentHarness([
      { kind: "tool", toolName: "run_async_task", args: { toolName: "slow_lookup", toolArguments: { q: "answer" } } },
      { kind: "text", text: "I started the lookup." },
      { kind: "text", text: "The lookup says 42." },
    ]);
    TurnInputMailbox.open(SUB_AGENT_SESSION);
    // The task settles only after the sub-agent has tried to finish.
    setTimeout(() => release({ answer: 42 }), 60);

    await harness.run();

    expect(iterations(), "the dispatch must not end the sub-agent's run").toBe(3);
    const lastInput = JSON.stringify(seenMessages[2]);
    expect(lastInput).toContain("[ASYNC TASK COMPLETED]");
    expect(lastInput).toContain('\\"answer\\":42');
    expect(AsyncTaskRegistry.countRunningTasks(SUB_AGENT_SESSION)).toBe(0);
  });
});
