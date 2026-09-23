/**
 * Prompt 22, Landing 3 — capability narrowing for sub-agents.
 *
 * A spawn declares what the sub-agent runs without (`capabilities:
 * { network: false }`); the REAL orchestrator (createTeam → router →
 * spawnFromTool → _runSubAgentLoop) carries it, with every ancestor's
 * narrowing, into the child's loop options, keeps it on the agent for a
 * resume, and persists it. Enforcement inside the child's loop is
 * capabilityScopeInTheLoop.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "#src/constants";

const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// Not a git workspace: sub-agents run in the shared workspace (no merge-back).
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
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import { SubAgentPersistenceService } from "#src/services/orchestrator/SubAgentPersistenceService";
import { UntrustedSpans } from "#src/services/permissions/UntrustedSpans";
import type { OrchestratorContext, SubAgentResult } from "#src/types/orchestrator";

const CONVERSATION = "conv-scope";

function context(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
    traceId: "trace-scope",
    agentConversationId: "session-scope",
    conversationId: CONVERSATION,
    workspaceRoot: "/workspace",
    emit: vi.fn(),
    // Depth 1 = blocking dispatch: the child's loop has run when createTeam returns.
    recursionDepth: 1,
    maxRecursionDepth: 3,
    ...overrides,
  };
}

function childOptions(call = 0): Record<string, unknown> {
  return mockRunAgenticLoop.mock.calls[call][0].options;
}

beforeEach(() => {
  OrchestratorService.cleanupConversation("session-scope");
  OrchestratorService.clearAllActiveSubAgents();
  mockRunAgenticLoop.mockReset();
  mockRunAgenticLoop.mockResolvedValue({ messages: [{ role: "assistant", content: "Summarized." }] });
});

describe("a sub-agent spawned with a capability set", () => {
  it("network: false reaches the child's loop as its scope, is kept on the agent and persisted", async () => {
    const register = vi.spyOn(SubAgentPersistenceService, "registerSubAgent");
    const results = (await OrchestratorService.createTeam(
      {
        name: "summarize",
        members: [{ description: "Summarize the text", prompt: "Summarize the text below." }],
        capabilities: { network: false },
      },
      context(),
    )) as SubAgentResult[];

    expect(results[0]).not.toHaveProperty("error");
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
    expect(childOptions()._capabilityScope).toEqual({ denied: ["network"] });
    const [agent] = [...OrchestratorService._getActiveSubAgents().values()];
    expect(agent.capabilityScope).toEqual({ denied: ["network"] });
    expect(register.mock.calls[0][0].capabilityScope).toEqual({ denied: ["network"] });
    register.mockRestore();
  });

  it("keeps every restriction of its parent, and a resume stays inside both", async () => {
    await OrchestratorService.createTeam(
      {
        name: "nested",
        members: [{ description: "Look it up", prompt: "Look it up." }],
        capabilities: { network: false, shell: true },
      },
      context({ capabilityScope: { denied: ["shell"] } }),
    );
    expect(childOptions(0)._capabilityScope).toEqual({ denied: ["shell", "network"] });

    const [agent] = [...OrchestratorService._getActiveSubAgents().values()];
    await OrchestratorService.resumeAgent(agent.agentId, "Now one more thing.", context());
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2);
    expect(childOptions(1)._capabilityScope).toEqual({ denied: ["shell", "network"] });
  });

  it("a misspelled capability refuses the spawn instead of running it unrestricted", async () => {
    const results = await OrchestratorService.createTeam(
      {
        name: "typo",
        members: [{ description: "x", prompt: "x" }],
        capabilities: { netwrok: false },
      },
      context(),
    );
    expect(results).toEqual([{ error: expect.stringContaining('unknown capability "netwrok"') }]);
    expect(mockRunAgenticLoop).not.toHaveBeenCalled();
  });

  it("create_subagent takes `capabilities` and the parent's untrusted text reaches the child", async () => {
    const parentSpans = new UntrustedSpans();
    parentSpans.add("A page the parent read, long enough to be a span.", "read_web_page https://p.test");
    await ToolOrchestratorService.executeOrchestratorTool(
      "create_subagent",
      { description: "Check it", prompt: "Check it.", capabilities: { network_write: false } },
      {
        project: "test-project",
        username: "test-user",
        agent: "CODING",
        _providerName: PROVIDERS.GOOGLE,
        _resolvedModel: "gemini-3-flash-preview",
        agentConversationId: "session-scope",
        conversationId: CONVERSATION,
        workspaceRoot: "/workspace",
        _emit: vi.fn(),
        _recursionDepth: 1,
        _maxRecursionDepth: 3,
        _untrustedSpans: parentSpans,
      } as never,
    );
    expect(childOptions()._capabilityScope).toEqual({ denied: ["network_write"] });
    expect(childOptions()._untrustedSpans).toBe(parentSpans);
  });

  it("the spawn tools declare the parameter, closed to unknown names", () => {
    const schemas = ToolOrchestratorService.getToolSchemas() as Array<{ name: string; parameters: { properties: Record<string, any> } }>;
    for (const name of ["create_subagent", "create_subagents"]) {
      const capabilities = schemas.find((schema) => schema.name === name)?.parameters.properties.capabilities;
      expect(capabilities, name).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys(capabilities.properties)).toContain("network_write");
    }
  });
});
