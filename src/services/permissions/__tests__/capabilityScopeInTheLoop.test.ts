/**
 * Prompt 22, Landing 3 — capability narrowing, inside a REAL agentic loop.
 *
 * AgenticLoopService → ReActHarness → createStandardHooks → ApprovalGate →
 * AutoApprovalEngine are real; the tool executor, the provider and the heavy
 * side services are mocked (the mocks of permissionRulesInTheLoop.test).
 *
 * A run started with a capability set — a sub-agent spawned with
 * `network: false` (the options the orchestrator builds, pinned in
 * subAgentCapabilityScope.test.ts), a scheduled task — is refused every
 * tool carrying a capability the set takes away, even in full auto.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";
import { clearPermissionRuleCache } from "#src/services/permissions/PermissionRuleStore";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", description: "Search the web" },
      { name: "read_file", description: "Read a file" },
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", domain: "web", labels: ["safe"] },
      { name: "read_file", domain: "system", labels: ["safe"] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn(),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getToolLabel: vi.fn().mockReturnValue("Using Tool"),
  },
}));

const database = {
  collection: vi.fn(() => {
    const cursor: any = { sort: () => cursor, limit: () => cursor, toArray: async () => [] };
    return {
      find: vi.fn(() => cursor),
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({}),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
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

const CONVERSATION = "conv-scope-loop";

describe("capability narrowing in a real loop", () => {
  let provider: any;

  const run = (options: Record<string, unknown>) =>
    AgenticLoopService.runAgenticLoop({
      provider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 10_000, inputTypes: [MODALITY_TYPES.TEXT], outputTypes: [MODALITY_TYPES.TEXT] },
      messages: [{ role: MESSAGE_ROLES.USER, content: "Summarize the notes in /ws/notes.md — no web needed." }],
      options: { maxIterations: 4, ...options },
      agentConversationId: CONVERSATION,
      conversationId: CONVERSATION,
      parentAgentConversationId: null,
      traceId: "trace",
      project: "scope-project",
      username: "rodrigo",
      profileId: "default",
      workspaceRoot: "/ws",
      requestId: "req",
      requestStart: performance.now(),
      emit: vi.fn(),
      signal: new AbortController().signal,
    } as any);

  beforeEach(() => {
    clearPermissionRuleCache();
    vi.mocked(ToolOrchestratorService.executeTool).mockReset();
    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({ success: true, content: "notes" });
    (SettingsService.getCached as any).mockReturnValue({ creative: {} });
    provider = { generateTextStream: vi.fn() };
  });

  it("a sub-agent spawned with network: false is denied a network tool — full auto included", async () => {
    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        yield { type: "toolCall", name: "search_web", args: { query: "notes summary" }, id: "call-search" };
        yield { type: "toolCall", name: "read_file", args: { path: "/ws/notes.md" }, id: "call-read" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Summary without the web.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });

    // The options the orchestrator builds for such a sub-agent.
    await run({ autoApprove: true, isSubAgent: true, _capabilityScope: { denied: ["network"] } });

    expect(vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => call[0])).toEqual(["read_file"]);
    const secondRequest = provider.generateTextStream.mock.calls[1][0];
    const denied = secondRequest.find(
      (message: any) => message.role === MESSAGE_ROLES.TOOL && JSON.stringify(message).includes("CAPABILITY_SCOPE_DENIED"),
    );
    expect(JSON.stringify(denied)).toContain("[Capability scope]");
    expect(JSON.stringify(denied)).toContain("no network");
  });

  it("a scope smuggled in a request body as plain data still narrows, never widens", async () => {
    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        yield { type: "toolCall", name: "search_web", args: { query: "x" }, id: "call-search" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Done.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });

    await run({ autoApprove: true, _capabilityScope: { network: false } });

    expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
  });
});
