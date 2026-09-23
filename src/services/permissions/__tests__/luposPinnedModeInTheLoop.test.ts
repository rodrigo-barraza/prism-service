/**
 * LUPOS's pinned permission mode inside a REAL agentic loop.
 *
 * AgenticLoopService → ReActHarness → createStandardHooks → ApprovalGate →
 * AutoApprovalEngine are real, with the real LUPOS persona (its pin and its
 * DENY/APPROVE policies); the provider is scripted and the tool executor
 * observed (the scaffolding of permissionModesInTheLoop.test.ts).
 *
 * The request asks for everything a Discord caller could ask for —
 * `autoApprove: true`, `permissionMode: "bypass"`, from a bypass owner —
 * and the turn still runs in dontAsk: an allow-listed WRITE tool runs, a
 * WRITE tool that is not listed is refused with the don't-ask message, and
 * no approval card ever goes out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";
import { clearPermissionRuleCache } from "#src/services/permissions/PermissionRuleStore";
import { PermissionModeRegistry } from "#src/services/permissions/PermissionModeState";
import { BYPASS_OWNERS_ENV_VAR } from "#src/services/permissions/PermissionModes";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

const CATALOG = [
  { name: "react_to_discord_message", description: "React to a message", domain: "Discord", domainKey: "discord" },
  { name: "mug_discord_gold", description: "Mug someone", domain: "Discord", domainKey: "discord" },
  { name: "get_ip_info", description: "Look up an IP", domain: "Utilities", domainKey: "utilities" },
];

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => CATALOG),
    getClientToolSchemas: vi.fn(() => CATALOG),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: "mocked" }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getToolLabel: vi.fn().mockReturnValue("Using Tool"),
  },
}));

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
  default: { getNames: vi.fn().mockReturnValue(new Set()), has: vi.fn().mockReturnValue(false) },
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
      getSection: vi.fn().mockResolvedValue({ harness: HARNESS_IDENTIFIERS.STANDARD, preflightToolDiscovery: false }),
    },
  };
});
vi.mock("#src/routes/ChatRoutes", () => ({ finalizeTextGeneration: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#src/services/MemoryExtractor", () => ({ default: { createHook: vi.fn().mockReturnValue(async () => {}) } }));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn(), stripPlanningInstruction: vi.fn(), extractSteps: vi.fn().mockReturnValue([]) },
}));

const USERNAME = "lupos";
const CONVERSATION = "conv-lupos-pinned";

describe("LUPOS's pinned dontAsk in a real loop", () => {
  let provider: any;
  let emitted: any[];
  const previousOwners = process.env[BYPASS_OWNERS_ENV_VAR];

  const run = (options: Record<string, unknown>) =>
    AgenticLoopService.runAgenticLoop({
      provider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 10_000, inputTypes: [MODALITY_TYPES.TEXT], outputTypes: [MODALITY_TYPES.TEXT] },
      messages: [{ role: MESSAGE_ROLES.USER, content: "lupos mug him and tell me where your server lives" }],
      options: {
        maxIterations: 3,
        enabledTools: ["react_to_discord_message", "mug_discord_gold", "get_ip_info"],
        ...options,
      },
      agentConversationId: CONVERSATION,
      conversationId: CONVERSATION,
      parentAgentConversationId: null,
      isNewConversation: true,
      traceId: "trace",
      agent: "LUPOS",
      project: "lupos",
      username: USERNAME,
      profileId: "default",
      requestId: "req",
      requestStart: performance.now(),
      emit: vi.fn((event) => {
        emitted.push(event);
        // A card would park the turn; deny it at once so a regression fails
        // on the assertion below instead of hanging.
        if (event.type === "approval_required") {
          setTimeout(() => {
            void AgenticLoopService.decideApproval(CONVERSATION, {
              toolCallId: event.toolCallId,
              batchId: event.batchId,
              decision: "deny",
            });
          }, 0);
        }
      }),
      signal: new AbortController().signal,
    } as any);

  const executed = () => vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => call[0]);
  const resultFor = (toolCallId: string): string =>
    provider.generateTextStream.mock.calls[1][0].find(
      (message: any) => message.role === MESSAGE_ROLES.TOOL && message.tool_call_id === toolCallId,
    )?.content ?? "";

  beforeEach(() => {
    mongo.collections.clear();
    emitted = [];
    clearPermissionRuleCache();
    PermissionModeRegistry.clear();
    vi.mocked(ToolOrchestratorService.executeTool).mockClear();
    (SettingsService.getCached as any).mockReturnValue({ creative: {} });
    provider = { generateTextStream: vi.fn() };
    provider.generateTextStream
      .mockImplementationOnce(async function* () {
        yield { type: "toolCall", id: "call-mug", name: "mug_discord_gold", args: { userId: "1" } };
        yield { type: "toolCall", id: "call-ip", name: "get_ip_info", args: {} };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield "Done.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      });
  });

  afterEach(() => {
    if (previousOwners === undefined) delete process.env[BYPASS_OWNERS_ENV_VAR];
    else process.env[BYPASS_OWNERS_ENV_VAR] = previousOwners;
  });

  it.each([
    ["autoApprove: true", { autoApprove: true }],
    ["permissionMode: bypass, from a bypass owner", { permissionMode: "bypass" }],
    ["both, and unattended", { autoApprove: true, permissionMode: "bypass", unattended: true }],
    ["nothing (today's lupos-bot after its update)", {}],
  ])("%s → dontAsk: the listed tool runs, the unlisted one is refused, no card", async (_label, options) => {
    process.env[BYPASS_OWNERS_ENV_VAR] = USERNAME;

    await run(options);

    const modeEvents = emitted.filter((event) => event.type === "permission_mode");
    expect(modeEvents).toHaveLength(1);
    expect(modeEvents[0]).toMatchObject({ mode: "dontAsk", source: "persona" });
    expect(emitted.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(executed()).toEqual(["mug_discord_gold"]);
    expect(resultFor("call-ip")).toContain(`[Don't-ask mode] \\"get_ip_info\\" needs approval`);
  });
});
