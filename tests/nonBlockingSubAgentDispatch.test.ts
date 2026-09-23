/**
 * Prompt 17, Landing 1 — non-blocking sub-agent dispatch.
 *
 * A REAL ReActHarness (scripted model, same lifecycle mocks as
 * turnInputAcceptance.test.ts) drives the REAL orchestrator tools:
 * create_subagent(s), wait_for_tasks and report_progress go through
 * ToolOrchestratorService.executeTool → OrchestratorService → the real
 * hierarchical router. Only the sub-agents' own loops
 * (AgenticLoopService.runAgenticLoop) are scripted.
 *
 *   1. The parent spawns two sub-agents and KEEPS calling tools; the team's
 *      completion arrives at the next mailbox boundary of the same turn.
 *   2. wait_for_tasks returns both sub-agents, and the team completion is
 *      not delivered a second time.
 *   3. A sub-agent's report_progress reaches the parent's running turn
 *      exactly once, as external input from the sub-agent (prompt 22 L3).
 *   4. A turn that ends with the team still running counts it once in
 *      pendingBackgroundTasks; the auto-response that later delivers the
 *      completion pays it back — the counter returns to zero.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, NOTIFICATION_SOURCES, TURN_INPUT } from "#src/constants";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
  ResolvedTools,
} from "#src/services/harnesses/types";

// ── Sub-agent loops: scripted, released by the test ──────────
interface SubAgentRun {
  args: { conversationId: string; agentConversationId: string; messages: ConversationMessage[] };
  finish: (text: string) => void;
}
const subAgentRuns: SubAgentRun[] = [];
const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// Not a git workspace: sub-agents run in the shared workspace (no merge-back).
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

const mockHandleAgent = vi.fn();
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: (...args: unknown[]) => mockHandleAgent(...args) };
});

// ── Harness lifecycle mocks (mirrors turnInputAcceptance.test.ts) ──
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
// dispatch (orchestrator + internal tools) with the context ToolExecutor
// builds; `search_web` is a stub the scenarios hook into.
const searchWebMock = vi.fn();
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
        result:
          toolCall.name === "search_web"
            ? await searchWebMock(toolCall.args)
            : await ToolOrchestratorService.executeTool(toolCall.name, toolCall.args, {
                project: context.project,
                username: context.username,
                agent: context.agent || null,
                agentConversationId: context.agentConversationId,
                conversationId: context.conversationId,
                _providerName: context.providerName,
                _resolvedModel: context.resolvedModel,
                _emit: context.emit,
                enabledTools: ["search_web"],
                _recursionDepth: 0,
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
import CounterConversationService from "#src/services/conversation/ConversationService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const PARENT_CONVERSATION_ID = "parent-conv";
const PARENT_SESSION_ID = "parent-session";

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

/** A real ReActHarness whose model plays `script[i]` on iteration i+1. */
function buildParentHarness(script: Turn[]) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const emit = vi.fn();
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
    resolvedModel: "gemini-3-flash-preview",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 },
    traceId: "trace-nonblocking",
    agentConversationId: PARENT_SESSION_ID,
    conversationId: PARENT_CONVERSATION_ID,
    provider: mockProvider,
    options: {
      maxIterations: 8,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
    },
    messages: [{ role: "user", content: "Research A and B" }],
    emit,
    signal: undefined,
    requestId: "req-nonblocking",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "search_web", description: "Search the web", parameters: {} },
      { name: "create_subagents", description: "Spawn a team", parameters: {} },
      { name: "create_subagent", description: "Spawn one", parameters: {} },
      { name: "wait_for_tasks", description: "Wait", parameters: {} },
    ] as unknown as ResolvedTools["finalTools"],
    resolvedEnabledTools: ["search_web", "create_subagents", "create_subagent", "wait_for_tasks"],
  };
  const harness = new ReActHarness(context, state, tools);
  const harnessInternals = harness as unknown as Record<string, unknown>;

  harnessInternals.createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[]) => {
      iteration++;
      seenMessages.push(messages.map((message) => ({ ...message })));
      return mockProvider.generateTextStream();
    },
  );
  harnessInternals.consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
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
    },
  );
  harnessInternals.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  harnessInternals.finalize = vi.fn().mockResolvedValue(undefined);
  harnessInternals.logIteration = vi.fn();
  harnessInternals.emitGenerationProgress = vi.fn();
  harnessInternals.emitUsageUpdate = vi.fn();
  harnessInternals.checkAndApplyToolSetChanges = vi.fn();

  return { harness, emit, state, seenMessages, iterations: () => iteration };
}

const TEAM = {
  name: "research",
  members: [
    { description: "Alpha research", prompt: "Look up A" },
    { description: "Beta research", prompt: "Look up B" },
  ],
};

function finishAllSubAgents(prefix = "result") {
  for (const run of subAgentRuns.splice(0)) run.finish(`${prefix} from ${run.args.conversationId}`);
}

/** Resolve once `predicate` holds, polling real time; reject after `milliseconds`. */
async function waitUntil(predicate: () => boolean, milliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isTeamCompletion(message: ConversationMessage): boolean {
  return (
    message._notificationSource === NOTIFICATION_SOURCES.ORCHESTRATOR &&
    typeof message.content === "string" &&
    message.content.includes("<task-notification>")
  );
}

describe("non-blocking sub-agent dispatch — the parent keeps working (real harness)", () => {
  let pendingBackgroundTasks: number;
  let adjustSpy: ReturnType<typeof vi.spyOn>;
  // A dispatch that holds the parent's turn until the team is done (the
  // pre-landing behaviour) would wait on these loops forever; release them
  // late so such a run ends and fails its assertions instead of timing out.
  let fallbackRelease: ReturnType<typeof setTimeout>;
  const conversationDocument = {
    id: PARENT_CONVERSATION_ID,
    project: "test-project",
    username: "test-user",
    isGenerating: false,
    messages: [{ role: "user", content: "Research A and B" }],
    settings: { provider: PROVIDERS.GOOGLE, model: "gemini-3-flash-preview", agent: "CODING" },
  };

  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    subAgentRuns.length = 0;
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(
      (args: SubAgentRun["args"]) =>
        new Promise((resolve) => {
          subAgentRuns.push({
            args,
            finish: (text) => resolve({ messages: [...args.messages, { role: "assistant", content: text }] }),
          });
        }),
    );
    fallbackRelease = setTimeout(() => finishAllSubAgents("fallback"), 1_500);
    searchWebMock.mockReset();
    searchWebMock.mockResolvedValue({ results: ["a page"] });
    mockHandleAgent.mockReset();
    mockHandleAgent.mockResolvedValue(undefined);
    TurnInputMailbox._clearAll();
    OrchestratorService.clearAllActiveSubAgents();

    pendingBackgroundTasks = 0;
    adjustSpy = vi
      .spyOn(CounterConversationService, "adjustPendingBackgroundTasks")
      .mockImplementation(async (_conversationId, _project, _username, delta) => {
        pendingBackgroundTasks = Math.max(0, pendingBackgroundTasks + delta);
      });

    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({
        findOne: vi.fn().mockResolvedValue({ pendingBackgroundTasks, isActive: false }),
      }),
    } as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockImplementation(async () => ({ ...conversationDocument })),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    clearTimeout(fallbackRelease);
    finishAllSubAgents("cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    adjustSpy.mockRestore();
    OrchestratorService.clearAllActiveSubAgents();
    TurnInputMailbox._clearAll();
  });

  it("1. spawns two sub-agents and keeps calling tools; the team completion arrives at the next boundary", async () => {
    const { harness, seenMessages, iterations } = buildParentHarness([
      { kind: "tool", toolName: "create_subagents", args: TEAM },
      { kind: "tool", toolName: "search_web", args: { query: "meanwhile" } },
      { kind: "text", text: "Merged both results." },
    ]);
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);

    // While the parent's second tool runs, both sub-agents finish; the
    // team's completion must reach the still-running turn.
    searchWebMock.mockImplementationOnce(async () => {
      await waitUntil(() => subAgentRuns.length === 2);
      finishAllSubAgents();
      await waitUntil(() => TurnInputMailbox.pendingCount(PARENT_CONVERSATION_ID) > 0);
      return { results: ["a page"] };
    });

    const { messages } = await harness.run();

    expect(iterations(), "the dispatch must not end the parent's turn").toBe(3);
    const dispatchCall = messages.find((message) => message.toolCalls?.[0]?.name === "create_subagents");
    const dispatchResult = dispatchCall?.toolCalls?.[0]?.result as { _directive?: string; agents?: unknown[] };
    expect(dispatchResult._directive).toBe("DETACHED_WORK");
    expect(dispatchResult.agents).toHaveLength(2);

    // The third model call sees the completion, after the search result.
    const thirdCallInput = seenMessages[2];
    const completion = thirdCallInput.find(isTeamCompletion);
    expect(completion, "the team completion must be in the next model call's input").toBeDefined();
    expect(completion!.content).toContain(`result from ${mockRunAgenticLoop.mock.calls[0][0].conversationId}`);
    expect(completion!.content).toContain(`result from ${mockRunAgenticLoop.mock.calls[1][0].conversationId}`);
    const searchIndex = thirdCallInput.findIndex((message) => message.toolCalls?.[0]?.name === "search_web");
    expect(thirdCallInput.indexOf(completion!)).toBeGreaterThan(searchIndex);
    expect(messages.filter(isTeamCompletion)).toHaveLength(1);

    // Delivered inside the dispatching turn: nothing was counted.
    expect(pendingBackgroundTasks).toBe(0);
    expect(mockHandleAgent).not.toHaveBeenCalled();
  });

  it("2. wait_for_tasks returns both sub-agents, and the completion is not delivered twice", async () => {
    const { harness, seenMessages, iterations } = buildParentHarness([
      { kind: "tool", toolName: "create_subagents", args: TEAM },
      { kind: "tool", toolName: "wait_for_tasks", args: { timeoutSeconds: 10 } },
      { kind: "text", text: "Both are done." },
    ]);
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);

    // Both finish shortly after the wait has started blocking on them.
    const release = setInterval(() => {
      const awaited = [...OrchestratorService._getActiveSubAgents().values()].filter((agent) => agent.awaitedBy);
      if (subAgentRuns.length === 2 && awaited.length === 2) {
        clearInterval(release);
        finishAllSubAgents();
      }
    }, 5);

    const { messages } = await harness.run();
    clearInterval(release);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(iterations()).toBe(3);
    const waitCall = messages.find((message) => message.toolCalls?.[0]?.name === "wait_for_tasks");
    const waitResult = waitCall?.toolCalls?.[0]?.result as { tasks: Array<Record<string, unknown>>; stillRunning: string[] };
    expect(waitResult.stillRunning).toEqual([]);
    const subAgentEntries = waitResult.tasks.filter((entry) => entry.kind === "subagent");
    expect(subAgentEntries).toHaveLength(2);
    for (const entry of subAgentEntries) {
      expect(entry.status).toBe("completed");
      expect(String(entry.result)).toContain("result from");
    }

    // wait_for_tasks owned the delivery: no notification in the turn or after it.
    expect(seenMessages.flat().some(isTeamCompletion)).toBe(false);
    expect(TurnInputMailbox.pendingCount(PARENT_CONVERSATION_ID)).toBe(0);
    expect(mockHandleAgent).not.toHaveBeenCalled();
    expect(pendingBackgroundTasks).toBe(0);
  });

  it("3. a sub-agent's report_progress reaches the running parent exactly once, as external input", async () => {
    const { harness, emit, seenMessages, iterations } = buildParentHarness([
      { kind: "tool", toolName: "create_subagent", args: { description: "Alpha research", prompt: "Look up A" } },
      { kind: "tool", toolName: "search_web", args: { query: "meanwhile" } },
      { kind: "text", text: "Alpha is halfway." },
    ]);
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);

    searchWebMock.mockImplementationOnce(async () => {
      await waitUntil(() => subAgentRuns.length === 1);
      const [childRun] = subAgentRuns;
      // The child's model calls report_progress mid-run.
      const { default: ToolOrchestratorService } = await import(
        "#src/services/tool-orchestrator/ToolOrchestratorService"
      );
      const progressResult = await ToolOrchestratorService.executeTool(
        "report_progress",
        { message: "Found 3 of 5 sources" },
        {
          project: "test-project",
          username: "test-user",
          agentConversationId: childRun.args.agentConversationId,
          conversationId: childRun.args.conversationId,
        },
      );
      expect(progressResult).toMatchObject({ delivered: true });
      return { results: ["a page"] };
    });

    await harness.run();

    expect(iterations()).toBe(3);
    const progressMessages = seenMessages[2].filter(
      (message) => message._notificationSource === NOTIFICATION_SOURCES.EXTERNAL_INPUT,
    );
    expect(progressMessages).toHaveLength(1);
    const [progress] = progressMessages;
    expect(progress.content).toContain("Found 3 of 5 sources");
    expect(progress.content).toContain("not from the user");
    expect(progress.content).toMatch(/^<external-input>/);
    expect(progress._authority).toBe("sub-agent");
    expect(progress._turnInput).toMatchObject({ kind: "external", source: "subagent" });
    expect((progress as Record<string, unknown>)._external).toMatchObject({ source: "subagent" });

    const turnInputEvents = emit.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === TURN_INPUT.EVENT_TYPE);
    expect(turnInputEvents).toHaveLength(1);
    expect(turnInputEvents[0].kind).toBe("external");
    expect(turnInputEvents[0].source).toBe("subagent");
    // Viewers get the child's words; the model gets the tagged version.
    expect(turnInputEvents[0].content).toBe("Found 3 of 5 sources");
    expect(progress.rawContent).toBe("Found 3 of 5 sources");
    expect(seenMessages.flat().some((message) => message._notificationSource === NOTIFICATION_SOURCES.USER_UPDATE)).toBe(false);
  });

  it("4. a turn that ends with the team running counts it once; the auto-response pays it back", async () => {
    const { harness, iterations } = buildParentHarness([
      { kind: "tool", toolName: "create_subagents", args: TEAM },
      { kind: "text", text: "They are running; I will report back." },
    ]);
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);

    await harness.run();
    // AgenticLoopService closes the mailbox when the turn returns.
    TurnInputMailbox.close(PARENT_CONVERSATION_ID);

    expect(iterations()).toBe(2);
    expect(pendingBackgroundTasks, "one undelivered dispatch at turn end").toBe(1);
    expect(adjustSpy).toHaveBeenCalledWith(
      PARENT_CONVERSATION_ID, "test-project", "test-user", 1, expect.anything(),
    );

    await waitUntil(() => subAgentRuns.length === 2);
    finishAllSubAgents();
    await waitUntil(() => mockHandleAgent.mock.calls.length === 1);
    await waitUntil(() => pendingBackgroundTasks === 0);

    const [autoResponseParams] = mockHandleAgent.mock.calls[0];
    expect(autoResponseParams.conversationId).toBe(PARENT_CONVERSATION_ID);
    const decrements = adjustSpy.mock.calls.filter((call) => call[3] === -1);
    expect(decrements).toHaveLength(1);
  });
});
