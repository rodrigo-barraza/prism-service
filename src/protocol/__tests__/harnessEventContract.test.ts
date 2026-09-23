/**
 * harnessEventContract.test.ts — a scripted agent turn through a REAL
 * ReActHarness, with the real stream router, approval gate, post-execution
 * emitter, budget tracker and finalizer. Every event the loop emits must be
 * a valid `TurnEvent` (src/protocol/events.ts).
 *
 * The scripted turn: the model thinks, writes, streams a write_file call
 * (tier WRITE, so it waits for a human), the call is approved through the
 * real POST /agent/approve route and runs, and the second pass answers.
 * Dependency mocks mirror perCallApprovals.test.ts, minus everything that
 * emits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import ReActHarness from "#src/services/harnesses/ReActHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import agentRouter from "#src/routes/AgentRoutes";
import { validateTurnEvent } from "#src/protocol/events";
import type { AgenticContext, ResolvedTools } from "#src/services/harnesses/types";

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
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
    provider: vi.fn(),
  },
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));

vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
    get: (_locale: string, key: string) => `[locale:${key}]`,
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
    approvalEngine: new AutoApprovalEngine({ fullAuto: false }),
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const executeToolBatchMock = vi.fn();
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
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
  default: {
    awaitPendingDispatches: vi.fn().mockResolvedValue(undefined),
    markUndeliveredDispatchesAsCounted: vi.fn().mockReturnValue(0),
  },
}));

vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/KVCacheReporter", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("#src/services/harnesses/lifecycle/ToolDiscoveryNudge", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("#src/services/harnesses/lifecycle/SystemReminderInjector", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined), uploadFile: vi.fn() },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ error: "File not found" }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue("📝"),
    getToolLabel: vi.fn().mockImplementation((name: string) => `Running ${name}`),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

const WRITE_FILE_SCHEMA = {
  name: "write_file",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

/** What the provider streams on each pass. */
const PASSES: unknown[][] = [
  [
    { type: "thinking", content: "The user wants a file. I will write it." },
    "I'll write the file now.",
    { type: "toolCallStart", id: "call-1", name: "write_file" },
    { type: "toolCall", id: "call-1", name: "write_file", args: { path: "notes.txt", content: "hi\n" } },
    { type: "usage", usage: { inputTokens: 120, outputTokens: 30 } },
  ],
  [
    "Wrote notes.txt.",
    { type: "usage", usage: { inputTokens: 180, outputTokens: 8, cacheReadInputTokens: 100 } },
  ],
];

function buildHarness(conversationId: string) {
  const events: unknown[] = [];
  const context: AgenticContext = {
    project: "prism-test",
    username: "test-user",
    agent: "CODING",
    providerName: "anthropic",
    resolvedModel: "claude-sonnet-5",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as never,
    traceId: "trace-contract",
    agentConversationId: `agent-${conversationId}`,
    conversationId,
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() } as never,
    options: {
      maxIterations: 4,
      autoApprove: false,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      tools: [WRITE_FILE_SCHEMA],
    },
    messages: [{ role: "user", content: "Write notes.txt" }],
    emit: (event: unknown) => events.push(structuredClone(event)),
    signal: undefined as never,
    requestId: "req-contract",
    requestStart: performance.now(),
    isNewConversation: true,
  } as never;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [WRITE_FILE_SCHEMA] as never,
    resolvedEnabledTools: ["write_file"],
  };
  const harness = new ReActHarness(context, state, tools);
  let pass = 0;
  (harness as unknown as { createProviderStream: unknown }).createProviderStream = vi
    .fn()
    .mockImplementation(async () => {
      const chunks = PASSES[pass++] ?? ["Done."];
      return (async function* () {
        yield* chunks;
      })();
    });
  return { harness, events };
}

const app = express();
app.use(express.json());
app.use("/agent", agentRouter);
const http = supertest(app);

describe("a scripted agent turn emits only protocol events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ id: string; name: string }>) =>
      toolCalls.map((toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        result: { success: true, path: "notes.txt" },
        durationMilliseconds: 7,
      })),
    );
  });

  it("thinking, text, an approved tool call and a final answer", async () => {
    const conversationId = "contract-conv";
    const { harness, events } = buildHarness(conversationId);

    const running = harness.run();
    await vi.waitFor(() =>
      expect(events.some((event) => (event as { type: string }).type === "approval_required")).toBe(true),
    );
    const approve = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow" });
    expect(approve.status).toBe(200);
    await running;

    const types = events.map((event) => (event as { type: string }).type);
    // The scenario really exercised the events it is meant to pin.
    for (const type of ["thinking", "chunk", "tool_execution", "approval_required", "approval_decided", "status", "done"]) {
      expect(types, `no ${type} event was emitted`).toContain(type);
    }
    const violations = events.flatMap((event) => {
      const result = validateTurnEvent(event);
      return result.success
        ? []
        : [{ event, issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }];
    });
    expect(violations).toEqual([]);
  });
});
