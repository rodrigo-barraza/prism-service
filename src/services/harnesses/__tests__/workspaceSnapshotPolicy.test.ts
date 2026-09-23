/**
 * workspaceSnapshotPolicy.test.ts
 *
 * The code half of user rewind (docs/prompts/15): a REAL ReActHarness and the
 * REAL ToolExecutor, with only the tool dispatch, Mongo and tools-service
 * faked. A tool batch that can write to the workspace is bracketed by a
 * before/after shadow snapshot recorded on the conversation; a read-only
 * batch is never snapshotted; a non-git workspace is recorded once and
 * skipped for the rest of the turn; a tools-service failure never blocks
 * the agent's tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ResolvedTools, ConversationMessage, PassState } from "../types.ts";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: { getDefaultLocale: () => "en", get: (_locale: string, key: string) => `[locale:${key}]` },
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../lifecycle/HookInitializer.ts", () => ({
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
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: { countRunningTasks: vi.fn().mockReturnValue(0), hasActiveTask: vi.fn().mockReturnValue(false), listTasks: vi.fn().mockReturnValue([]) },
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../lifecycle/ApprovalGate.ts", () => ({
  // Every call cleared, nothing blocked — the gate's per-call verdict.
  checkAndWaitForApproval: vi.fn().mockImplementation(async (toolCalls: unknown[]) => ({
    executableToolCalls: toolCalls,
    blockedResults: [],
    deniedToolCalls: [],
    shouldApproveAll: false,
  })),
  orderResultsLikeCalls: (_toolCalls: unknown[], results: unknown[]) => results,
  approvalRecordFor: () => ({}),
}));
vi.mock("../lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));
vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("../lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({ messages, compactionPerformed: false })),
}));
vi.mock("../lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("../lifecycle/TrackerFinalizer.ts", () => ({ finalizePassTracker: vi.fn() }));
vi.mock("../lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: vi.fn().mockReturnValue(false) }));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/ToolContext", () => ({ default: { getStore: vi.fn().mockReturnValue(new Map()) } }));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));
vi.mock("#src/services/AgentPersonaRegistry", () => ({ default: { isAgentProject: () => false, get: () => undefined } }));

// The tools themselves: the real ToolExecutor dispatches through this.
const executeToolMock = vi.fn();
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    isStreamable: () => false,
    executeTool: (...args: unknown[]) => executeToolMock(...args),
  },
}));

// Mongo: one agent conversation document, updated in place.
const conversation: Record<string, any> = {};
const collectionMock = {
  findOne: vi.fn(async () => conversation),
  updateOne: vi.fn(async (_filter: unknown, update: Record<string, any>) => {
    Object.assign(conversation, update.$set || {});
    for (const [field, value] of Object.entries(update.$push || {})) {
      (conversation[field] ||= []).push(value);
    }
    return { matchedCount: 1 };
  }),
};
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getCollection: vi.fn(() => collectionMock), getDb: vi.fn() },
}));

// tools-service
type SnapshotAnswer = Record<string, unknown> | "unreachable";
let snapshotAnswer: (ref: string) => SnapshotAnswer;
const snapshotRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  snapshotRequests.push({ url, body });
  const answer = snapshotAnswer(body.ref);
  if (answer === "unreachable") throw new Error("ECONNREFUSED");
  return { ok: true, status: 200, json: async () => answer } as Response;
});

// ── Scripted harness ─────────────────────────────────────────

type Turn = { kind: "tools"; calls: string[] } | { kind: "text"; text: string };

function runScript(script: Turn[], { workspaceRoot = "/work/repo" }: { workspaceRoot?: string | null } = {}) {
  let iteration = 0;
  const context: AgenticContext = {
    project: "prism-agent",
    username: "test-user",
    agent: "CODING",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
    traceId: "test-trace",
    agentConversationId: "conv-1",
    conversationId: "conv-1",
    workspaceRoot,
    provider: { generateTextStream: vi.fn(async function* () { yield ""; }) } as any,
    options: { maxIterations: 6, autoApprove: true, agenticLoopEnabled: true, maxTokens: 8192, tools: [] },
    messages: [{ role: "user", content: "Do the task" }],
    emit: vi.fn(),
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: false,
  } as any;
  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const toolNames = ["read_file", "write_file", "execute_command", "search_file_contents"];
  const tools: ResolvedTools = {
    finalTools: toolNames.map((name) => ({ name, description: name, parameters: {} })) as any,
    resolvedEnabledTools: toolNames,
  };
  const harness = new ReActHarness(context, state, tools);
  (harness as any).createProviderStream = vi.fn(async () => {
    iteration++;
    return (context.provider as any).generateTextStream();
  });
  (harness as any).consumeStream = vi.fn(async (_stream: unknown, pass: PassState) => {
    const turn = script[iteration - 1] ?? { kind: "text", text: "done" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tools") {
      pass.streamedText = "";
      pass.finalStreamedText = "";
      pass.pendingToolCalls = turn.calls.map((name, index) => ({ id: `call-${iteration}-${index}`, name, args: {} }));
      state.streamedToolCalls.push(...pass.pendingToolCalls);
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      state.finalStreamedText = turn.text;
    }
    pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
  });
  (harness as any).enforceContextWindow = vi.fn((messages: ConversationMessage[]) => messages);
  (harness as any).finalize = vi.fn().mockResolvedValue(undefined);
  (harness as any).logIteration = vi.fn();
  (harness as any).emitGenerationProgress = vi.fn();
  (harness as any).emitUsageUpdate = vi.fn();
  (harness as any).checkAndApplyToolSetChanges = vi.fn();
  return harness.run();
}

const snapshotRefs = () => snapshotRequests.map((request) => request.body.ref);

describe("workspace snapshot policy — real harness, real ToolExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(conversation)) delete conversation[key];
    Object.assign(conversation, {
      id: "conv-1",
      messages: [{ id: "msg_earlier", role: "user", content: "earlier" }, { role: "assistant", content: "ok" }],
    });
    snapshotRequests.length = 0;
    snapshotAnswer = (ref) => ({
      snapshotCapable: true,
      ref,
      commit: `commit-for-${ref.split("/").pop()}`,
      workspaceRoot: "/work/repo",
      createdAt: Date.now(),
    });
    executeToolMock.mockImplementation(async (name: string) => ({ ok: true, tool: name }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("brackets a write batch with before/after snapshots and never snapshots a read-only batch", async () => {
    await runScript([
      { kind: "tools", calls: ["read_file", "search_file_contents"] },
      { kind: "tools", calls: ["read_file", "write_file"] },
      { kind: "text", text: "done" },
    ]);

    expect(executeToolMock).toHaveBeenCalledTimes(4);
    expect(snapshotRequests.every((request) => request.url === "http://tools.test/agentic/git/snapshot")).toBe(true);
    expect(snapshotRefs()).toEqual([
      "refs/prism/checkpoints/conv-1/1-2",
      "refs/prism/checkpoints/conv-1/1-2-after",
    ]);
    expect(snapshotRequests[0].body.workspaceRoot).toBe("/work/repo");

    const records = conversation.workspaceSnapshots;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      ref: "refs/prism/checkpoints/conv-1/1-2",
      phase: "before",
      turn: 1,
      iteration: 2,
      // anchored after the last persisted message (a legacy one → derived id)
      messageId: "legacy-1",
      messageBoundary: 2,
      toolCallIds: ["call-2-0", "call-2-1"],
      workspaceRoot: "/work/repo",
      commit: "commit-for-1-2",
    });
    expect(records[1]).toMatchObject({ phase: "after", ref: "refs/prism/checkpoints/conv-1/1-2-after" });
    expect(conversation.workspaceSnapshotStatus).toMatchObject({ capable: true });
  });

  it("takes the snapshot BEFORE the batch runs and the after-snapshot once it finished", async () => {
    const order: string[] = [];
    executeToolMock.mockImplementation(async (name: string) => {
      order.push(`tool:${name}`);
      return { ok: true };
    });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      order.push(`snapshot:${String(body.ref).split("/").pop()}`);
      snapshotRequests.push({ url, body });
      return { ok: true, status: 200, json: async () => snapshotAnswer(body.ref) } as Response;
    });

    await runScript([{ kind: "tools", calls: ["execute_command"] }, { kind: "text", text: "done" }]);

    expect(order).toEqual(["snapshot:1-1", "tool:execute_command", "snapshot:1-1-after"]);
  });

  it("numbers the turn after the conversation's existing snapshots", async () => {
    conversation.workspaceSnapshots = [
      { ref: "refs/prism/checkpoints/conv-1/3-1", phase: "before", turn: 3 },
    ];
    await runScript([{ kind: "tools", calls: ["write_file"] }, { kind: "text", text: "done" }]);
    expect(snapshotRefs()).toEqual([
      "refs/prism/checkpoints/conv-1/4-1",
      "refs/prism/checkpoints/conv-1/4-1-after",
    ]);
  });

  it("records a non-git workspace once and stops asking for the rest of the turn", async () => {
    snapshotAnswer = () => ({ snapshotCapable: false, reason: "Not a git repository (or not a work tree): /work/repo" });

    await runScript([
      { kind: "tools", calls: ["write_file"] },
      { kind: "tools", calls: ["write_file"] },
      { kind: "text", text: "done" },
    ]);

    expect(snapshotRefs()).toEqual(["refs/prism/checkpoints/conv-1/1-1"]);
    expect(conversation.workspaceSnapshots).toBeUndefined();
    expect(conversation.workspaceSnapshotStatus).toMatchObject({
      capable: false,
      reason: expect.stringMatching(/not a git repository/i),
      workspaceRoot: "/work/repo",
    });
    expect(executeToolMock).toHaveBeenCalledTimes(2);
  });

  it("never blocks the tools when tools-service is unreachable", async () => {
    snapshotAnswer = () => "unreachable";

    await runScript([{ kind: "tools", calls: ["write_file"] }, { kind: "text", text: "done" }]);

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(snapshotRefs()).toEqual(["refs/prism/checkpoints/conv-1/1-1", "refs/prism/checkpoints/conv-1/1-1-after"]);
    expect(conversation.workspaceSnapshots).toBeUndefined();
  });

  it("does not snapshot without a workspace root", async () => {
    await runScript([{ kind: "tools", calls: ["write_file"] }, { kind: "text", text: "done" }], { workspaceRoot: null });
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(snapshotRequests).toHaveLength(0);
  });
});
