/**
 * Prompt 17, Landing 2 — red first: a custom agent can be spawned as a
 * sub-agent.
 *
 * The spawn tools list agents by NAME ("My Agent", "Clankerbox"), but the
 * spawn looked the agent up by uppercased id — "MY AGENT" is not
 * "CUSTOM_MY_AGENT", "CLANKERBOX" is not "STICKERS" — so every custom agent
 * (and every built-in whose name is not its id) silently spawned as the
 * PARENT's type instead. Driven through the real create_subagent tool →
 * createTeam → hierarchical router → spawnFromTool; only the sub-agent's own
 * loop is stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

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
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: vi.fn().mockResolvedValue(undefined) };
});

import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import OrchestratorService from "#src/services/OrchestratorService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import AgentNotificationService from "#src/services/AgentNotificationService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";

const CUSTOM_AGENT = {
  agentId: "CUSTOM_MY_AGENT",
  name: "My Agent",
  description: "Looks things up on the web.",
  identity: "You look things up.",
  availableTools: ["search_web"],
};

async function spawnSubAgentNamed(agent: string) {
  const result = await ToolOrchestratorService.executeTool(
    "create_subagent",
    { description: "Look it up", prompt: "Find the answer.", agent },
    {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      agentConversationId: "parent-session",
      conversationId: "parent-conversation",
      _providerName: PROVIDERS.GOOGLE,
      _resolvedModel: "gemini-3-flash-preview",
      enabledTools: ["search_web", "read_file", "write_file"],
      _recursionDepth: 0,
      _maxRecursionDepth: 2,
      _autoApprove: true,
    },
  );
  expect(result).not.toHaveProperty("error");
  await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1));
  return mockRunAgenticLoop.mock.calls[0][0] as {
    agent: string;
    options: { enabledTools?: string[] };
  };
}

describe("a custom agent named in create_subagent spawns as itself", () => {
  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(async (context: { messages: unknown[] }) => ({
      messages: [...context.messages, { role: "assistant", content: "done" }],
    }));
    OrchestratorService.clearAllActiveSubAgents();
    AgentPersonaRegistry.registerCustom({ ...CUSTOM_AGENT });
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
    } as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    OrchestratorService.clearAllActiveSubAgents();
    AgentPersonaRegistry.unregister(CUSTOM_AGENT.agentId);
  });

  it("by the name the tool schema lists ('My Agent') — its type and its tools, not the parent's", async () => {
    const loop = await spawnSubAgentNamed("My Agent");
    expect(loop.agent).toBe("CUSTOM_MY_AGENT");
    expect(loop.options.enabledTools).toEqual(["search_web"]);
  });

  it("a built-in whose display name is not its id ('Clankerbox' → STICKERS)", async () => {
    const loop = await spawnSubAgentNamed("Clankerbox");
    expect(loop.agent).toBe("STICKERS");
  });

  it("control: the id still resolves", async () => {
    const loop = await spawnSubAgentNamed("CUSTOM_MY_AGENT");
    expect(loop.agent).toBe("CUSTOM_MY_AGENT");
  });

  it("a resumed agent that completes is reported to its parent as ✅, not ❌", async () => {
    // The result's status is "completed"; the state constant is "complete" —
    // comparing the two labelled every successful resume a failure.
    await spawnSubAgentNamed("My Agent");
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    await vi.waitFor(() => expect(subAgent.status).toBe("complete"));
    const notificationSpy = vi.spyOn(AgentNotificationService, "createNotificationMessage");
    try {
      const resumed = await ToolOrchestratorService.executeTool(
        "resume_subagent",
        { agent_id: subAgent.agentId, prompt: "One more thing." },
        {
          project: "test-project",
          username: "test-user",
          agent: "CODING",
          agentConversationId: "parent-session",
          conversationId: "parent-conversation",
          _providerName: PROVIDERS.GOOGLE,
          _resolvedModel: "gemini-3-flash-preview",
          _recursionDepth: 0,
          _maxRecursionDepth: 2,
          _autoApprove: true,
        },
      );
      expect(resumed).not.toHaveProperty("error");
      await vi.waitFor(() =>
        expect(notificationSpy).toHaveBeenCalledWith(
          expect.objectContaining({ summary: expect.stringContaining("RESUMED") }),
        ),
      );
      const [notification] = notificationSpy.mock.calls
        .map(([options]) => options as { status: string; summary: string })
        .filter((options) => options.summary.includes("RESUMED"));
      expect(notification.status).toBe("✅ completed");
    } finally {
      notificationSpy.mockRestore();
    }
  });
});
