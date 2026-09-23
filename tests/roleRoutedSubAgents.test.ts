/**
 * Prompt 11 Landing 2 — a sub-agent spawns on ITS role's provider and model.
 *
 * The real createTeam → hierarchical router → spawnFromTool path, with the
 * sub-agents' own loops scripted. Red on master: the Settings sub-agent
 * model was only a fallback for busy local instances, and InstanceResolver
 * assigned every member its PARENT's provider — a Gemini sub-agent under a
 * Claude parent ran `gemini-3.6-flash` against the Anthropic API.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, COLLECTIONS } from "#src/constants";
import type { ConversationMessage } from "#src/services/harnesses/types";
import type { OrchestratorContext } from "#src/types/orchestrator";

const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

import OrchestratorService from "#src/services/OrchestratorService";
import SettingsService from "#src/services/SettingsService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import localModelQueue from "#src/services/LocalModelQueue";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { selectInstanceForMember } from "#src/services/orchestrator/InstanceResolver";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const insertedDecisions: Array<Record<string, unknown>> = [];
let lastRequestRow: Record<string, unknown> | null = null;

function orchestratorContext(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.ANTHROPIC,
    resolvedModel: "claude-sonnet-5",
    traceId: "trace-routing",
    agentConversationId: "parent-session",
    conversationId: "parent-conv",
    // Depth 1 dispatches block, so createTeam returns once the member ran.
    recursionDepth: 1,
    maxRecursionDepth: 3,
    reasoningEffort: "high",
    thinkingEnabled: true,
    autoApprove: true,
    ...overrides,
  } as OrchestratorContext;
}

function settingsWith(agents: Record<string, unknown>) {
  return vi.spyOn(SettingsService, "getSection").mockImplementation(async (section: string) =>
    (section === "agents" ? agents : {}) as never,
  );
}

async function spawnOne(member: Record<string, unknown>, context = orchestratorContext()) {
  const results = await OrchestratorService.createTeam(
    { name: "one", members: [{ description: "Look it up", prompt: "Find the answer", ...member }] as never },
    context,
  );
  expect(results).toHaveLength(1);
  expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
  return mockRunAgenticLoop.mock.calls[0][0] as {
    providerName: string;
    resolvedModel: string;
    options: Record<string, unknown>;
  };
}

describe("role routing — a sub-agent runs on its role's provider and model", () => {
  let settingsSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    insertedDecisions.length = 0;
    lastRequestRow = null;
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(async (args: { messages: ConversationMessage[] }) => ({
      messages: [...args.messages, { role: "assistant", content: "Brief: done." }],
    }));
    OrchestratorService.clearAllActiveSubAgents();
    vi.mocked(MongoWrapper.getCollection).mockImplementation(((_database: string, name: string) => ({
      findOne: vi.fn().mockImplementation(async () =>
        name === COLLECTIONS.REQUESTS ? lastRequestRow : null,
      ),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockImplementation(async (document: Record<string, unknown>) => {
        if (name === COLLECTIONS.MODEL_ROUTING_DECISIONS) insertedDecisions.push(document);
        return { acknowledged: true };
      }),
      find: vi.fn().mockReturnValue({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
    })) as never);
  });

  afterEach(() => {
    settingsSpy?.mockRestore();
    settingsSpy = null;
    AgentPersonaRegistry.unregister("ROUTED_RESEARCHER");
    OrchestratorService.clearAllActiveSubAgents();
  });

  it("RED: Settings routes a Claude parent's sub-agent to Gemini — provider AND model", async () => {
    settingsSpy = settingsWith({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });

    const loop = await spawnOne({});

    expect(loop.providerName).toBe(PROVIDERS.GOOGLE);
    expect(loop.resolvedModel).toBe("gemini-3.6-flash");
    // The parent's effort, as Gemini spells it: thinkingLevel.
    expect(loop.options.reasoningEffort).toBe("high");
    expect(loop.options.thinkingLevel).toBe("high");
  });

  it("RED: InstanceResolver keeps a member on its routed provider, not its (local) parent's", () => {
    const selection = selectInstanceForMember(
      { description: "d", prompt: "p", provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash" },
      { isLocal: true, siblings: [], instanceModelOverrides: new Map(), orchestratorFallback: null },
      { providerName: PROVIDERS.LM_STUDIO, resolvedModel: "gemma-4-12b" },
    );
    expect(selection.assignedProvider).toBe(PROVIDERS.GOOGLE);
    expect(selection.assignedModel).toBe("gemini-3.6-flash");
    expect(selection.assignment).toBeNull();
  });

  it("effort first: a sub-agent nothing pins keeps the parent's model one effort step lower", async () => {
    settingsSpy = settingsWith({});

    const loop = await spawnOne({});

    expect(loop.providerName).toBe(PROVIDERS.ANTHROPIC);
    expect(loop.resolvedModel).toBe("claude-sonnet-5");
    expect(loop.options.reasoningEffort).toBe("medium");
  });

  it("Settings subAgentEffort=inherit keeps the parent's effort", async () => {
    settingsSpy = settingsWith({ subAgentEffort: "inherit" });

    const loop = await spawnOne({});

    expect(loop.resolvedModel).toBe("claude-sonnet-5");
    expect(loop.options.reasoningEffort).toBe("high");
  });

  it("a custom agent that pins its model outranks Settings (cross-provider, with its own effort)", async () => {
    settingsSpy = settingsWith({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });
    AgentPersonaRegistry.registerCustom({
      agentId: "ROUTED_RESEARCHER",
      name: "Routed Researcher",
      availableTools: ["search_web"],
      modelRoles: { main: { model: "gpt-5.6-luna", effort: "low" } },
    });

    const loop = await spawnOne({ agent: "ROUTED_RESEARCHER" });

    expect(loop.providerName).toBe(PROVIDERS.OPENAI);
    expect(loop.resolvedModel).toBe("gpt-5.6-luna");
    expect(loop.options.reasoningEffort).toBe("low");
  });

  it("the user's explicit model (create_subagent `model`) takes its catalog provider", async () => {
    settingsSpy = settingsWith({});

    const loop = await spawnOne({ model: "gemini-3.6-flash" });

    expect(loop.providerName).toBe(PROVIDERS.GOOGLE);
    expect(loop.resolvedModel).toBe("gemini-3.6-flash");
  });

  it("a local parent's model guess is still ignored (GGUF names are not the LLM's to invent)", async () => {
    settingsSpy = settingsWith({});
    const isLocalSpy = vi.spyOn(localModelQueue, "isLocal").mockImplementation(
      (provider: string) => provider === PROVIDERS.LM_STUDIO,
    );
    try {
      const loop = await spawnOne(
        { model: "made-up-model" },
        orchestratorContext({ providerName: PROVIDERS.LM_STUDIO, resolvedModel: "gemma-4-12b" }),
      );
      expect(loop.resolvedModel).toBe("gemma-4-12b");
    } finally {
      isLocalSpy.mockRestore();
    }
  });

  it("writes a decision row: role, model, reason, source and a cache-warmth estimate", async () => {
    settingsSpy = settingsWith({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });
    lastRequestRow = { createdAt: new Date().toISOString() };

    await spawnOne({});

    expect(insertedDecisions).toHaveLength(1);
    expect(insertedDecisions[0]).toMatchObject({
      role: "subagent",
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.6-flash",
      source: "settings",
      reason: "Settings sub-agent model",
      conversationId: "parent-conv",
      agent: "CODING",
      outcome: null,
      cacheWarmth: { warm: true, scope: "conversation" },
    });
    expect(insertedDecisions[0].subAgentId).toEqual(expect.any(String));
  });
});
