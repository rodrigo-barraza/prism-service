/**
 * A service's turn, inside a REAL agentic loop (ServiceTurnLimits).
 *
 * AgenticLoopService → AgenticToolResolver → ReActHarness → ApprovalGate →
 * AutoApprovalEngine are real; the tool executor, the provider and the heavy
 * side services are mocked (the mocks of capabilityScopeInTheLoop.test).
 *
 * A turn a service's request starts runs without the shell, file writes,
 * outside actions and MCP: those tools are left out of its schema, and the
 * run's scope — the one its sub-agents, tool programs and async dispatchers
 * inherit — has the approval engine refuse them. LUPOS keeps what his own
 * policies chose; a signed-in user's turn is untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import AgenticLoopService from "#src/services/AgenticLoopService";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";
import { clearPermissionRuleCache } from "#src/services/permissions/PermissionRuleStore";
import { registerToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import { CapabilityScopeHandle, currentScope } from "#src/services/permissions/CapabilityScope";
import type { AuthKind } from "#src/utils/RequestContext";
import { runAs } from "../../../../tests/helpers/auth.ts";

const MCP_TOOL = "mcp__github__create_issue";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ToolOrchestratorService", () => {
  const catalog = ["search_web", "execute_shell", "execute_python", "send_email"];
  return {
    default: {
      ensureSchemas: vi.fn().mockResolvedValue(undefined),
      getToolSchemas: vi.fn().mockReturnValue(catalog.map((name) => ({ name, description: name }))),
      getClientToolSchemas: vi.fn().mockReturnValue(catalog.map((name) => ({ name, domain: "test", labels: [] }))),
      // The owner's shared GitHub server, as a run's MCP tools arrive.
      getMCPToolSchemas: vi.fn().mockReturnValue([
        { name: "mcp__github__create_issue", description: "Open an issue", _mcpServer: "github", _mcpOriginalName: "create_issue" },
      ]),
      executeTool: vi.fn(),
      isStreamable: vi.fn().mockReturnValue(false),
      getToolEmoji: vi.fn().mockReturnValue(null),
      getToolLabel: vi.fn().mockReturnValue("Using Tool"),
    },
  };
});

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

// tools-service's tags (ToolCapabilities.ts) — the mocked orchestrator registers none.
registerToolCapabilities([{ name: "send_email", capabilities: ["network", "external_side_effect"] }], "test");

const USAGE = { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };

/** One model step calling `names`, then a closing answer. */
function scriptCalls(provider: any, names: string[]) {
  provider.generateTextStream
    .mockImplementationOnce(async function* () {
      for (const name of names) {
        yield { type: "toolCall", name, args: name === "execute_python" ? { code: "print(2 + 2)" } : {}, id: `call-${name}` };
      }
      yield USAGE;
    })
    .mockImplementation(async function* () {
      yield "Done.";
      yield USAGE;
    });
}

describe("a service's turn in a real loop", () => {
  let provider: any;

  /** Run a turn as `kind`; returns its context, whose options hold the run's scope handle. */
  async function run(kind: AuthKind, conversationId: string, extra: { agent?: string; options?: Record<string, unknown> } = {}) {
    const context = {
      provider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 10_000, inputTypes: [MODALITY_TYPES.TEXT], outputTypes: [MODALITY_TYPES.TEXT] },
      messages: [{ role: MESSAGE_ROLES.USER, content: "What is 2 + 2? Then file an issue about it." }],
      options: { maxIterations: 4, toolDiscovery: "off", ...extra.options },
      agentConversationId: conversationId,
      conversationId,
      parentAgentConversationId: null,
      traceId: "trace",
      project: "scope-project",
      username: kind === "service" ? "visitor" : "rodrigo",
      profileId: "default",
      ...(extra.agent && { agent: extra.agent }),
      workspaceRoot: "/ws",
      requestId: "req",
      requestStart: performance.now(),
      emit: vi.fn(),
      signal: new AbortController().signal,
    } as any;
    await runAs(kind, context.username, () => AgenticLoopService.runAgenticLoop(context));
    return context;
  }

  const declaredTools = (call = 0): string[] =>
    (provider.generateTextStream.mock.calls[call][2].tools ?? []).map((tool: { name: string }) => tool.name).sort();
  const executed = (): string[] => vi.mocked(ToolOrchestratorService.executeTool).mock.calls.map((call) => call[0] as string);
  const toolMessage = (call: number, name: string) =>
    JSON.stringify(
      provider.generateTextStream.mock.calls[call][0].find(
        (message: any) => message.role === MESSAGE_ROLES.TOOL && JSON.stringify(message).includes(name),
      ) ?? null,
    );

  beforeEach(() => {
    clearPermissionRuleCache();
    vi.mocked(ToolOrchestratorService.executeTool).mockReset();
    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({ success: true, content: "4" });
    (SettingsService.getCached as any).mockReturnValue({ creative: {} });
    provider = { generateTextStream: vi.fn() };
  });

  it("with no persona: the shell, the python sandbox, a send_* tool and an MCP tool are out of its schema and refused", async () => {
    scriptCalls(provider, ["execute_shell", "execute_python", "send_email", MCP_TOOL, "search_web"]);
    const context = await run("service", "conv-service-default");

    expect(declaredTools()).toEqual(["search_web"]);
    expect(executed()).toEqual(["search_web"]);

    // The run's scope, as every engine of the turn — and of its sub-agents,
    // programs and async tasks — reads it: full auto refuses them too.
    const handle = context.options._capabilityScope;
    expect(handle).toBeInstanceOf(CapabilityScopeHandle);
    expect(currentScope(handle)).toEqual({ denied: ["fs_write", "shell", "mcp", "external_side_effect"] });
    const engine = new AutoApprovalEngine({ fullAuto: true, capabilityScope: handle });
    for (const name of ["execute_shell", "execute_python", "send_email", MCP_TOOL]) {
      const verdict = engine.check({ id: `check-${name}`, name, args: {} });
      expect(verdict, name).toMatchObject({ isApproved: false, isDenied: true, layer: "capability_scope" });
    }
    expect(engine.check({ id: "check-search", name: "search_web", args: { query: "x" } }).isDenied).toBeFalsy();
  });

  it("LUPOS keeps execute_python, and execute_shell is still denied by his own policy", async () => {
    scriptCalls(provider, ["execute_python", "execute_shell"]);
    // Both enabled explicitly so both reach his schema: what decides is the scope and his policies.
    const context = await run("service", "conv-service-lupos", {
      agent: "LUPOS",
      options: { enabledTools: ["execute_python", "execute_shell", "search_web"] },
    });

    expect(currentScope(context.options._capabilityScope)).toEqual({ denied: ["mcp"] });
    expect(declaredTools()).toEqual(["execute_python", "execute_shell", "search_web"]);
    expect(executed()).toEqual(["execute_python"]);
    const shellResult = toolMessage(1, "call-execute_shell");
    expect(shellResult).toContain("POLICY_DENIED");
    expect(shellResult).not.toContain("CAPABILITY_SCOPE_DENIED");
  });

  it("a signed-in user's turn is untouched: every tool declared, nothing narrowed", async () => {
    scriptCalls(provider, ["execute_python", "search_web"]);
    const context = await run("user", "conv-user", { options: { autoApprove: true } });

    expect(declaredTools()).toEqual([MCP_TOOL, "execute_python", "execute_shell", "search_web", "send_email"].sort());
    expect(currentScope(context.options._capabilityScope)).toBeNull();
    expect(executed()).toEqual(["execute_python", "search_web"]);
  });
});
