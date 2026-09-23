/**
 * compactionThatWorks.test.ts
 *
 * Compaction exercised through a REAL ReActHarness — the real context
 * pressure pipeline (micro-compaction, auto-compaction, LLM summarization,
 * offload store), the real ContextWindowManager truncation and the real
 * Finalizer. Only the model, the tools and the database are scripted:
 *
 *   1. A long single run (one user message, 40 tool iterations of ~4K-token
 *      results) offloads its old tool results and stops growing linearly;
 *      the stubs stay retrievable and the persisted transcript keeps every
 *      result verbatim.
 *   2. Compaction is paid once: a turn over the threshold summarizes and
 *      persists the boundary, and the next turn — loaded through that
 *      boundary — does not summarize again.
 *   3. Order: summarization before lossy truncation, and truncation only
 *      when compaction failed or is impossible, with the reason logged.
 *   4. The trigger follows provider-reported input tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import ContextWindowManager from "#src/services/ContextWindowManager";
import CompactionService from "#src/services/compact/CompactionService";
import ToolResultOffloadService, {
  OFFLOAD_STUB_HEADER,
} from "#src/services/compact/ToolResultOffloadService";
import retrieveOffloadedContent from "#src/services/tool-definitions/RetrieveOffloadedContentTool";
import RequestLogger from "#src/services/RequestLogger";
import logger from "#src/utils/logger";
import { appendAndFinalize } from "#src/utils/ConversationUtilities";
import { prepareDisplayMessages } from "#src/services/conversation/prepareDisplayMessages";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { COMPACTION } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";
import type { ChatMessage } from "#src/types/admin";
import {
  followMintedAnchor,
  type CompactionBoundary,
} from "#src/services/compact/CompactionBoundary";
import { mintMessageIds } from "#src/services/conversation/messageIds";

// ── Mocks: model, tools, database — the context pipeline stays real ──

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => {
      throw new Error("no database in unit tests");
    },
    getCollection: () => {
      throw new Error("no database in unit tests");
    },
  },
}));

vi.mock("#src/utils/ConversationUtilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/utils/ConversationUtilities")>()),
  appendAndFinalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn() },
}));

vi.mock("#src/services/ConversationEmbeddingService", () => ({
  default: { persistCompactionSummary: vi.fn().mockResolvedValue(undefined) },
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

const mockSummarizerGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: (...args: unknown[]) => mockSummarizerGenerateText(...args),
  })),
  providers: {},
}));

vi.mock("#src/services/ModelRoleRouter", () => ({
  MODEL_ROLES: { UTILITY: "utility", COMPACTION: "compaction" },
  default: {
    resolveChain: vi.fn().mockResolvedValue([{ provider: "utility-provider", model: "utility-model" }]),
    runWithChain: vi.fn().mockImplementation(
      async (
        chain: Array<{ provider: string; model: string }>,
        run: (entry: { provider: string; model: string }) => Promise<unknown>,
      ) => ({ value: await run(chain[0]) }),
    ),
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

const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
}));

vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
    saveTurnCheckpoint: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: vi.fn().mockReturnValue("mock-stash-ref"),
  restoreSandboxCheckpoint: vi.fn(),
}));
vi.mock("../lifecycle/PlanModeController.ts", () => ({
  blockUnauthorizedToolCalls: vi.fn(),
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: vi.fn().mockReturnValue(null) }));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()), get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn(), uploadFile: vi.fn() } }));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── Scripted harness ─────────────────────────────────────────

/** A tool that micro-compaction may evict (large, re-derivable output). */
const COMPACTABLE_TOOL = TOOL_NAMES.READ_FILE;
/** A tool whose results micro-compaction must leave alone. */
const NON_COMPACTABLE_TOOL = "lookup_ledger";

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

interface HarnessSpec {
  /** modelDefinition.maxInputTokens */
  contextWindow: number;
  /** options.maxTokens */
  maxTokens: number;
  /** The history the client sends; the harness appends nothing before it. */
  messages: ConversationMessage[];
  /** true → nothing in `messages` is persisted yet (first turn). */
  isNewConversation: boolean;
  script: (iteration: number, seen: ConversationMessage[]) => Turn;
  toolResult: (toolName: string, iteration: number) => unknown;
  /** Provider-reported input tokens for iteration N (default: the chars/4 size of what it saw). */
  reportedInputTokens?: (iteration: number, seen: ConversationMessage[]) => number;
  maxIterations?: number;
  conversationId?: string;
}

function estimateOf(messages: ConversationMessage[]): number {
  return ContextWindowManager.estimateTokens(messages as ChatMessage[]);
}

function buildHarness(spec: HarnessSpec) {
  const conversationId = spec.conversationId ?? "conversation-under-test";
  let iteration = 0;
  const seen: ConversationMessage[][] = [];
  const seenOptions: Record<string, unknown>[] = [];

  const emit = vi.fn();
  const context: AgenticContext = {
    project: "prism-test",
    username: "test-user",
    agent: "OMNI",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: spec.contextWindow, maxOutputTokens: spec.maxTokens } as any,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() } as any,
    options: {
      maxIterations: spec.maxIterations ?? 60,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: spec.maxTokens,
    },
    messages: spec.messages,
    emit,
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: spec.isNewConversation,
  } as any;

  const state = new AgenticLoopState({ originalMessageCount: spec.messages.length });
  const tools: ResolvedTools = {
    finalTools: [
      { name: COMPACTABLE_TOOL, description: "Read a file", parameters: {} },
      { name: NON_COMPACTABLE_TOOL, description: "Look up the ledger", parameters: {} },
    ] as any,
    resolvedEnabledTools: [COMPACTABLE_TOOL, NON_COMPACTABLE_TOOL],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as any).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[], passOptions: Record<string, unknown>) => {
      iteration++;
      seen.push(messages.map((message) => ({ ...message })));
      seenOptions.push(passOptions);
      return (async function* () {
        yield "";
      })();
    },
  );
  (harness as any).consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const messagesSeen = seen[iteration - 1];
      const turn = spec.script(iteration, messagesSeen);
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tool") {
        const call = { id: `call-${iteration}`, name: turn.toolName, args: turn.args ?? { iteration } };
        pass.streamedText = "";
        pass.finalStreamedText = "";
        pass.pendingToolCalls = [call];
        state.streamedToolCalls.push({ ...call });
      } else {
        pass.streamedText = turn.text;
        pass.finalStreamedText = turn.text;
        pass.pendingToolCalls = [];
        state.finalStreamedText = turn.text;
      }
      const reported = spec.reportedInputTokens
        ? spec.reportedInputTokens(iteration, messagesSeen)
        : estimateOf(messagesSeen);
      pass.usage = {
        inputTokens: reported,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      };
    },
  );
  (harness as any).logIteration = vi.fn();
  (harness as any).emitGenerationProgress = vi.fn();
  (harness as any).emitUsageUpdate = vi.fn();
  (harness as any).checkAndApplyToolSetChanges = vi.fn();

  executeToolBatchMock.mockImplementation(
    async (toolCalls: Array<{ id: string; name: string }>) =>
      toolCalls.map((toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        result: spec.toolResult(toolCall.name, iteration),
        durationMilliseconds: 5,
      })),
  );

  return { harness, context, state, emit, seen, seenOptions, iterations: () => iteration };
}

/** `tokens` tokens (chars/4) of multi-line text, unique per `tag` and per line. */
function bulkText(tag: string, tokens: number): string {
  const lineCount = Math.ceil((tokens * 4) / 80);
  return Array.from({ length: lineCount }, (_, index) =>
    `${tag}:${index}:`.padEnd(79, "x"),
  ).join("\n");
}

function statusEvents(emit: ReturnType<typeof vi.fn>, message: string) {
  return emit.mock.calls
    .map(([event], index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event?.type === SERVER_SENT_EVENT_TYPES.STATUS && event?.message === message,
    );
}

function summarizeCalls() {
  return vi
    .mocked(RequestLogger.logBackgroundLlmCall)
    .mock.calls.filter(([entry]) => entry.operation === "compact:summarize");
}

function lastAppend() {
  const calls = vi.mocked(appendAndFinalize).mock.calls;
  const [, , , messages, meta] = calls[calls.length - 1];
  return { messages: messages as ChatMessage[], meta: (meta || {}) as Record<string, unknown> };
}

const SUMMARY_TEXT =
  "SUMMARY-OF-EARLIER-WORK: the user asked for a ledger review; files were read; nothing is pending.";

beforeEach(() => {
  vi.clearAllMocks();
  CompactionService.resetCircuitBreaker();
  ToolResultOffloadService.clearMemoryCache();
  mockSummarizerGenerateText.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
    const isJudge = messages[0]?.content?.includes("compaction validator");
    return isJudge
      ? { text: "<ok/>", usage: { inputTokens: 50, outputTokens: 5 } }
      : { text: `<summary>${SUMMARY_TEXT}</summary>`, usage: { inputTokens: 500, outputTokens: 50 } };
  });
});

// ── 1. Long single run ───────────────────────────────────────

describe("a long single run shrinks instead of growing linearly", () => {
  it("offloads old tool results of the CURRENT run, keeps them retrievable, and persists them verbatim", async () => {
    const TOOL_ITERATIONS = 40;
    const RESULT_TOKENS = 4_000;
    const originals = new Map<number, string>();
    const { harness, seen } = buildHarness({
      contextWindow: 128_000,
      maxTokens: 8_192,
      messages: [{ role: "user", content: "Review every ledger file and report the totals." }],
      isNewConversation: true,
      maxIterations: TOOL_ITERATIONS + 5,
      script: (iteration) =>
        iteration <= TOOL_ITERATIONS
          ? { kind: "tool", toolName: COMPACTABLE_TOOL, args: { path: `ledger-${iteration}.csv` } }
          : { kind: "text", text: "All ledgers reviewed." },
      toolResult: (_name, iteration) => {
        const text = bulkText(`ledger-${iteration}`, RESULT_TOKENS);
        originals.set(iteration, text);
        return text;
      },
    });

    await harness.run();

    const perIteration = seen.map(estimateOf);
    const naiveFinal = TOOL_ITERATIONS * RESULT_TOKENS;
    // Linear growth would put the last call near 160K tokens.
    expect(perIteration[TOOL_ITERATIONS]).toBeLessThan(naiveFinal * 0.6);
    // And no call ever went past the auto-compaction threshold by more than
    // the force buffer (the deferral guard's documented ceiling).
    const threshold = 128_000 - Math.min(8_192, COMPACTION.MAX_OUTPUT_TOKENS_FOR_SUMMARY) - COMPACTION.AUTOCOMPACT_BUFFER_TOKENS;
    expect(Math.max(...perIteration)).toBeLessThan(threshold + COMPACTION.AUTOCOMPACT_BUFFER_TOKENS);

    // Old results of this very run are now recoverable stubs.
    const finalView = seen[seen.length - 1] as ChatMessage[];
    const stubs = finalView
      .flatMap((message) => message.toolCalls ?? [])
      .map((toolCall) => toolCall.result)
      .filter(
        (result): result is string =>
          typeof result === "string" && result.startsWith(OFFLOAD_STUB_HEADER),
      );
    expect(stubs.length).toBeGreaterThan(10);

    // retrieve_offloaded_content hands back the full original.
    const offloadId = /offload_id:\s*(\S+)/.exec(stubs[0])![1];
    const record = await ToolResultOffloadService.getRecord(offloadId);
    const iterationOfStub = Number(/ledger-(\d+)/.exec(record!.content)![1]);
    const retrieved = await retrieveOffloadedContent.execute(
      { offloadId, startLine: 1, endLine: 100_000 },
      {} as any,
    );
    const recovered = (retrieved as { content: string }).content
      .split("\n")
      .map((line) => line.replace(/^\d+: /, ""))
      .join("\n");
    expect(recovered).toBe(originals.get(iterationOfStub));

    // The persisted transcript is the whole turn, verbatim: the user message
    // once, and all 40 results in full — never a stub.
    const { messages: persisted } = lastAppend();
    expect(persisted.filter((message) => message.role === "user")).toHaveLength(1);
    const persistedResults = persisted.filter((message) => message.role === "tool");
    expect(persistedResults).toHaveLength(TOOL_ITERATIONS);
    for (const toolMessage of persistedResults) {
      expect(toolMessage.content).not.toContain(OFFLOAD_STUB_HEADER);
    }
    expect(persistedResults[0].content).toBe(originals.get(1));
  });
});

// ── 2. Paid once ─────────────────────────────────────────────

/** A persisted history: `exchanges` user/assistant pairs of ~`tokensEach` tokens of text. */
function persistedHistory(exchanges: number, tokensEach: number): ConversationMessage[] {
  const history: ConversationMessage[] = [];
  for (let exchange = 1; exchange <= exchanges; exchange++) {
    history.push({ role: "user", content: `question ${exchange}`, id: `u-${exchange}` } as ConversationMessage);
    history.push({
      role: "assistant",
      content: bulkText(`answer-${exchange}`, tokensEach),
      id: `a-${exchange}`,
    } as ConversationMessage);
  }
  return history;
}

/** What AgenticLoopService does to a loaded history before the harness runs. */
function markPersisted(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message, index) =>
    index < messages.length - 1 ? { ...message, _alreadyPersisted: true } : { ...message },
  );
}

describe("compaction is paid once", () => {
  it("turn 1 summarizes and persists the boundary; turn 2 loads through it and does not summarize again", async () => {
    // ── Turn 1: 8 exchanges × ~14K tokens ≈ 112K > the 106.8K threshold.
    const history = persistedHistory(8, 14_000);
    const turn1 = buildHarness({
      contextWindow: 128_000,
      maxTokens: 8_192,
      messages: markPersisted([...history, { role: "user", content: "turn-1 question" }]),
      isNewConversation: false,
      script: () => ({ kind: "text", text: "turn-1 answer" }),
      toolResult: () => null,
    });
    await turn1.harness.run();

    expect(summarizeCalls()).toHaveLength(1);
    expect(statusEvents(turn1.emit, STATUS_MESSAGES.COMPACTION_COMPLETE)).toHaveLength(1);

    const { messages: persistedTurn1, meta } = lastAppend();
    const boundary = meta.compaction as CompactionBoundary;
    expect(boundary).toBeDefined();
    expect(boundary.summary).toContain(SUMMARY_TEXT);
    expect(boundary.tokensAfter).toBeLessThan(boundary.tokensBefore);
    expect(boundary.model).toBe("utility-model");
    // The boundary names a message the client will send back.
    expect(history.map((message) => message.id)).toContain(boundary.throughMessageId);
    // What appendMessages stores: every appended message gets its minted id,
    // and the boundary (anchored in an earlier turn) is left as it is.
    const storedTurn1 = mintMessageIds(persistedTurn1);
    expect(followMintedAnchor(boundary, persistedTurn1, storedTurn1)).toBe(boundary);
    // The compaction event carries the boundary for the client's marker.
    const completeEvent = statusEvents(turn1.emit, STATUS_MESSAGES.COMPACTION_COMPLETE)[0].event;
    expect(completeEvent.boundary?.throughMessageId).toBe(boundary.throughMessageId);

    // ── Turn 2: the client sends back everything it loaded, plus a question.
    vi.mocked(RequestLogger.logBackgroundLlmCall).mockClear();
    const clientHistory = [
      ...prepareDisplayMessages([...history, ...storedTurn1] as ChatMessage[]),
      { role: "user", content: "turn-2 question" },
    ] as ConversationMessage[];
    const { applyCompactionBoundary } = await import("#src/services/compact/CompactionBoundary");
    const loaded = applyCompactionBoundary(clientHistory, boundary);
    expect(loaded.applied).toBe(true);

    const turn2 = buildHarness({
      contextWindow: 128_000,
      maxTokens: 8_192,
      messages: markPersisted(loaded.messages as ConversationMessage[]),
      isNewConversation: false,
      script: () => ({ kind: "text", text: "turn-2 answer" }),
      toolResult: () => null,
    });
    await turn2.harness.run();

    expect(summarizeCalls()).toHaveLength(0);
    // The provider got: system (as a first-class parameter), then the
    // summary, then only the messages after the boundary.
    expect(turn2.seenOptions[0].systemPrompt).toBe("You are a test agent.");
    const firstCall = turn2.seen[0] as ChatMessage[];
    expect(firstCall[0].isCompactSummary).toBe(true);
    expect(firstCall[0].content).toContain(SUMMARY_TEXT);
    const anchorIndex = history.findIndex((message) => message.id === boundary.throughMessageId);
    for (const covered of history.slice(0, anchorIndex + 1)) {
      expect(firstCall.some((message) => message.content === covered.content)).toBe(false);
    }
    for (const kept of history.slice(anchorIndex + 1)) {
      expect(firstCall.some((message) => message.content === kept.content)).toBe(true);
    }
    expect(firstCall[firstCall.length - 1].content).toBe("turn-2 question");
    // The summary is context, not transcript: turn 2 persists only its own messages.
    const { messages: persistedTurn2 } = lastAppend();
    expect(persistedTurn2.some((message) => message.isCompactSummary)).toBe(false);
    expect(persistedTurn2.map((message) => message.content)).toEqual(["turn-2 question", "turn-2 answer"]);
  });
});

// ── 3. Order: summarization before truncation ────────────────

describe("summarization comes before lossy truncation (200K window, 64K max output)", () => {
  const WINDOW = 200_000;
  const MAX_OUT = 64_000;

  it("does not truncate a history that is still under the compaction threshold", async () => {
    // ~150K: over the old 107K truncation budget, under the 167K threshold.
    const history = persistedHistory(10, 15_000);
    const { harness, emit } = buildHarness({
      contextWindow: WINDOW,
      maxTokens: MAX_OUT,
      messages: markPersisted([...history, { role: "user", content: "next question" }]),
      isNewConversation: false,
      script: () => ({ kind: "text", text: "answer" }),
      toolResult: () => null,
    });
    await harness.run();

    expect(statusEvents(emit, STATUS_MESSAGES.CONTEXT_TRUNCATED)).toHaveLength(0);
    expect(summarizeCalls()).toHaveLength(0);
  });

  it("when a run is over both budgets, it is summarized and never truncated", async () => {
    // A single run whose results micro-compaction cannot evict, growing
    // ~10K tokens per iteration well past 167K (threshold) and 177K.
    const { harness, emit, seen } = buildHarness({
      contextWindow: WINDOW,
      maxTokens: MAX_OUT,
      messages: [{ role: "user", content: "Reconcile the ledger." }],
      isNewConversation: true,
      maxIterations: 30,
      script: (iteration) =>
        iteration <= 24
          ? { kind: "tool", toolName: NON_COMPACTABLE_TOOL }
          : { kind: "text", text: "Reconciled." },
      toolResult: (_name, iteration) => bulkText(`entry-${iteration}`, 10_000),
    });
    await harness.run();

    const compacted = statusEvents(emit, STATUS_MESSAGES.COMPACTION_COMPLETE);
    expect(compacted.length).toBeGreaterThan(0);
    expect(statusEvents(emit, STATUS_MESSAGES.CONTEXT_TRUNCATED)).toHaveLength(0);
    // Compaction fires at its force threshold (167K + 6.5K); no call ever
    // needed the ~177K truncation budget ((200K − 1,024 − 4,096) / 1.1).
    expect(Math.max(...seen.map(estimateOf))).toBeLessThan(177_000);

    // The boundary is anchored in THIS run, so it names its message by the
    // provisional id the message is appended with; appendMessages mints the
    // stored id and re-points the boundary at it.
    const { messages: appended, meta } = lastAppend();
    const boundary = meta.compaction as CompactionBoundary;
    expect(boundary.throughMessageId).toMatch(/^msg_/);
    const anchorIndex = appended.findIndex((message) => message.id === boundary.throughMessageId);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    const stored = mintMessageIds(appended);
    const storedBoundary = followMintedAnchor(boundary, appended, stored);
    expect(storedBoundary.throughMessageId).toBe(stored[anchorIndex].id);
    expect(storedBoundary.throughMessageId).not.toBe(boundary.throughMessageId);
  });

  it("truncates only when compaction cannot run, and logs why", async () => {
    mockSummarizerGenerateText.mockRejectedValue(new Error("utility model down"));
    const { harness, emit } = buildHarness({
      contextWindow: WINDOW,
      maxTokens: MAX_OUT,
      messages: [{ role: "user", content: "Reconcile the ledger." }],
      isNewConversation: true,
      maxIterations: 30,
      script: (iteration) =>
        iteration <= 24
          ? { kind: "tool", toolName: NON_COMPACTABLE_TOOL }
          : { kind: "text", text: "Reconciled." },
      toolResult: (_name, iteration) => bulkText(`entry-${iteration}`, 10_000),
    });
    await harness.run();

    expect(statusEvents(emit, STATUS_MESSAGES.CONTEXT_TRUNCATED).length).toBeGreaterThan(0);
    const logLines = [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls]
      .map(([line]) => String(line));
    const truncationReasons = logLines.filter((line) =>
      /truncat/i.test(line) && /compaction (failed|breaker open|impossible)/i.test(line),
    );
    expect(truncationReasons.length).toBeGreaterThan(0);
  });
});

// ── 3b. Same units for trigger and truncation ────────────────

describe("truncation and the trigger measure the same thing", () => {
  it("does not truncate while the REPORTED request is under the threshold, however chars/4 overcounts", async () => {
    // Found live (PDF text + 93 tool schemas): real input ran at ~0.7 of
    // chars/4. Truncation measured chars/4 and fired at ~50K real tokens,
    // below the 58.8K compaction threshold of an 80K window.
    const { harness, emit, seen } = buildHarness({
      contextWindow: 80_000,
      maxTokens: 8_192,
      messages: [{ role: "user", content: "Read every PDF." }],
      isNewConversation: true,
      maxIterations: 22,
      script: (iteration) =>
        iteration <= 18
          ? { kind: "tool", toolName: NON_COMPACTABLE_TOOL }
          : { kind: "text", text: "Read them all." },
      toolResult: (_name, iteration) => bulkText(`pdf-${iteration}`, 4_000),
      reportedInputTokens: (_iteration, messagesSeen) => Math.round(estimateOf(messagesSeen) * 0.6),
    });
    await harness.run();

    // chars/4 went well past the ~68K truncation budget…
    expect(Math.max(...seen.map(estimateOf))).toBeGreaterThan(70_000);
    // …but the real request never reached the 58.8K threshold: no summary,
    // and no lossy truncation either.
    expect(summarizeCalls()).toHaveLength(0);
    expect(statusEvents(emit, STATUS_MESSAGES.CONTEXT_TRUNCATED)).toHaveLength(0);
  });
});

// ── 4. Trigger on reality ────────────────────────────────────

describe("the trigger follows provider-reported input tokens", () => {
  it("compacts when reported usage crosses the threshold even though chars/4 says the history is small", async () => {
    const history = persistedHistory(4, 1_500);
    const { harness, emit, seen } = buildHarness({
      contextWindow: 128_000,
      maxTokens: 8_192,
      messages: markPersisted([...history, { role: "user", content: "keep going" }]),
      isNewConversation: false,
      maxIterations: 12,
      script: (iteration) =>
        iteration <= 6
          ? { kind: "tool", toolName: NON_COMPACTABLE_TOOL }
          : { kind: "text", text: "done" },
      toolResult: (_name, iteration) => bulkText(`row-${iteration}`, 500),
      // Dense content the heuristic undercounts: reality is ~30K per call.
      reportedInputTokens: (iteration) => 30_000 * iteration,
    });
    await harness.run();

    // chars/4 never gets near the 106.8K threshold…
    expect(Math.max(...seen.map(estimateOf))).toBeLessThan(40_000);
    // …yet the reported tokens did, so compaction fired,
    const compacted = statusEvents(emit, STATUS_MESSAGES.COMPACTION_COMPLETE);
    expect(compacted.length).toBeGreaterThan(0);
    // and the very next provider call carried the compacted history.
    const callsAfterCompaction = seen.filter((messages) =>
      (messages as ChatMessage[]).some((message) => message.isCompactSummary === true),
    );
    expect(callsAfterCompaction.length).toBeGreaterThan(0);
    expect((callsAfterCompaction[0] as ChatMessage[])[0].content).toContain(SUMMARY_TEXT);
  });
});
