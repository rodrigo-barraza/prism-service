/**
 * goalVerifiedOutcomes.test.ts
 *
 * A conversation goal is done when an INDEPENDENT verifier says so, not when
 * the agent says so. Driven end to end: a REAL AgenticLoopService →
 * REAL ReActHarness over a real goal document (tests/mongoMock), with the
 * main model scripted (prototype spies, as askUserAnswerReachesTurn) and the
 * verifier running through the REAL Anthropic provider against a mocked SDK
 * — so the assertions read the exact payload the verifier model receives.
 *
 * Main model: gemini-3.6-flash ($0.75 / $3.75 per M). Verifier:
 * claude-sonnet-5 ($2 / $10 per M). Each scripted main pass reports 10 000
 * input + 100 output tokens ($0.007875); each verifier call 20 000 + 1 000
 * ($0.05).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopService from "#src/services/AgenticLoopService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import ConversationGoalService from "#src/services/ConversationGoalService";
import { mergeUsage } from "#src/utils/CostCalculator";
import { createMockCollection } from "../../../../tests/mongoMock.ts";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── One Mongo store ──────────────────────────────────────────────────

const mongo = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof import("../../../../tests/mongoMock.ts").createMockCollection>>(),
}));

function mockCollection(name: string) {
  if (!mongo.collections.has(name)) mongo.collections.set(name, createMockCollection());
  return mongo.collections.get(name)!;
}

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection: create } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!mongo.collections.has(name)) mongo.collections.set(name, create());
    return mongo.collections.get(name)!;
  };
  return {
    default: {
      getDb: () => ({ collection }),
      getCollection: (_database: string, name: string) => collection(name),
    },
  };
});

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MONGO_DB_NAME: "prism-test",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_CLOUD_GEMINI_API_KEY: "fake",
  OPENAI_API_KEY: undefined,
  MOONSHOT_API_KEY: undefined,
  ANTHROPIC_FILES_API_ENABLED: false,
  ANTHROPIC_BASE_URL: undefined,
}));

// ── The verifier's provider: the real Anthropic adapter, SDK mocked ──

const anthropicSdk = vi.hoisted(() => ({
  create: [] as Array<Record<string, unknown>>,
  responses: [] as Array<{ text: string; inputTokens?: number; outputTokens?: number }>,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: (payload: Record<string, unknown>) => {
        anthropicSdk.create.push(structuredClone(payload));
        const next = anthropicSdk.responses.shift() ?? { text: "{}" };
        const data = {
          id: `msg-${anthropicSdk.create.length}`,
          model: payload.model,
          content: [{ type: "text", text: next.text }],
          usage: {
            input_tokens: next.inputTokens ?? 20_000,
            output_tokens: next.outputTokens ?? 1_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          stop_reason: "end_turn",
        };
        return {
          ...data,
          withResponse: async () => ({ data, response: { headers: { get: () => null } } }),
        };
      },
      stream: () => {
        throw new Error("the verifier makes one non-streaming call");
      },
    };
  },
}));

const providerRegistry = vi.hoisted(() => ({ anthropic: null as unknown }));

vi.mock("#src/providers/index", () => ({
  getProvider: (name: string) => {
    if (name === "anthropic" && providerRegistry.anthropic) return providerRegistry.anthropic;
    throw new Error(`no provider "${name}" in this test`);
  },
  listProviders: () => ["anthropic"],
}));

// ── Edges mocked; the loop and the goal are real ─────────────────────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn(), provider: vi.fn() },
}));
vi.mock("#src/routes/ChatRoutes", () => ({ handleAgent: vi.fn() }));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn(), cleanup: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
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
vi.mock("../lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: () => {
    const hooks = {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
        return undefined;
      }),
    };
    return { hooks, approvalEngine: {} };
  },
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));
vi.mock("#src/services/AgenticToolResolver", () => ({
  default: {
    resolve: vi.fn().mockResolvedValue({
      finalTools: [
        { name: "list_directory", description: "List a directory", parameters: {} },
        { name: "write_file", description: "Write a file", parameters: {} },
        { name: "read_file", description: "Read a file", parameters: {} },
      ],
      resolvedEnabledTools: ["list_directory", "write_file", "read_file"],
    }),
  },
}));
vi.mock("../lifecycle/PreflightToolDiscovery.ts", () => ({
  runPreflightToolDiscovery: vi.fn().mockResolvedValue({ enabledTools: [] }),
}));
vi.mock("#src/services/ToolContext", () => ({
  default: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    getStore: vi.fn().mockReturnValue(new Map()),
    set: vi.fn(),
    get: vi.fn(),
    cleanupInMemory: vi.fn(),
  },
}));

/** What the workspace tools return — the evidence the verifier must see. */
const toolResults: Record<string, unknown> = {};
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    isStreamable: vi.fn().mockReturnValue(false),
    executeTool: async (name: string) => toolResults[name] ?? { success: true },
  },
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
    cleanupConversation: vi.fn(),
    markUndeliveredDispatchesAsCounted: vi.fn().mockReturnValue(0),
  },
}));
vi.mock("../lifecycle/ApprovalGate.ts", () => ({
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
vi.mock("../lifecycle/PlanModeController.ts", () => ({
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: vi.fn().mockReturnValue(null) }));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
  NEEDS_YOU_WEBHOOK_EVENTS: { GOAL_UPDATED: "goal.updated" },
}));

// ── Scripted main model ──────────────────────────────────────────────

type ToolCallScript = { toolName: string; args?: Record<string, unknown> };
type Turn =
  | ({ kind: "tool"; narration?: string } & ToolCallScript)
  | { kind: "text"; text: string };

/** Reasoning the main model "thinks" on every pass — the verifier must never see it. */
const PRIVATE_REASONING = "PRIVATE-REASONING: the user will not check the bullet count";
/** What the model says alongside a tool call — narration, not evidence. */
const NARRATION = "NARRATION: I am fairly sure this is already correct";

let script: Turn[] = [];
let callIndex = 0;
let seen: ConversationMessage[][] = [];
let finalText = "";
let beforeCall: ((n: number) => Promise<void> | void) | null = null;

const PASS_USAGE = {
  inputTokens: 10_000,
  outputTokens: 100,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
};

function installScriptedModel() {
  const proto = ReActHarness.prototype as unknown as Record<string, unknown>;
  vi.spyOn(proto as any, "createProviderStream").mockImplementation((async function (
    this: unknown,
    messages: ConversationMessage[],
  ) {
    callIndex++;
    seen.push(messages.map((message) => ({ ...message })));
    if (beforeCall) await beforeCall(callIndex);
    return (async function* () {
      yield "";
    })();
  }) as any);
  vi.spyOn(proto as any, "consumeStream").mockImplementation((async function (
    this: { state: { streamedToolCalls: unknown[]; finalStreamedText: string; overallUsage: Record<string, number> } },
    _stream: unknown,
    pass: PassState,
  ) {
    const turn = script[callIndex - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = PRIVATE_REASONING;
    pass.thinkingSignature = "";
    if (turn.kind === "tool") {
      const calls = [{ id: `call-${callIndex}`, name: turn.toolName, args: turn.args ?? {} }];
      pass.streamedText = turn.narration ?? "";
      pass.finalStreamedText = turn.narration ?? "";
      pass.pendingToolCalls = calls;
      this.state.streamedToolCalls.push(...calls);
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      this.state.finalStreamedText = turn.text;
      finalText = turn.text;
    }
    pass.usage = { ...PASS_USAGE };
    mergeUsage(this.state.overallUsage as any, { ...PASS_USAGE } as any);
  }) as any);
  vi.spyOn(proto as any, "enforceContextWindow").mockImplementation((messages: unknown) => messages);
  vi.spyOn(proto as any, "finalize").mockResolvedValue(undefined);
  vi.spyOn(proto as any, "logIteration").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "emitGenerationProgress").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "emitUsageUpdate").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "checkAndApplyToolSetChanges").mockImplementation(() => undefined);
}

// ── The goal and its conversation ────────────────────────────────────

const CONVERSATION_ID = "goal-conversation-1";
const PROJECT = "prism-chat";
const USERNAME = "test-user";

const RUBRIC = [
  { id: "c1", criterion: "report.md exists in the workspace" },
  { id: "c2", criterion: "report.md has exactly 3 bullet points" },
  { id: "c3", criterion: "each bullet names a real file in the workspace" },
];

function seedGoal(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  mockCollection("agent_conversations").insertOne({
    id: CONVERSATION_ID,
    project: PROJECT,
    username: USERNAME,
    messages: [],
    goal: {
      objective: "Create report.md with exactly 3 bullet points summarizing the files in the workspace.",
      rubric: RUBRIC,
      verifier: { provider: "anthropic", model: "claude-sonnet-5" },
      maxIterations: 3,
      progress: { summary: "Not started", percent: 0, updatedAt: now },
      blockedOn: null,
      status: "active",
      spentDollars: 0,
      turnsUsed: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
  });
}

function storedGoal(): Record<string, any> {
  const document = [...mockCollection("agent_conversations")._docs.values()].find(
    (candidate: Record<string, unknown>) => candidate.id === CONVERSATION_ID,
  );
  return document?.goal;
}

function verdict(failing: Record<string, string> = {}, overall?: string): string {
  const criteria = RUBRIC.map(({ id }) => ({
    id,
    pass: !(id in failing),
    evidence: failing[id] ?? `${id} holds: the tool results show it`,
  }));
  return JSON.stringify({
    criteria,
    verdict: overall ?? (Object.keys(failing).length > 0 ? "needs_revision" : "satisfied"),
  });
}

interface Run {
  context: AgenticContext;
  events: Array<Record<string, unknown>>;
  done: Promise<{ messages: ConversationMessage[] }>;
}

function startTurn(turns: Turn[], { isSubAgent = false }: { isSubAgent?: boolean } = {}): Run {
  script = turns;
  const events: Array<Record<string, unknown>> = [];
  const context = {
    project: PROJECT,
    username: USERNAME,
    agent: "CODING",
    providerName: "google",
    resolvedModel: "gemini-3.6-flash",
    modelDefinition: { maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    traceId: "test-trace",
    agentConversationId: isSubAgent ? "sub-agent-conversation" : "minted-agent-id",
    conversationId: isSubAgent ? "sub-agent-conversation" : CONVERSATION_ID,
    ...(isSubAgent ? { parentAgentConversationId: CONVERSATION_ID } : {}),
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() },
    options: {
      harness: "standard",
      topology: "single",
      thoughtStructure: "chain",
      enableCriticGate: false,
      maxIterations: 20,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      ...(isSubAgent ? { isSubAgent: true } : {}),
    },
    messages: [{ role: "user", content: "Write the workspace report." }],
    emit: (event: Record<string, unknown>) => {
      events.push(event);
    },
    signal: undefined,
    requestId: "req-goal",
    requestStart: performance.now(),
    isNewConversation: false,
  } as unknown as AgenticContext;
  return { context, events, done: AgenticLoopService.runAgenticLoop(context) };
}

function verifierCalls() {
  return anthropicSdk.create;
}

/** Everything the verifier model was sent, as one string. */
function verifierPayloadText(index = 0): string {
  return JSON.stringify(verifierCalls()[index] ?? null);
}

function goalRevisionMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter(
    (message) => (message as { _turnInput?: { kind?: string } })._turnInput?.kind === "goal_revision",
  );
}

function goalUpdates(run: Run, change?: string) {
  return run.events.filter(
    (event) => event.type === "goal_update" && (change === undefined || event.change === change),
  );
}

const LISTING = {
  success: true,
  entries: ["alpha.ts", "beta.ts", "gamma.md"],
};
const FOUR_BULLETS = "- alpha.ts: entry point\n- beta.ts: helpers\n- gamma.md: notes\n- delta.txt: scratch";
const THREE_BULLETS = "- alpha.ts: entry point\n- beta.ts: helpers\n- gamma.md: notes";

// ── Scenarios ────────────────────────────────────────────────────────

describe("goals become verified outcomes", () => {
  beforeEach(async () => {
    mongo.collections.clear();
    TurnInputMailbox._clearAll();
    callIndex = 0;
    seen = [];
    finalText = "";
    beforeCall = null;
    anthropicSdk.create.length = 0;
    anthropicSdk.responses.length = 0;
    for (const key of Object.keys(toolResults)) delete toolResults[key];
    toolResults.list_directory = LISTING;
    toolResults.write_file = { success: true, path: "report.md", bytesWritten: 96 };
    toolResults.read_file = { success: true, path: "report.md", content: FOUR_BULLETS };
    providerRegistry.anthropic = (await import("#src/providers/anthropic")).default;
    installScriptedModel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an early done claim is checked: the agent gets the gap, revises, and the goal completes on the second verdict", async () => {
    seedGoal();
    anthropicSdk.responses.push(
      { text: verdict({ c2: "read_file shows report.md has 4 bullet points, not 3" }) },
      { text: verdict() },
    );
    const run = startTurn([
      { kind: "tool", toolName: "list_directory" },
      { kind: "tool", toolName: "write_file", args: { path: "report.md", content: FOUR_BULLETS } },
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done — report.md is written." },
      // After the verifier's gap arrives:
      { kind: "tool", toolName: "write_file", args: { path: "report.md", content: THREE_BULLETS } },
      { kind: "text", text: "Fixed: report.md now has exactly 3 bullets." },
    ]);
    beforeCall = (n) => {
      if (n === 5) toolResults.read_file = { success: true, path: "report.md", content: THREE_BULLETS };
    };
    await run.done;

    // The claim did not end the turn: the loop went on after it.
    expect(callIndex).toBe(6);
    expect(finalText).toBe("Fixed: report.md now has exactly 3 bullets.");

    // The agent received the failing criterion and its evidence gap.
    const revisions = goalRevisionMessages(seen[4]);
    expect(revisions).toHaveLength(1);
    expect(String(revisions[0].content)).toContain("c2");
    expect(String(revisions[0].content)).toContain("4 bullet points, not 3");
    expect(String(revisions[0].content)).not.toContain("c1 holds");

    // Two verdicts; the second one completed the goal.
    expect(verifierCalls()).toHaveLength(2);
    const goal = storedGoal();
    expect(goal.status).toBe("completed");
    expect(goal.verification.verdict).toBe("satisfied");
    expect(goal.verification.iteration).toBe(2);
    expect(goal.verification.criteria.map((entry: { id: string; pass: boolean }) => [entry.id, entry.pass])).toEqual([
      ["c1", true],
      ["c2", true],
      ["c3", true],
    ]);
    expect(goalUpdates(run, "verified")).toHaveLength(2);
  });

  it("the verifier is sent the rubric, user messages, tool calls, tool results and the final answer — never thinking or narration", async () => {
    seedGoal();
    anthropicSdk.responses.push({ text: verdict() });
    const run = startTurn([
      { kind: "tool", toolName: "list_directory", narration: NARRATION },
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "FINAL-ANSWER: report.md summarizes alpha.ts, beta.ts and gamma.md." },
    ]);
    toolResults.read_file = { success: true, path: "report.md", content: THREE_BULLETS };
    await run.done;

    expect(verifierCalls()).toHaveLength(1);
    const payload = verifierCalls()[0];
    const sent = verifierPayloadText();
    expect(payload.model).toBe("claude-sonnet-5");
    // Structured output: a JSON schema the reply must satisfy.
    expect((payload.output_config as { format?: { type?: string } } | undefined)?.format?.type).toBe("json_schema");
    // No tools: the verifier judges, it does not act.
    expect(payload.tools).toBeUndefined();
    // The rubric.
    for (const { id, criterion } of RUBRIC) {
      expect(sent).toContain(id);
      expect(sent).toContain(criterion);
    }
    // The evidence: the user's request, the calls, their results, the answer.
    expect(sent).toContain("Write the workspace report.");
    expect(sent).toContain("list_directory");
    expect(sent).toContain("gamma.md");
    expect(sent).toContain("read_file");
    expect(sent).toContain("- beta.ts: helpers");
    expect(sent).toContain("FINAL-ANSWER: report.md summarizes alpha.ts, beta.ts and gamma.md.");
    // Never the agent's reasoning, nor what it said about its own work —
    // and no thinking content at all (the verifier's own thinking is off).
    expect(sent).not.toContain("PRIVATE-REASONING");
    expect(sent).not.toContain("NARRATION");
    const content = JSON.stringify({ system: payload.system, messages: payload.messages });
    expect(content).not.toMatch(/"type":"(redacted_)?thinking"/);
    expect(content).not.toContain("thinkingSignature");
    expect((payload.thinking as { type?: string } | undefined)?.type ?? "disabled").toBe("disabled");
    expect(storedGoal().status).toBe("completed");
  });

  it("the verifier's cost counts against the goal: at the dollar cap the goal pauses with reason budget", async () => {
    // Main loop so far: 2 passes = $0.01575 — under the cap. With the
    // verifier's $0.05 the goal is at $0.06575, over a $0.05 cap.
    seedGoal({ budget: { maxCostDollars: 0.05 } });
    anthropicSdk.responses.push({ text: verdict({ c2: "4 bullets, not 3" }) });
    const run = startTurn([
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done." },
      { kind: "text", text: "never reached" },
    ]);
    await run.done;

    expect(verifierCalls()).toHaveLength(1);
    expect(callIndex).toBe(2);
    let goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("budget");
    expect(goalRevisionMessages(seen.at(-1) ?? [])).toHaveLength(0);

    // The turn's accounting (afterResponse) books main loop + verifier.
    await ConversationGoalService.createHook()(run.context as any);
    goal = storedGoal();
    expect(goal.spentDollars).toBeCloseTo(0.01575 + 0.05, 6);
    expect(goal.turnsUsed).toBe(1);
  });

  it("three consecutive empty continuations trip the breaker (reason empty_continuations)", async () => {
    seedGoal();
    anthropicSdk.responses.push({ text: verdict({ c1: "no write_file call and no listing: report.md was never created" }) });
    const run = startTurn([
      { kind: "text", text: "Done." },
      { kind: "text", text: "It is done, trust me." },
      { kind: "text", text: "Really, it is done." },
      { kind: "text", text: "Done done done." },
      { kind: "text", text: "never reached" },
    ]);
    await run.done;

    // One verdict: an empty continuation has no new evidence to judge.
    expect(verifierCalls()).toHaveLength(1);
    expect(callIndex).toBe(4);
    const goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("empty_continuations");
  });

  it("a malformed verdict is retried once, then the goal pauses with reason failed", async () => {
    seedGoal();
    anthropicSdk.responses.push(
      { text: "I think it looks fine!" },
      { text: JSON.stringify({ verdict: "satisfied" }) },
    );
    const run = startTurn([
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done." },
      { kind: "text", text: "never reached" },
    ]);
    await run.done;

    expect(verifierCalls()).toHaveLength(2);
    expect(callIndex).toBe(2);
    const goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("failed");
  });

  it("a failed verdict (the rubric contradicts the task) stops and asks the user", async () => {
    seedGoal();
    anthropicSdk.responses.push({
      text: JSON.stringify({
        criteria: RUBRIC.map(({ id }) => ({ id, pass: id !== "c3", evidence: id === "c3" ? "the workspace has only 2 files" : "ok" })),
        verdict: "failed",
        reason: "3 bullets that each name a real file cannot exist: the workspace has 2 files",
      }),
    });
    const run = startTurn([
      { kind: "tool", toolName: "list_directory" },
      { kind: "text", text: "Done." },
      { kind: "text", text: "never reached" },
    ]);
    await run.done;

    expect(callIndex).toBe(2);
    const goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("failed");
    expect(goal.pause.detail).toContain("workspace has 2 files");
  });

  it("maxIterations bounds the revisions (reason max_iterations)", async () => {
    seedGoal({ maxIterations: 2 });
    anthropicSdk.responses.push(
      { text: verdict({ c2: "4 bullets" }) },
      { text: verdict({ c2: "still 4 bullets" }) },
    );
    const run = startTurn([
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done." },
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done now." },
      { kind: "text", text: "never reached" },
    ]);
    await run.done;

    expect(verifierCalls()).toHaveLength(2);
    expect(callIndex).toBe(4);
    const goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("max_iterations");
    expect(goal.verification.verdict).toBe("needs_revision");
  });

  it("a user message during a goal continuation pauses the goal (reason user_message) — the user takes the wheel", async () => {
    seedGoal();
    anthropicSdk.responses.push({ text: verdict({ c2: "4 bullets" }) });
    const run = startTurn([
      { kind: "tool", toolName: "read_file", args: { path: "report.md" } },
      { kind: "text", text: "Done." },
      // The user speaks while this pass streams: the harness hands the
      // message to the model before anything else happens.
      { kind: "text", text: "Working on the bullet count now." },
      { kind: "text", text: "Sure — stopping here as you asked." },
      { kind: "text", text: "never reached" },
    ]);
    beforeCall = (n) => {
      if (n === 3) {
        TurnInputMailbox.post(CONVERSATION_ID, { kind: "user_update", text: "Stop, I'll finish it myself." });
      }
    };
    await run.done;

    // The user's message is answered (call 4); then the goal stops driving.
    expect(callIndex).toBe(4);
    expect(finalText).toBe("Sure — stopping here as you asked.");
    expect(verifierCalls()).toHaveLength(1);
    const goal = storedGoal();
    expect(goal.status).toBe("paused");
    expect(goal.pause.reason).toBe("user_message");
  });

  it("a goal that is not active is never verified", async () => {
    seedGoal({ status: "paused", pause: { reason: "user", at: new Date().toISOString() } });
    const run = startTurn([{ kind: "text", text: "Here is an unrelated answer." }]);
    await run.done;
    expect(verifierCalls()).toHaveLength(0);
    expect(callIndex).toBe(1);
    expect(storedGoal().status).toBe("paused");
  });

  it("a sub-agent never runs the verifier — its parent's turn does", async () => {
    seedGoal();
    const run = startTurn([{ kind: "text", text: "Sub-agent result." }], { isSubAgent: true });
    await run.done;
    expect(verifierCalls()).toHaveLength(0);
    expect(storedGoal().status).toBe("active");
  });
});
