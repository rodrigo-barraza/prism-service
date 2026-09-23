/**
 * Permission modes inside a REAL agentic loop.
 *
 * AgenticLoopService → ReActHarness → createStandardHooks → ApprovalGate →
 * AutoApprovalEngine → ApprovalRegistry/PendingDecisionStore are real; the
 * provider is scripted, the tool executor and the heavy side services are
 * mocked (as permissionRulesInTheLoop). A card that goes out is answered the
 * way the client would, through AgenticLoopService.decideApproval.
 *
 *   plan         a write is denied with the plan message; a read runs
 *   acceptEdits  a write inside the workspace runs; outside, it asks
 *   dontAsk      an ask becomes a denial — and an unattended (scheduled /
 *                timer) run with no mode is in dontAsk
 *   bypass       requires the owner flag
 *   protected    a protected path always asks
 *   switching    a mid-turn switch applies to the next call and emits an
 *                event; an approved plan leaves plan mode
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { COLLECTIONS, MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";
import { clearPermissionRuleCache } from "#src/services/permissions/PermissionRuleStore";
import { PermissionModeRegistry } from "#src/services/permissions/PermissionModeState";
import { BYPASS_OWNERS_ENV_VAR } from "#src/services/permissions/PermissionModes";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: "read_file", description: "Read a file" },
      { name: "write_file", description: "Write a file" },
      { name: "execute_shell", description: "Run a shell command" },
      { name: "exit_plan_mode", description: "Present the plan" },
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "read_file", domain: "system", labels: ["safe"] },
      { name: "write_file", domain: "system", labels: [] },
      { name: "execute_shell", domain: "system", labels: [] },
      { name: "exit_plan_mode", domain: "system", labels: [] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: "mocked" }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getToolLabel: vi.fn().mockReturnValue("Using Tool"),
  },
}));

// One in-memory Mongo, memoized per collection: the conversation's stored
// mode, the pending-decision records the cards are decided through.
const mongo = vi.hoisted(() => ({ collections: new Map<string, any>() }));
vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!mongo.collections.has(name)) mongo.collections.set(name, createMockCollection());
    return mongo.collections.get(name);
  };
  return {
    default: {
      getDb: () => ({ collection }),
      getCollection: (_database: string, name: string) => collection(name),
    },
  };
});

vi.mock("#src/services/FileService", () => ({ default: { uploadFile: vi.fn().mockResolvedValue({ ref: "ref" }) } }));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("pending"),
    completePending: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/tool-definitions/InternalToolRegistry", () => ({
  default: { getNames: vi.fn().mockReturnValue(new Set()) },
}));
vi.mock("#src/services/ContextWindowManager", () => ({
  default: {
    enforce: vi.fn().mockImplementation((messages) => ({ truncated: false, messages, strategy: "none", estimatedTokens: 10 })),
    estimateTokens: vi.fn().mockReturnValue(10),
  },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => {
  const stats = { activeRequests: 0, totalOutputTokens: 1, totalInputTokens: 1, totalTokens: 2, tokPerSec: 1, avgTtft: 0, estimatedCost: 0 };
  return {
    default: {
      register: vi.fn(), update: vi.fn(), setEstimatedInputTokens: vi.fn(), recordChunkTiming: vi.fn(),
      complete: vi.fn(), cleanup: vi.fn(),
      getSessionStats: vi.fn().mockReturnValue(stats), getConversationStats: vi.fn().mockReturnValue(stats),
    },
  };
});
vi.mock("#src/services/system-prompt/index", () => ({
  default: class {
    createHook() {
      return async () => {};
    }
  },
}));
vi.mock("#src/services/SettingsService", async () => {
  const { HARNESS_IDENTIFIERS } = await import("#src/constants");
  return {
    default: {
      getCached: vi.fn(),
      get: vi.fn().mockResolvedValue({ agents: { harness: HARNESS_IDENTIFIERS.STANDARD } }),
      getSection: vi.fn().mockResolvedValue({ harness: HARNESS_IDENTIFIERS.STANDARD }),
    },
  };
});
vi.mock("#src/routes/ChatRoutes", () => ({ finalizeTextGeneration: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#src/services/MemoryExtractor", () => ({ default: { createHook: vi.fn().mockReturnValue(async () => {}) } }));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn(), stripPlanningInstruction: vi.fn(), extractSteps: vi.fn().mockReturnValue([]) },
}));

const USERNAME = "rodrigo";
const PROJECT = "modes-project";
const CONVERSATION = "conv-modes";

type ScriptedCall = { name: string; args: Record<string, unknown>; id: string };

function conversations() {
  return mongo.collections.get(COLLECTIONS.AGENT_CONVERSATIONS) ?? null;
}

async function storeConversation(approvals: Record<string, unknown> = {}) {
  const { default: MongoWrapper } = await import("#src/wrappers/MongoWrapper");
  await (MongoWrapper.getDb("x") as any)
    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
    .insertOne({ id: CONVERSATION, project: PROJECT, username: USERNAME, approvals });
}

function storedMode(): unknown {
  const document = [...(conversations()?._docs.values() ?? [])].find((entry: any) => entry.id === CONVERSATION);
  return document?.approvals?.permissionMode;
}

describe("permission modes in a real loop", () => {
  let provider: any;
  let emitted: any[];
  /** How a card is answered (the tests that see a card deny it). */
  let cardAnswer: "allow" | "deny";
  let onFirstModelCall: (() => void) | null;
  const previousOwners = process.env[BYPASS_OWNERS_ENV_VAR];

  /** One step of tool calls, then a closing text step. */
  function script(...calls: ScriptedCall[]) {
    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        onFirstModelCall?.();
        for (const call of calls) yield { type: "toolCall", ...call };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Done.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });
  }

  const run = (options: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    AgenticLoopService.runAgenticLoop({
      provider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 10_000, inputTypes: [MODALITY_TYPES.TEXT], outputTypes: [MODALITY_TYPES.TEXT] },
      messages: [{ role: MESSAGE_ROLES.USER, content: "Work on the repo." }],
      options: { maxIterations: 3, disabledTools: ["search_web", "generate_image", "describe_image"], ...options },
      agentConversationId: CONVERSATION,
      conversationId: CONVERSATION,
      parentAgentConversationId: null,
      traceId: "trace",
      project: PROJECT,
      username: USERNAME,
      profileId: "default",
      workspaceRoot: "/ws",
      requestId: "req",
      requestStart: performance.now(),
      emit: vi.fn((event) => {
        emitted.push(event);
        // Answer each card the way the client does, once it is out.
        if (event.type === "approval_required") {
          setTimeout(() => {
            void AgenticLoopService.decideApproval(CONVERSATION, {
              toolCallId: event.toolCallId,
              batchId: event.batchId,
              decision: cardAnswer,
            });
          }, 0);
        }
        if (event.type === "plan_proposal") {
          setTimeout(() => {
            void AgenticLoopService.decideApproval(CONVERSATION, {
              toolCallId: event.toolCallId,
              batchId: event.batchId,
              decision: "allow",
            });
          }, 0);
        }
      }),
      signal: new AbortController().signal,
      ...extra,
    } as any);

  const executed = () => vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => [call[0], call[1]]);
  /** What ran — minus the approval card's diff preview, which reads the target file. */
  const executedWrites = () => executed().filter(([name]) => name !== "read_file");
  const cards = () => emitted.filter((event) => event.type === "approval_required");
  const modeEvents = () => emitted.filter((event) => event.type === "permission_mode");
  /** The tool results the model saw on its second request, as one string. */
  const resultsSeen = () =>
    JSON.stringify(
      provider.generateTextStream.mock.calls[1][0].filter((message: any) => message.role === MESSAGE_ROLES.TOOL),
    );
  /** The result content the model saw for one tool call. */
  const resultFor = (toolCallId: string): string =>
    provider.generateTextStream.mock.calls[1][0].find(
      (message: any) => message.role === MESSAGE_ROLES.TOOL && message.tool_call_id === toolCallId,
    )?.content ?? "";

  beforeEach(() => {
    mongo.collections.clear();
    emitted = [];
    cardAnswer = "deny";
    onFirstModelCall = null;
    clearPermissionRuleCache();
    PermissionModeRegistry.clear();
    vi.mocked(ToolOrchestratorService.executeTool).mockClear();
    (SettingsService.getCached as any).mockReturnValue({ creative: {} });
    provider = { generateTextStream: vi.fn() };
  });

  afterEach(() => {
    if (previousOwners === undefined) delete process.env[BYPASS_OWNERS_ENV_VAR];
    else process.env[BYPASS_OWNERS_ENV_VAR] = previousOwners;
  });

  it("plan: a write is denied with the plan message; a read runs (mode stored on the conversation)", async () => {
    await storeConversation({ permissionMode: "plan" });
    script(
      { name: "read_file", args: { path: "src/a.ts" }, id: "call-read" },
      { name: "write_file", args: { path: "src/a.ts", content: "x" }, id: "call-write" },
      { name: "execute_shell", args: { command: "npm test" }, id: "call-shell" },
    );

    await run({});

    expect(executed()).toEqual([["read_file", { path: "src/a.ts" }]]);
    expect(cards()).toEqual([]);
    for (const [id, name] of [["call-write", "write_file"], ["call-shell", "execute_shell"]]) {
      const result = JSON.parse(resultFor(id));
      expect(result).toMatchObject({ success: false, error: "PERMISSION_MODE_DENIED", mode: "plan" });
      expect(result.message).toContain(`[Plan mode] "${name}" was not run`);
      expect(result.message).toMatch(/read-only/);
    }
    expect(modeEvents()[0]).toMatchObject({ mode: "plan", source: "conversation", conversationId: CONVERSATION });
  });

  it("acceptEdits: a write inside the workspace runs; outside, it asks", async () => {
    script(
      { name: "write_file", args: { path: "src/a.ts", content: "x" }, id: "call-inside" },
      { name: "write_file", args: { path: "/ws/src/b.ts", content: "x" }, id: "call-inside-absolute" },
      { name: "write_file", args: { path: "/etc/hosts", content: "x" }, id: "call-outside" },
    );

    await run({ permissionMode: "acceptEdits" });

    expect(cards().map((card) => card.toolCall.args.path)).toEqual(["/etc/hosts"]);
    expect(executedWrites().map(([, args]: any) => args.path)).toEqual(["src/a.ts", "/ws/src/b.ts"]);
    expect(resultsSeen()).toContain("USER_REJECTED");
  });

  it("dontAsk: an ask becomes a denial, and no card goes out", async () => {
    script(
      { name: "read_file", args: { path: "src/a.ts" }, id: "call-read" },
      { name: "write_file", args: { path: "src/a.ts", content: "x" }, id: "call-write" },
    );

    await run({ permissionMode: "dontAsk" });

    expect(cards()).toEqual([]);
    expect(executed()).toEqual([["read_file", { path: "src/a.ts" }]]);
    expect(resultsSeen()).toContain("[Don't-ask mode]");
  });

  it("an unattended run (the scheduler's and timer's shape) with no mode is in dontAsk", async () => {
    script({ name: "execute_shell", args: { command: "npm test" }, id: "call-shell" });

    // Exactly what ScheduledTaskService / ConversationTimerService pass now.
    await run({ agenticLoopEnabled: true, functionCallingEnabled: true, planFirst: false, unattended: true });

    expect(cards()).toEqual([]);
    expect(executed()).toEqual([]);
    expect(modeEvents()[0]).toMatchObject({ mode: "dontAsk", source: "unattended", unattended: true });
    expect(resultsSeen()).toContain("[Don't-ask mode]");
  });

  it("an unattended run on a plan-mode conversation stays read-only", async () => {
    await storeConversation({ permissionMode: "plan" });
    script({ name: "write_file", args: { path: "src/a.ts", content: "x" }, id: "call-write" });

    await run({ unattended: true });

    expect(executed()).toEqual([]);
    expect(resultsSeen()).toContain("[Plan mode]");
    expect(storedMode()).toBe("plan");
  });

  it("bypass requires the owner flag", async () => {
    delete process.env[BYPASS_OWNERS_ENV_VAR];
    script({ name: "execute_shell", args: { command: "npm test" }, id: "call-shell" });

    await run({ permissionMode: "bypass" });

    expect(modeEvents()[0]).toMatchObject({ mode: "default", refused: "bypass" });
    expect(cards().map((card) => card.toolCall.name)).toEqual(["execute_shell"]);
    expect(executed()).toEqual([]);
  });

  it("bypass for an owner runs without asking", async () => {
    process.env[BYPASS_OWNERS_ENV_VAR] = USERNAME;
    script({ name: "execute_shell", args: { command: "npm test" }, id: "call-shell" });

    await run({ permissionMode: "bypass" });

    expect(modeEvents()[0]).toMatchObject({ mode: "bypass", source: "request" });
    expect(cards()).toEqual([]);
    expect(executed()).toEqual([["execute_shell", { command: "npm test" }]]);
  });

  it("protected paths always ask — acceptEdits, bypass and full auto alike", async () => {
    process.env[BYPASS_OWNERS_ENV_VAR] = USERNAME;
    for (const options of [{ permissionMode: "acceptEdits" }, { permissionMode: "bypass" }, { autoApprove: true }]) {
      emitted = [];
      vi.mocked(ToolOrchestratorService.executeTool).mockClear();
      script(
        { name: "write_file", args: { path: ".env", content: "KEY=1" }, id: "call-env" },
        { name: "write_file", args: { path: "/ws/.git/config", content: "x" }, id: "call-git" },
        { name: "write_file", args: { path: ".prism/agents/a.md", content: "x" }, id: "call-prism" },
      );

      await run(options);

      expect(cards().map((card) => card.protectedPath)).toEqual([".env", "/ws/.git/config", ".prism/agents/a.md"]);
      expect(cards().every((card) => card.alwaysAsks === true)).toBe(true);
      expect(executedWrites()).toEqual([]);
    }
  });

  it("where nobody can answer, a protected path is denied instead", async () => {
    script({ name: "write_file", args: { path: ".env", content: "KEY=1" }, id: "call-env" });

    await run({ autoApprove: true, unattended: true });

    expect(cards()).toEqual([]);
    expect(executed()).toEqual([]);
    expect(resultsSeen()).toContain("protected path");
  });

  it("a mid-turn switch applies to the next call and emits an event", async () => {
    await storeConversation({ permissionMode: "acceptEdits" });
    // The user flips the selector while the model is thinking.
    onFirstModelCall = () => PermissionModeRegistry.get(CONVERSATION)!.set("plan", "user");
    script({ name: "write_file", args: { path: "src/a.ts", content: "x" }, id: "call-write" });

    await run({});

    expect(executed()).toEqual([]);
    expect(resultsSeen()).toContain("[Plan mode]");
    expect(modeEvents()).toEqual([
      expect.objectContaining({ mode: "acceptEdits", source: "conversation" }),
      expect.objectContaining({ mode: "plan", previousMode: "acceptEdits", source: "user" }),
    ]);
    // The turn is over: nothing is left registered.
    expect(PermissionModeRegistry.get(CONVERSATION)).toBeNull();
  });

  it("an approved plan leaves plan mode — for the turn and the conversation", async () => {
    await storeConversation({ permissionMode: "plan" });
    script({ name: "exit_plan_mode", args: { summary: "1. Edit a.ts" }, id: "call-plan" });

    await run({});

    expect(modeEvents()).toEqual([
      expect.objectContaining({ mode: "plan" }),
      expect.objectContaining({ mode: "default", previousMode: "plan", source: "plan_approved" }),
    ]);
    await vi.waitFor(() => expect(storedMode()).toBe("default"));
  });

  it("an unattended run never parks on a plan card — exit_plan_mode is refused, the plan goes in the reply", async () => {
    await storeConversation({ permissionMode: "plan" });
    script({ name: "exit_plan_mode", args: { summary: "1. Edit a.ts" }, id: "call-plan" });

    await run({ unattended: true });

    expect(emitted.filter((event) => event.type === "plan_proposal")).toEqual([]);
    const result = JSON.parse(resultFor("call-plan"));
    expect(result).toMatchObject({ error: "PERMISSION_MODE_DENIED" });
    expect(result.message).toContain("Write the plan in your reply");
    // Still in plan mode: nothing approved the plan.
    expect(modeEvents()).toHaveLength(1);
    expect(storedMode()).toBe("plan");
  });

  it("a new conversation keeps the mode its first request named; a caller's override on an existing one is not stored", async () => {
    await storeConversation({ permissionMode: "acceptEdits" });
    script({ name: "read_file", args: { path: "a" }, id: "call-read" });
    await run({ unattended: true, permissionMode: "dontAsk" });
    expect(storedMode()).toBe("acceptEdits");

    mongo.collections.clear();
    await storeConversation({});
    script({ name: "read_file", args: { path: "a" }, id: "call-read" });
    await run({ permissionMode: "plan" }, { isNewConversation: true });
    await vi.waitFor(() => expect(storedMode()).toBe("plan"));
  });
});
