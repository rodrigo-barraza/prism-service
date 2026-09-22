/**
 * perCallApprovals.test.ts
 *
 * One model step emits a batch of three WRITE-tier calls. The user decides
 * each one on its own card, through the real `POST /agent/approve` route,
 * while a REAL ReActHarness waits at its real ApprovalGate (dependency mocks
 * mirror turnInputAcceptance.test.ts; the gate and the approval engine are
 * NOT mocked here — they are what is under test).
 *
 *   - Allowing #2 decides #2 only: #1 and #3 stay pending, nothing runs yet.
 *   - Denying #1 with a reason puts that reason in #1's tool result.
 *   - Allowing #3 runs it; the batch then runs #2 and #3 together.
 *   - The next model request carries the three results in the model's order.
 *
 * Plus: an edited call runs with the user's arguments and the edit is kept
 * on the persisted call; "auto-approve this conversation" clears its batch
 * and every later batch of the turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import AgenticLoopService from "#src/services/AgenticLoopService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import agentRouter from "#src/routes/AgentRoutes";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Heavy mocks (mirrors turnInputAcceptance.test.ts, minus the gate) ─

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  PROVIDER_SGLANG: [],
  getModelRoleChainFromEnvironment: () => [],
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    register: vi.fn(),
    complete: vi.fn(),
    cleanup: vi.fn(),
    setEstimatedInputTokens: vi.fn(),
  },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));

vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
    get: (_locale: string, key: string, variables?: Record<string, string>) =>
      `[locale:${key}]${variables ? ` ${JSON.stringify(variables)}` : ""}`,
  },
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
    // The REAL engine: write_file is tier WRITE, so every call needs a human.
    approvalEngine: new AutoApprovalEngine({ fullAuto: false }),
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
}));

vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    countRunningTasks: vi.fn().mockReturnValue(0),
    hasActiveTask: vi.fn().mockReturnValue(false),
    listTasks: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));

vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lifecycle/OutputTruncationRecovery.ts", () => ({
  isOutputTruncated: vi.fn().mockReturnValue(false),
  injectContinuationContext: vi.fn(),
  injectErrorAsConversationMessage: vi.fn(),
  buildExhaustedRecoveryMessage: vi.fn().mockReturnValue("exhausted-recovery"),
  buildProviderErrorMessage: vi.fn().mockReturnValue("provider-error"),
  MAX_OUTPUT_TRUNCATION_RECOVERIES: 3,
  isAtOutputCeiling: vi.fn().mockReturnValue(false),
}));

vi.mock("../lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({
    messages,
    compactionPerformed: false,
  })),
}));

vi.mock("../lifecycle/ContextExhaustionGuard.ts", () => ({
  isContextExhausted: vi.fn().mockReturnValue(false),
  logContextExhaustion: vi.fn(),
  emitContextExhaustedStatus: vi.fn(),
  buildContextExhaustedMessage: vi.fn().mockReturnValue("context-exhausted"),
}));

vi.mock("../lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("../lifecycle/TrackerFinalizer.ts", () => ({ finalizePassTracker: vi.fn() }));
vi.mock("../lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));
vi.mock("../lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: vi.fn().mockReturnValue(false) }));
vi.mock("../lifecycle/PlanModeController.ts", () => ({
  blockUnauthorizedToolCalls: vi.fn(),
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({
  buildToolRetryGuidance: vi.fn().mockReturnValue(null),
}));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()), cleanupInMemory: vi.fn() },
}));
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    // The approval preview reads the current file; the scratch files are new.
    executeTool: vi.fn().mockResolvedValue({ error: "File not found" }),
    isStreamable: vi.fn().mockReturnValue(false),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── Harness factory ──────────────────────────────────────────

const WRITE_FILE_SCHEMA = {
  name: "write_file",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      createDirs: { type: "boolean" },
    },
    required: ["path", "content"],
  },
};

interface ScriptedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type Turn = { kind: "tools"; calls: ScriptedCall[] } | { kind: "text"; text: string };

function buildScriptedHarness(conversationId: string, script: Turn[]) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
    generateTextStreamLive: undefined,
    discoverContextWindow: vi.fn(),
  };
  const emit = vi.fn();
  const context: AgenticContext = {
    project: "prism-test",
    username: "test-user",
    agent: "CODING",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
    traceId: "test-trace",
    // Deliberately different from conversationId: the client never sends an
    // agentConversationId, so a root turn's two ids differ in production.
    agentConversationId: `agent-${conversationId}`,
    conversationId,
    provider: mockProvider as any,
    options: {
      maxIterations: 4,
      autoApprove: false,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      tools: [WRITE_FILE_SCHEMA],
    },
    messages: [{ role: "user", content: "Create three files" }],
    emit,
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [WRITE_FILE_SCHEMA] as any,
    resolvedEnabledTools: ["write_file"],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as any).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[]) => {
      iteration++;
      seenMessages.push(messages.map((message) => structuredClone(message)));
      return mockProvider.generateTextStream();
    },
  );
  (harness as any).consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tools") {
        pass.streamedText = "";
        pass.finalStreamedText = "";
        pass.pendingToolCalls = turn.calls.map((call) => ({ ...call, args: { ...call.args } }));
        for (const call of turn.calls) state.streamedToolCalls.push({ ...call, args: { ...call.args } });
      } else {
        pass.streamedText = turn.text;
        pass.finalStreamedText = turn.text;
        pass.pendingToolCalls = [];
        state.finalStreamedText = turn.text;
      }
      pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
    },
  );
  (harness as any).enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  (harness as any).finalize = vi.fn().mockResolvedValue(undefined);
  (harness as any).logIteration = vi.fn();
  (harness as any).emitGenerationProgress = vi.fn();
  (harness as any).emitUsageUpdate = vi.fn();
  (harness as any).checkAndApplyToolSetChanges = vi.fn();

  return { harness, context, emit, seenMessages };
}

const THREE_WRITES: ScriptedCall[] = [
  { id: "call-1", name: "write_file", args: { path: "one.txt", content: "one\n" } },
  { id: "call-2", name: "write_file", args: { path: "two.txt", content: "two\n" } },
  { id: "call-3", name: "write_file", args: { path: "three.txt", content: "three\n" } },
];

function approvalEvents(emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls
    .map((call) => call[0])
    .filter((event) => event?.type === "approval_required");
}

function executedIds(): string[] {
  return executeToolBatchMock.mock.calls.flatMap((call) =>
    (call[0] as ScriptedCall[]).map((toolCall) => toolCall.id),
  );
}

const app = express();
app.use(express.json());
app.use("/agent", agentRouter);
const http = supertest(app);

// ── Scenarios ────────────────────────────────────────────────

describe("per-call approvals — one batch, three cards, three decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    executeToolBatchMock.mockImplementation(async (toolCalls: ScriptedCall[]) =>
      toolCalls.map((toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        result: { success: true, wrote: toolCall.args.path },
        durationMilliseconds: 5,
      })),
    );
  });

  it("decides each call on its own and feeds the results back in the model's order", async () => {
    const conversationId = "per-call-conv";
    const { harness, emit, seenMessages } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: THREE_WRITES },
      { kind: "text", text: "Wrote two of three; you declined one.txt." },
    ]);

    const running = harness.run();
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(3));

    // Allow #2 only.
    const allowSecond = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-2", decision: "allow" });
    expect(allowSecond.status).toBe(200);

    // Give a wrongly-resolved batch every chance to start executing.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(executedIds(), "nothing runs until every call in the batch is decided").toEqual([]);
    const pending = AgenticLoopService.getPendingApproval(conversationId);
    expect(pending.isPending).toBe(true);
    expect((pending.toolCalls ?? []).map((toolCall) => toolCall.id).sort()).toEqual(["call-1", "call-3"]);

    // Deny #1 with a reason.
    const denyFirst = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "deny", reason: "not that file" });
    expect(denyFirst.status).toBe(200);
    expect(executedIds()).toEqual([]);

    // Allow #3 — the batch is now fully decided and proceeds.
    const allowThird = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-3", decision: "allow" });
    expect(allowThird.status).toBe(200);

    await running;

    expect(executedIds()).toEqual(["call-2", "call-3"]);

    // The provider's next request: results in the model's original order.
    expect(seenMessages).toHaveLength(2);
    const assistantWithCalls = seenMessages[1].find(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    expect(assistantWithCalls?.toolCalls?.map((toolCall) => toolCall.id)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    const [first, second, third] = assistantWithCalls!.toolCalls!;
    expect(JSON.stringify(first.result)).toContain("not that file");
    expect(first.result).toMatchObject({ success: false, error: "USER_REJECTED" });
    expect(second.result).toMatchObject({ success: true, wrote: "two.txt" });
    expect(third.result).toMatchObject({ success: true, wrote: "three.txt" });
  });

  it("runs an edited call with the user's arguments and records the edit on the persisted call", async () => {
    const conversationId = "per-call-edit";
    const { harness, emit, seenMessages } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: [THREE_WRITES[0]] },
      { kind: "text", text: "done" },
    ]);

    const running = harness.run();
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(1));

    const edited = await http.post("/agent/approve").send({
      conversationId,
      toolCallId: "call-1",
      decision: "allow",
      editedArgs: { path: "renamed.txt", content: "one\n" },
    });
    expect(edited.status).toBe(200);
    await running;

    const executed = executeToolBatchMock.mock.calls[0][0] as ScriptedCall[];
    expect(executed[0].args).toEqual({ path: "renamed.txt", content: "one\n" });
    const persisted = seenMessages[1].find((message) => (message.toolCalls?.length ?? 0) > 0)!.toolCalls![0];
    expect(persisted.args).toEqual({ path: "renamed.txt", content: "one\n" });
    expect(persisted._approval).toMatchObject({
      isApproved: true,
      decidedBy: "user",
      editedByUser: true,
      originalArgs: { path: "one.txt", content: "one\n" },
    });
  });

  it('"auto-approve this conversation" clears the batch and every later batch of the turn', async () => {
    const conversationId = "per-call-conversation-scope";
    const { harness, emit, context } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: THREE_WRITES.slice(0, 2) },
      { kind: "tools", calls: [{ id: "call-9", name: "write_file", args: { path: "nine.txt", content: "9" } }] },
      { kind: "text", text: "done" },
    ]);

    const running = harness.run();
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(2));
    const response = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow", scope: "conversation" });
    expect(response.status).toBe(200);
    expect(response.body.decidedToolCallIds).toEqual(["call-1", "call-2"]);
    await running;

    expect(executedIds()).toEqual(["call-1", "call-2", "call-9"]);
    // The second batch never asked.
    expect(approvalEvents(emit)).toHaveLength(2);
    expect(context.options.autoApprove).toBe(true);
  });
});
