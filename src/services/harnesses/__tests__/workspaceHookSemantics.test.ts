/**
 * workspaceHookSemantics.test.ts
 *
 * A repository's own hooks (`.prism/hooks.json`), end to end: a REAL
 * ReActHarness with the REAL TurnHooks, WorkspaceHooks discovery and trust,
 * ConfiguredHookRegistry, HookRunner and CommandHookHandler. Only
 * tools-service is a stand-in (`toolsService` below): it answers
 * `GET /agentic/hooks/config`, runs `POST /agentic/hook-command/run` by a
 * script per command, and records `POST /agentic/transcripts/:id/append` —
 * every request in one ordered log.
 *
 * Claude Code's semantics, as a repository's guard sees them:
 *   - PreToolUse `permissionDecision: "deny"` and exit 2 block the call;
 *   - PostToolUse `additionalContext` reaches the model;
 *   - Stop `decision: "block"` keeps the turn going;
 *   - the command runs `{workspace: true, cwd: <the file's directory>}`;
 *   - the payload is Claude Code's input (cwd, permission_mode,
 *     transcript_path, tool_response, harness) and the transcript has the
 *     final answer BEFORE the Stop hook runs;
 *   - an untrusted file runs nothing and says so once.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
  MONGO_DB_NAME: "prism-test",
}));

import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { _resetSessionsForTests } from "#src/services/hooks/HookSessionTracker";
import { invalidateWorkspaceHooksConfig } from "#src/services/hooks/WorkspaceHookConfig";
import { _resetTranscriptsForTests } from "#src/services/hooks/ClaudeTranscript";
import { _clearTurnHookFacts } from "#src/services/hooks/TurnHookFacts";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import { HOOKS } from "#src/constants";
import type { AgenticContext, ResolvedTools, ConversationMessage, PassState } from "../types.ts";
import { runAs } from "../../../../tests/helpers/auth.ts";

/** The turn runs as a user who signed in (AuthMiddleware) — what repository hooks need. */
function asOwner<T>(fn: () => T): T {
  return runAs("user", "rodrigo", fn);
}

const HOOKS_FILE = "/repo/.prism/hooks.json";
const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

const world = vi.hoisted(() => ({
  /** The trust collection's documents. */
  trust: [] as Array<Record<string, unknown>>,
  executed: [] as Array<{ name: string; args: Record<string, unknown> }>,
  approve: true,
}));

// ── Mongo: only the trust collection and the approvals matter ──

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection } = await import("../../../../tests/mongoMock.ts");
  const pendingDecisions = createMockCollection();
  return {
    default: {
      getDb: () => ({
        collection: (name: string) => {
          if (name === "pending_decisions") return pendingDecisions;
          if (name === "workspace_hook_trust") {
            return createMockCollection(world.trust.map((document) => ({ ...document, id: String(document.path) })));
          }
          return {
            findOne: async () => null,
            updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
          };
        },
      }),
    },
  };
});

// No stored hooks: every configured hook in these tests is the repository's.
vi.mock("../lifecycle/HookInitializer.ts", async () => {
  const { default: AgentHooks } = await import("#src/services/AgentHooks");
  const { default: AutoApprovalEngine } = await import("#src/services/AutoApprovalEngine");
  return {
    createStandardHooks: (options: { autoApprove?: boolean } = {}) => {
      const hooks = new AgentHooks();
      const approvalEngine = new AutoApprovalEngine({ fullAuto: options.autoApprove === true, policies: [] });
      hooks.register("beforeToolCall", approvalEngine.createHook() as never, "AutoApprovalEngine", "decide");
      hooks.register(
        "beforePrompt",
        async (hookContext: unknown) => {
          const target = hookContext as Record<string, unknown>;
          target._assembledSystemPrompt = "You are a test agent.";
          target._injectedSkills = [];
        },
        "SystemPromptAssembler",
        "transform",
      );
      return { hooks, approvalEngine };
    },
    attachConfiguredHooks: async () => 0,
  };
});

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    isStreamable: () => false,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      world.executed.push({ name, args: { ...args } });
      return { success: true, stdout: `${name} ok`, exitCode: 0 };
    }),
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getWorktreeState: () => null,
    // The request names no root: the turn works in tools-service's default.
    getWorkspaceRoot: () => "/repo",
    getWorkspaceRoots: () => ["/repo"],
  },
}));

vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()) },
}));

// ── Loop dependencies unrelated to hooks (as hookSemantics.test.ts) ──

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));
// The command handler reads stdout with the prompt handler's JSON extractor: keep it real.
vi.mock("#src/services/hooks/handlers/PromptHookHandler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: vi.fn(),
}));
vi.mock("#src/services/hooks/handlers/McpToolHookHandler", () => ({ default: vi.fn() }));
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
  injectErrorAsConversationMessage: vi.fn().mockImplementation(
    (messages: ConversationMessage[], errorText: string) => {
      messages.push({ role: "system", content: errorText });
    },
  ),
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
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
  enforceCostBudget: vi.fn().mockResolvedValue(false),
  recordLoopSpend: vi.fn(),
}));
vi.mock("../lifecycle/PlanModeController.ts", () => ({
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({
  buildToolRetryGuidance: vi.fn().mockReturnValue(null),
}));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── tools-service, in process ────────────────────────────────

interface CommandRun {
  command: string;
  body: Record<string, unknown>;
  payload: Record<string, unknown>;
}
type Outcome = { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean };

const REPO_HOOKS = {
  description: "The repository's guards.",
  hooks: {
    PreToolUse: [
      { matcher: "^(execute_command)$", hooks: [{ type: "command", command: "guard", timeout: 15, statusMessage: "Guards" }] },
    ],
    PostToolUse: [{ matcher: "execute_command", hooks: [{ type: "command", command: "post-context" }] }],
    Stop: [{ hooks: [{ type: "command", command: "stop-check", timeout: 45 }] }],
  },
};

/** The content the trust records in these tests were given for. */
const SHA = sha256Of(JSON.stringify(REPO_HOOKS));

const toolsService = {
  log: [] as string[],
  runs: [] as CommandRun[],
  appends: [] as Array<{ conversationId: string; lines: Array<Record<string, unknown>>; root: string }>,
  hooksFile: JSON.stringify(REPO_HOOKS) as string,
  behave: (_run: CommandRun): Outcome => ({ exitCode: 0 }),
};

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (url.origin !== "http://tools.test") return json({ error: "not tools-service" }, 404);
  if (url.pathname === "/agentic/hooks/config") {
    toolsService.log.push(`config:${url.searchParams.get("root")}`);
    return json({
      project: {
        path: HOOKS_FILE,
        dir: "/repo",
        exists: true,
        content: toolsService.hooksFile,
        sha256: sha256Of(toolsService.hooksFile),
      },
      user: null,
    });
  }
  if (url.pathname === "/agentic/hook-command/run") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const run: CommandRun = { command: String(body.command), body, payload: JSON.parse(String(body.stdin)) };
    toolsService.runs.push(run);
    toolsService.log.push(`run:${run.command}:${String(run.payload.hook_event_name)}`);
    const outcome = toolsService.behave(run);
    return json({ stdout: "", stderr: "", timedOut: false, ...outcome });
  }
  const transcript = /^\/agentic\/transcripts\/([^/]+)\/append$/.exec(url.pathname);
  if (transcript) {
    const conversationId = decodeURIComponent(transcript[1]);
    const body = JSON.parse(String(init.body)) as { lines: Array<Record<string, unknown>>; root: string };
    toolsService.appends.push({ conversationId, ...body });
    const kinds = body.lines.map((line) => line.type).join(",");
    toolsService.log.push(`transcript:${kinds}`);
    return json({ path: `/tmp/prism-1000/transcripts/${conversationId}.jsonl` });
  }
  return json({ error: "no such route" }, 404);
}

// ── A real loop with a scripted model (as hookSemantics.test.ts) ──

type Turn =
  | { kind: "tool"; text?: string; calls: Array<{ name: string; args?: Record<string, unknown> }> }
  | { kind: "text"; text: string };

function buildHarness(script: Turn[], conversationId: string) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];

  const emit = vi.fn((event: Record<string, unknown>) => {
    if (event.type === "approval_required") {
      setTimeout(() => {
        void ApprovalRegistry.decide(conversationId, {
          toolCallId: event.toolCallId as string,
          decision: world.approve ? "allow" : "deny",
        });
      }, 0);
    }
  });

  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
  };

  const context: AgenticContext = {
    project: "prism-chat",
    username: "rodrigo",
    agent: "CODING",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as never,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: mockProvider as never,
    workspaceRoot: null,
    options: {
      maxIterations: 8,
      autoApprove: false,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      _permissionMode: new PermissionModeHandle("acceptEdits"),
    },
    messages: [{ role: "user", content: "Run the web tests" }],
    emit,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as never;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "execute_command", description: "Run a command", parameters: {} },
      { name: "read_file", description: "Read a file", parameters: {} },
    ] as never,
    resolvedEnabledTools: ["execute_command", "read_file"],
  };
  const harness = new ReActHarness(context, state, tools);
  const stubbed = harness as never as Record<string, unknown>;

  stubbed.createProviderStream = vi.fn().mockImplementation(async (messages: ConversationMessage[]) => {
    iteration++;
    toolsService.log.push(`model:${iteration}`);
    seenMessages.push(messages.map((message) => ({ ...message })));
    return mockProvider.generateTextStream();
  });
  stubbed.consumeStream = vi.fn().mockImplementation(async (_stream: unknown, pass: PassState) => {
    const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tool") {
      pass.streamedText = turn.text ?? "";
      pass.finalStreamedText = turn.text ?? "";
      pass.pendingToolCalls = turn.calls.map((call, index) => ({
        id: `call-${iteration}-${index + 1}`,
        name: call.name,
        args: { ...(call.args ?? {}) },
      }));
      for (const toolCall of pass.pendingToolCalls) state.streamedToolCalls.push({ ...toolCall });
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      state.finalStreamedText = turn.text;
    }
    pass.usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    } as never;
  });
  stubbed.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  stubbed.finalize = vi.fn().mockResolvedValue(undefined);
  stubbed.checkpointTurnProgress = vi.fn().mockResolvedValue(undefined);
  stubbed.logIteration = vi.fn();
  stubbed.emitGenerationProgress = vi.fn();
  stubbed.emitUsageUpdate = vi.fn();
  stubbed.checkAndApplyToolSetChanges = vi.fn();

  return { harness, emit, seenMessages, iterations: () => iteration };
}

const runsFor = (event: string) => toolsService.runs.filter((run) => run.payload.hook_event_name === event);

function toolMessageOf(messages: ConversationMessage[]) {
  return messages.find((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
}

// ── Tests ────────────────────────────────────────────────────

describe("repository hooks — Claude Code's semantics through a real ReActHarness", () => {
  let previousOwners: string | undefined;

  beforeEach(() => {
    previousOwners = process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = "rodrigo";
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    _resetSessionsForTests();
    _resetTranscriptsForTests();
    _clearTurnHookFacts();
    invalidateWorkspaceHooksConfig();
    world.trust = [{ username: "rodrigo", path: HOOKS_FILE, sha256: SHA, trustedAt: "2026-10-06T00:00:00.000Z" }];
    world.executed = [];
    world.approve = true;
    toolsService.log = [];
    toolsService.runs = [];
    toolsService.appends = [];
    toolsService.hooksFile = JSON.stringify(REPO_HOOKS);
    toolsService.behave = () => ({ exitCode: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousOwners === undefined) delete process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    else process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = previousOwners;
  });

  it("PreToolUse `permissionDecision: deny` blocks the call before it runs (or reaches a card)", async () => {
    toolsService.behave = (run) =>
      run.command === "guard" && String((run.payload.tool_input as { command?: string }).command).includes("rm -rf")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "rm -rf is refused in this repository",
              },
            }),
          }
        : { exitCode: 0 };
    const { harness, emit, seenMessages } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "rm -rf build" } }] },
        { kind: "text", text: "It was refused." },
      ],
      "conv-deny",
    );
    await asOwner(() => harness.run());

    expect(world.executed).toHaveLength(0);
    expect(emit.mock.calls.some(([event]) => (event as { type: string }).type === "approval_required")).toBe(false);
    const result = toolMessageOf(seenMessages[1])!.toolCalls![0].result as { success: boolean; error: string; message: string };
    expect(result).toMatchObject({ success: false, error: "BLOCKED_BY_SAFETY_HOOK" });
    expect(result.message).toContain("rm -rf is refused in this repository");
  });

  it("exit 2 blocks, with stderr as the reason", async () => {
    toolsService.behave = (run) =>
      run.command === "guard" ? { exitCode: 2, stdout: "ignored", stderr: "Use the broker: scripts/ops/cargo-run.sh" } : { exitCode: 0 };
    const { harness, seenMessages } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "cargo build" } }] },
        { kind: "text", text: "Understood." },
      ],
      "conv-exit2",
    );
    await asOwner(() => harness.run());

    expect(world.executed).toHaveLength(0);
    const result = toolMessageOf(seenMessages[1])!.toolCalls![0].result as { message: string };
    expect(result.message).toContain("Use the broker: scripts/ops/cargo-run.sh");
  });

  it("runs the command in the repository — {workspace: true, cwd: <the file's directory>} — with Claude Code's payload", async () => {
    const { harness } = buildHarness(
      [
        { kind: "tool", text: "Running the web tests.", calls: [{ name: "execute_command", args: { command: "npm test", cwd: "web" } }] },
        { kind: "text", text: "All green." },
      ],
      "conv-payload",
    );
    await asOwner(() => harness.run());

    expect(world.executed.map((call) => call.name)).toEqual(["execute_command"]);
    const [pre] = runsFor("PreToolUse");
    expect(pre.body).toMatchObject({ command: "guard", workspace: true, cwd: "/repo", owner: "rodrigo" });
    expect(pre.body.timeoutMilliseconds).toBeLessThanOrEqual(15_000);
    expect(pre.payload).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "conv-payload",
      transcript_path: "/tmp/prism-1000/transcripts/conv-payload.jsonl",
      // execute_command's own cwd, resolved against the workspace root.
      cwd: "/repo/web",
      permission_mode: "acceptEdits",
      harness: "prism",
      workspace_root: "/repo",
      tool_name: "execute_command",
      tool_input: { command: "npm test", cwd: "web" },
      tool_use_id: "call-1-1",
      agent_conversation_id: "conv-payload",
      project: "prism-chat",
      username: "rodrigo",
      agent: "CODING",
    });
    expect(pre.payload.agent_id).toBeUndefined();

    const [post] = runsFor("PostToolUse");
    expect(post.payload.tool_response).toEqual({ success: true, stdout: "execute_command ok", exitCode: 0 });
    expect(post.payload.tool_output).toEqual(post.payload.tool_response);

    const [stop] = runsFor("Stop");
    expect(stop.payload).toMatchObject({
      last_assistant_message: "All green.",
      stop_hook_active: false,
      cwd: "/repo",
      transcript_path: "/tmp/prism-1000/transcripts/conv-payload.jsonl",
    });
  });

  it("PostToolUse `additionalContext` reaches the model with the batch", async () => {
    toolsService.behave = (run) =>
      run.command === "post-context"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Lease recorded for web/." },
            }),
          }
        : { exitCode: 0 };
    const { harness, seenMessages } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "npm test" } }] },
        { kind: "text", text: "Done." },
      ],
      "conv-context",
    );
    await asOwner(() => harness.run());

    const secondRequest = seenMessages[1];
    const toolIndex = secondRequest.findIndex((message) => (message.toolCalls?.length ?? 0) > 0);
    const contextIndex = secondRequest.findIndex(
      (message) => typeof message.content === "string" && message.content.includes("Lease recorded for web/."),
    );
    expect(contextIndex).toBeGreaterThan(toolIndex);
    expect(secondRequest[contextIndex].role).toBe("system");
  });

  it("Stop `decision: block` keeps the turn going with the hook's reason", async () => {
    let stops = 0;
    toolsService.behave = (run) => {
      if (run.command !== "stop-check") return { exitCode: 0 };
      stops += 1;
      return stops === 1
        ? { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: "End with the verdict glyph." }) }
        : { exitCode: 0 };
    };
    const { harness, seenMessages, iterations } = buildHarness(
      [
        { kind: "text", text: "All done." },
        { kind: "text", text: "All done. ✅" },
      ],
      "conv-stop",
    );
    await asOwner(() => harness.run());

    expect(iterations()).toBe(2);
    const stopRuns = runsFor("Stop");
    expect(stopRuns.map((run) => run.payload.stop_hook_active)).toEqual([false, true]);
    expect(
      seenMessages[1].some(
        (message) => typeof message.content === "string" && message.content.includes("End with the verdict glyph."),
      ),
    ).toBe(true);
  });

  it("writes the Claude-shaped transcript in order, the final answer BEFORE the Stop hook runs", async () => {
    const { harness } = buildHarness(
      [
        { kind: "tool", text: "Running the tests.", calls: [{ name: "execute_command", args: { command: "npm test" } }] },
        { kind: "text", text: "All green. ✅" },
      ],
      "conv-transcript",
    );
    await asOwner(() => harness.run());

    const lines = toolsService.appends.flatMap((append) => append.lines);
    expect(toolsService.appends.every((append) => append.root === "/repo" && append.conversationId === "conv-transcript")).toBe(true);
    expect(lines.map((line) => line.type)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(lines[0]).toMatchObject({ sessionId: "conv-transcript", cwd: "/repo", message: { role: "user", content: "Run the web tests" } });
    expect((lines[1].message as { content: unknown[] }).content).toEqual([
      { type: "text", text: "Running the tests." },
      { type: "tool_use", id: "call-1-1", name: "execute_command", input: { command: "npm test" } },
    ]);
    expect((lines[2].message as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-1-1",
    });
    expect((lines[3].message as { content: unknown[] }).content).toEqual([{ type: "text", text: "All green. ✅" }]);

    // The answer was on file before the Stop hook was asked about it.
    const finalAppend = toolsService.log.lastIndexOf("transcript:assistant");
    const stopRun = toolsService.log.indexOf("run:stop-check:Stop");
    expect(finalAppend).toBeGreaterThan(-1);
    expect(stopRun).toBeGreaterThan(finalAppend);
    // And the batch was on file before the next model call.
    expect(toolsService.log.indexOf("transcript:assistant,user")).toBeLessThan(toolsService.log.indexOf("model:2"));
  });

  it("an untrusted file runs nothing, and the turn says so once", async () => {
    world.trust = [];
    const { harness, emit } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "npm test" } }] },
        { kind: "text", text: "Done." },
      ],
      "conv-untrusted",
    );
    await asOwner(() => harness.run());

    expect(toolsService.runs).toHaveLength(0);
    expect(world.executed.map((call) => call.name)).toEqual(["execute_command"]);
    const notices = emit.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => typeof event.message === "string" && event.message.includes("not trusted yet"));
    expect(notices).toEqual([
      {
        type: "status",
        message: `Workspace hooks in ${HOOKS_FILE} are not trusted yet — trust them in Settings → Hooks.`,
      },
    ]);
    // No command hook runs, so no transcript is kept either.
    expect(toolsService.appends).toHaveLength(0);
  });

  it("a file edited since it was trusted is untrusted again", async () => {
    // A branch adds a hook: the content — and its sha256 — moved past the trust.
    toolsService.hooksFile = JSON.stringify({
      ...REPO_HOOKS,
      hooks: { ...REPO_HOOKS.hooks, UserPromptSubmit: [{ hooks: [{ type: "command", command: "exfiltrate" }] }] },
    });
    const { harness, emit } = buildHarness([{ kind: "text", text: "Done." }], "conv-edited");
    await asOwner(() => harness.run());
    expect(toolsService.runs).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", message: expect.stringContaining("not trusted yet") }),
    );
  });

  it("a user outside PRISM_HOOK_COMMAND_OWNERS runs no repository hooks and costs no discovery", async () => {
    process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = "someone-else";
    const { harness } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "rm -rf build" } }] },
        { kind: "text", text: "Done." },
      ],
      "conv-not-owner",
    );
    await asOwner(() => harness.run());
    expect(toolsService.log.filter((entry) => !entry.startsWith("model:"))).toEqual([]);
    expect(world.executed).toHaveLength(1);
  });

  it("a service's turn under the owner's name runs no repository hooks and costs no discovery", async () => {
    const { harness } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "execute_command", args: { command: "rm -rf build" } }] },
        { kind: "text", text: "Done." },
      ],
      "conv-service",
    );
    await runAs("service", "rodrigo", () => harness.run());
    expect(toolsService.log.filter((entry) => !entry.startsWith("model:"))).toEqual([]);
    expect(world.executed).toHaveLength(1);
  });
});
