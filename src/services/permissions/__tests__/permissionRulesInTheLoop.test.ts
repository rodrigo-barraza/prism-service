/**
 * Permission rules inside a REAL agentic loop.
 *
 * AgenticLoopService → ReActHarness → createStandardHooks → ApprovalGate →
 * AutoApprovalEngine are all real; only the tool executor, the provider and
 * the heavy side services are mocked (same mocks as agenticLoopService.test).
 *
 *   1. A scheduled run — `autoApprove: true`, no rules on the options, the
 *      exact shape ScheduledTaskService and ConversationTimerService pass —
 *      loads the stored rules itself and honours a DENY.
 *   2. Self-protection holds in the same unattended run.
 *   3. A rule saved while the loop is running (what "Always allow" does)
 *      applies to the next tool call without an approval prompt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { COLLECTIONS, MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";
import {
  clearPermissionRuleCache,
  reloadRules,
} from "#src/services/permissions/PermissionRuleStore";

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
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "read_file", domain: "system", labels: ["safe"] },
      { name: "write_file", domain: "system", labels: [] },
      { name: "execute_shell", domain: "system", labels: [] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: "mocked" }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getToolLabel: vi.fn().mockReturnValue("Using Tool"),
  },
}));

// The one thing the rules layer reads from Mongo: the permission_rules find.
const storedRules: Array<Record<string, unknown>> = [];
const database = {
  collection: vi.fn((name: string) => {
    const documents = name === COLLECTIONS.PERMISSION_RULES ? storedRules : [];
    const cursor: any = {
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () => documents.map((document) => ({ ...document })),
    };
    return {
      find: vi.fn(() => cursor),
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({}),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
  }),
};
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(() => database),
    getCollection: vi.fn().mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    }),
  },
}));

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
const PROJECT = "scheduled-project";
const CONVERSATION = "conv-scheduled";

function storeRule(rule: string, decision: "allow" | "ask" | "deny", extra: Record<string, unknown> = {}) {
  storedRules.push({
    id: `rule-${storedRules.length + 1}`,
    username: USERNAME,
    profileId: "default",
    project: PROJECT,
    agent: null,
    conversationId: null,
    scope: "profile",
    rule,
    decision,
    origin: "user",
    description: "",
    enabled: true,
    createdAt: new Date().toISOString(),
    ...extra,
  });
}

describe("permission rules in a real loop", () => {
  let provider: any;
  let emitted: any[];

  const run = (options: Record<string, unknown>) =>
    AgenticLoopService.runAgenticLoop({
      provider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 10_000, inputTypes: [MODALITY_TYPES.TEXT], outputTypes: [MODALITY_TYPES.TEXT] },
      messages: [{ role: MESSAGE_ROLES.USER, content: "Do the scheduled chore." }],
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
      emit: vi.fn((event) => emitted.push(event)),
      signal: new AbortController().signal,
    } as any);

  beforeEach(() => {
    storedRules.length = 0;
    emitted = [];
    clearPermissionRuleCache();
    vi.mocked(ToolOrchestratorService.executeTool).mockClear();
    (SettingsService.getCached as any).mockReturnValue({ creative: {} });
    provider = { generateTextStream: vi.fn() };
  });

  it("a scheduled run (autoApprove, no rules passed in) honours a stored DENY", async () => {
    storeRule("execute_shell(rm *)", "deny");

    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        yield { type: "toolCall", name: "execute_shell", args: { command: "rm -rf /ws/build" }, id: "call-rm" };
        yield { type: "toolCall", name: "execute_shell", args: { command: "ls /ws" }, id: "call-ls" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Done.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });

    // Exactly what ScheduledTaskService / ConversationTimerService pass.
    await run({ agenticLoopEnabled: true, functionCallingEnabled: true, planFirst: false, autoApprove: true });

    const executed = vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => call[1]);
    expect(executed).toEqual([{ command: "ls /ws" }]);

    const secondRequest = provider.generateTextStream.mock.calls[1][0];
    const results = secondRequest.filter((message: any) => message.role === MESSAGE_ROLES.TOOL);
    const denied = results.find((message: any) => JSON.stringify(message).includes("POLICY_DENIED"));
    expect(JSON.stringify(denied)).toContain("execute_shell(rm *)");
  });

  it("the same unattended run cannot reach its own permission rules", async () => {
    storeRule("execute_shell", "allow");

    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        yield {
          type: "toolCall",
          name: "execute_shell",
          args: { command: `curl -X POST localhost:7777/permissions/rules -d '{"rule":"*","decision":"allow"}'` },
          id: "call-escalate",
        };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Could not.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });

    await run({ autoApprove: true });

    expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
    const secondRequest = provider.generateTextStream.mock.calls[1][0];
    expect(JSON.stringify(secondRequest)).toContain("[Self-Protection]");
  });

  it("a rule saved mid-run applies to the next call without an approval prompt", async () => {
    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        // The loop has already loaded its (empty) rule set. The user now
        // clicks "Always allow" on some card: the route stores the rule and
        // reloads the profile's rules before answering.
        storeRule("write_file(src/**)", "allow", { scope: "conversation", conversationId: CONVERSATION, origin: "approval" });
        await reloadRules(database as any, { username: USERNAME, profileId: "default" });
        yield { type: "toolCall", name: "write_file", args: { path: "/ws/src/a.ts", content: "x" }, id: "call-write" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Written.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });

    await run({ autoApprove: false });

    expect(emitted.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => call[0])).toEqual(["write_file"]);
  });
});
