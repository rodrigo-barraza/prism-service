import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import { COLLECTIONS, PROVIDERS } from "../src/constants.ts";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import SettingsService from "../src/services/SettingsService.ts";
import localModelQueue from "../src/services/LocalModelQueue.ts";
import { InstanceLoadBalancer } from "../src/services/orchestrator/InstanceLoadBalancer.ts";
import { existsSync } from "node:fs";

let mockExistsSyncResult: boolean | undefined = undefined;

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: (path: string) => {
      if (mockExistsSyncResult !== undefined) {
        return mockExistsSyncResult;
      }
      return original.existsSync(path);
    },
  };
});

const mockRunAgenticLoop = vi.fn().mockResolvedValue({
  messages: [{ role: "assistant", content: "Mock sub-agent output" }],
});

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

import AgenticLoopService from "../src/services/AgenticLoopService.ts";
import { runCleanupFunctions } from "../src/utils/CleanupRegistry.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";


// Mock the GitWorktreeHelper to avoid disk operations
vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    toolsApiPost: vi.fn().mockResolvedValue({}),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
    }),
    cleanupWorktrees: vi.fn().mockResolvedValue({}),
  },
}));

import type { OrchestratorContext } from "../src/types/orchestrator.ts";
import OrchestratorService, {
  MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION,
} from "../src/services/OrchestratorService.ts";
import AgentPersonaRegistry from "../src/services/AgentPersonaRegistry.ts";
import { afterEach } from "vitest";

async function waitForCondition(condition: () => boolean, timeoutMilliseconds = 2000): Promise<void> {
  const startTime = Date.now();
  while (!condition()) {
    if (Date.now() - startTime > timeoutMilliseconds) {
      throw new Error(`Timed out waiting for condition after ${timeoutMilliseconds}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const waitForAgentRegistration = (parentConversationId = "conv-id-789") =>
  waitForCondition(() => OrchestratorService.listSubAgents({ parentConversationId }).length > 0);

/**
 * Polls until the mock has been called at least `expectedCalls` times.
 * Used for non-blocking createTeam tests where background promises
 * resolve asynchronously.
 */
async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, expectedCalls: number, timeoutMs = 2000): Promise<void> {
  const startTime = Date.now();
  while (mock.mock.calls.length < expectedCalls) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timed out waiting for mock to be called ${expectedCalls} times (got ${mock.mock.calls.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let resolveDeferredPromise: ((value: any) => void) | undefined = undefined;

function cleanAllConversations() {
  OrchestratorService.cleanupConversation("session-id-456");
  OrchestratorService.cleanupConversation("session-root");
  OrchestratorService.cleanupConversation("root-conv");
  OrchestratorService.cleanupConversation("custom-parent-conv-abc");
  OrchestratorService.cleanupConversation("conv-id-789");
  for (let i = 0; i < MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION + 5; i++) {
    OrchestratorService.cleanupConversation(`session-id-456-${i}`);
    OrchestratorService.cleanupConversation(`session-id-cb-${i}`);
  }
}

describe("OrchestratorService Spawning & Agent Types", () => {
  let orchestratorContext: OrchestratorContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockResolvedValue({
      messages: [{ role: "assistant", content: "Mock sub-agent output" }],
    });
    AgenticLoopService.runAgenticLoop = mockRunAgenticLoop;

    vi.mocked(GitWorktreeHelper.createWorktree).mockReset();
    vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({ worktreePath: "/workspace/worktree-1" });

    vi.mocked(GitWorktreeHelper.removeWorktree).mockReset();
    vi.mocked(GitWorktreeHelper.removeWorktree).mockResolvedValue({});

    vi.mocked(GitWorktreeHelper.getWorktreeDiff).mockReset();
    vi.mocked(GitWorktreeHelper.getWorktreeDiff).mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
    });

    mockExistsSyncResult = undefined;
    resolveDeferredPromise = undefined;
    cleanAllConversations();
    OrchestratorService.clearAllActiveSubAgents();

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
      conversationId: "conv-id-789",
      enabledTools: ["read_file", "write_file", "search_web"],
      maxRecursionDepth: 2,
      emit: vi.fn(),
    };
  });

  afterEach(() => {
    cleanAllConversations();
    if (resolveDeferredPromise) {
      resolveDeferredPromise({ messages: [] });
      resolveDeferredPromise = undefined;
    }
    vi.restoreAllMocks();
  });

  it("should spawn sub-agent that inherits parent agent type and enabled tools by default", async () => {
    const result = await OrchestratorService.spawnFromTool({
      description: "Default spawn sub-agent",
      prompt: "Do default stuff",
      files: [],
      orchestratorContext,
      awaitCompletion: true,
    });

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();

    // Verify AgenticLoopService.runAgenticLoop was called with parent context details
    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArgs = mockRunAgenticLoop.mock.calls[0][0];

    // Inherited parent agent "CODING"
    expect(runArgs.agent).toBe("CODING");
    // Inherited parent enabledTools
    expect(runArgs.options.enabledTools).toEqual(["read_file", "write_file", "search_web"]);
  });

  it("should spawn sub-agent with custom agent type and its native tools when agent is specified", async () => {
    // LuposPersona is a registered built-in persona
    const luposPersona = AgentPersonaRegistry.get("LUPOS");
    expect(luposPersona).not.toBeNull();
    const luposTools = luposPersona!.availableTools;

    // Clear calls for this test to have predictable indices
    mockRunAgenticLoop.mockClear();

    const result = await OrchestratorService.spawnFromTool({
      description: "Custom Lupos sub-agent",
      prompt: "Do Lupos stuff",
      agent: "Lupos",
      files: [],
      orchestratorContext,
      awaitCompletion: true,
    });

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();

    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArgs = mockRunAgenticLoop.mock.calls[0][0]; // first call in this test

    // Sub-agent agent type is LUPOS
    expect(runArgs.agent).toBe("LUPOS");
    // Sub-agent tools are Lupos's availableTools, NOT inherited parent tools
    expect(runArgs.options.enabledTools).toEqual(luposTools);
  });

  it("should support custom agents specified via createTeam members", async () => {
    const luposPersona = AgentPersonaRegistry.get("LUPOS");
    expect(luposPersona).not.toBeNull();
    const luposTools = luposPersona!.availableTools;

    const teamArgs = {
      name: "custom_team",
      members: [
        {
          description: "Sub-agent 1 (default)",
          prompt: "Default prompt",
        },
        {
          description: "Sub-agent 2 (Lupos)",
          prompt: "Lupos prompt",
          agent: "Lupos",
        },
      ],
    };

    // Clear calls for this test to have predictable indices
    mockRunAgenticLoop.mockClear();

    const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
    await waitForMockCalls(mockRunAgenticLoop, 2);

    expect(results).toHaveLength(2);
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2);

    const call1Args = mockRunAgenticLoop.mock.calls[0][0];
    const call2Args = mockRunAgenticLoop.mock.calls[1][0];

    // First call (default) inherits parent agent & tools
    expect(call1Args.agent).toBe("CODING");
    expect(call1Args.options.enabledTools).toEqual(["read_file", "write_file", "search_web"]);

    // Second call uses overridden agent (LUPOS) and its tools
    expect(call2Args.agent).toBe("LUPOS");
    expect(call2Args.options.enabledTools).toEqual(luposTools);
  });

  it("should return an error when createTeam is called with an invalid topology", async () => {
    const teamArgs = {
      name: "invalid_topology_team",
      topology: "invalid_topology_mode",
      members: [
        {
          description: "Sub-agent 1",
          prompt: "Do something",
        },
      ],
    };

    const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
    expect(results).toHaveLength(1);
    expect("error" in results[0]).toBe(true);
    expect((results[0] as { error: string }).error).toContain("Invalid topology");
  });

  it("should return an error when createTeam is called with a missing or non-array members argument", async () => {
    // Missing members
    const teamArgsMissing = {
      name: "missing_members_team",
    } as any;

    const resultsMissing = await OrchestratorService.createTeam(teamArgsMissing, orchestratorContext);
    expect(resultsMissing).toHaveLength(1);
    expect("error" in resultsMissing[0]).toBe(true);
    expect((resultsMissing[0] as { error: string }).error).toContain("Invalid or missing 'members' array");

    // Non-array members
    const teamArgsNonArray = {
      name: "non_array_members_team",
      members: "not-an-array" as any,
    };

    const resultsNonArray = await OrchestratorService.createTeam(teamArgsNonArray, orchestratorContext);
    expect(resultsNonArray).toHaveLength(1);
    expect("error" in resultsNonArray[0]).toBe(true);
    expect((resultsNonArray[0] as { error: string }).error).toContain("Invalid or missing 'members' array");
  });

  it("should update session topology in MongoDB when createTeam is called with a specific topology override", async () => {
    const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
    const mockUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
    const mockFindOne = vi.fn().mockResolvedValue({ id: "conv-id-789", settings: {} });
    const mockCollection = {
      updateOne: mockUpdateOne,
      findOne: mockFindOne,
    };
    
    const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
      mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
    );

    const teamArgs = {
      name: "topology_override_team",
      topology: TOPOLOGIES.PEER_TO_PEER,
      members: [
        {
          description: "Sub-agent 1",
          prompt: "Do something",
        },
      ],
    };

    const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
    expect(results).toHaveLength(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        id: "conv-id-789",
        project: orchestratorContext.project,
        username: orchestratorContext.username,
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          "settings.agents.topology": TOPOLOGIES.PEER_TO_PEER,
        }),
      })
    );

    getCollectionSpy.mockRestore();
  });

  it("should not include workspace constraint when there are no workspaces currently set up", async () => {
    const getWorkspaceRootsSpy = vi.spyOn(ToolOrchestratorService, "getWorkspaceRoots").mockReturnValue([]);
    mockExistsSyncResult = undefined;

    await OrchestratorService.spawnFromTool({
      description: "Test sub-agent prompt without workspace setup",
      prompt: "Perform task",
      files: [],
      orchestratorContext,
      awaitCompletion: true,
    });

    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArguments = mockRunAgenticLoop.mock.calls[0][0];
    const userMessageContent = runArguments.messages[0].content;

    expect(userMessageContent).not.toContain("Only modify files within your workspace");

    getWorkspaceRootsSpy.mockRestore();
  });

  it("should not include workspace constraint when workspace is configured but not available on disk", async () => {
    const getWorkspaceRootsSpy = vi.spyOn(ToolOrchestratorService, "getWorkspaceRoots").mockReturnValue(["/nonexistent-workspace-path"]);
    mockExistsSyncResult = false;

    await OrchestratorService.spawnFromTool({
      description: "Test sub-agent prompt with unavailable workspace",
      prompt: "Perform task",
      files: [],
      orchestratorContext,
      awaitCompletion: true,
    });

    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArguments = mockRunAgenticLoop.mock.calls[0][0];
    const userMessageContent = runArguments.messages[0].content;

    expect(userMessageContent).not.toContain("Only modify files within your workspace");

    getWorkspaceRootsSpy.mockRestore();
  });

  it("should include workspace constraint when workspace is configured and available on disk", async () => {
    const getWorkspaceRootsSpy = vi.spyOn(ToolOrchestratorService, "getWorkspaceRoots").mockReturnValue(["/existing-workspace-path"]);
    mockExistsSyncResult = true;

    await OrchestratorService.spawnFromTool({
      description: "Test sub-agent prompt with available workspace",
      prompt: "Perform task",
      files: [],
      orchestratorContext,
      awaitCompletion: true,
    });

    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArguments = mockRunAgenticLoop.mock.calls[0][0];
    const userMessageContent = runArguments.messages[0].content;

    expect(userMessageContent).toContain("Only modify files within your workspace");

    getWorkspaceRootsSpy.mockRestore();
  });

  describe("hasSubAgents flag persistence", () => {
    it("should set hasSubAgents: true on the parent conversation when a sub-agent is spawned", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
      const mockCollection = { updateOne: mockUpdateOne };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      await OrchestratorService.spawnFromTool({
        description: "Sub-agent that triggers hasSubAgents",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(mockUpdateOne).toHaveBeenCalledWith(
        {
          id: orchestratorContext.conversationId,
          project: orchestratorContext.project,
          username: orchestratorContext.username,
        },
        { $set: { hasSubAgents: true } },
      );

      getCollectionSpy.mockRestore();
    });

    it("should target the correct parent conversation ID from orchestratorContext.conversationId", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
      const mockCollection = { updateOne: mockUpdateOne };

      const customContext = {
        ...orchestratorContext,
        conversationId: "custom-parent-conv-abc",
      };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      await OrchestratorService.spawnFromTool({
        description: "Sub-agent with custom parent",
        prompt: "Do work",
        files: [],
        awaitCompletion: true,
      orchestratorContext: customContext,
      });

      const hasSubAgentsCall = mockUpdateOne.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).id === "custom-parent-conv-abc" &&
          (call[1] as Record<string, unknown>).$set &&
          ((call[1] as Record<string, Record<string, unknown>>).$set as Record<string, unknown>).hasSubAgents === true,
      );
      expect(hasSubAgentsCall).toBeDefined();

      getCollectionSpy.mockRestore();
    });

    it("should use the AGENT_CONVERSATIONS collection for the hasSubAgents update", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
      const mockCollection = { updateOne: mockUpdateOne };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      await OrchestratorService.spawnFromTool({
        description: "Sub-agent collection check",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      const collectionCalls = getCollectionSpy.mock.calls;
      const agentConversationsCall = collectionCalls.find(
        (call: unknown[]) => (call[1] as string) === COLLECTIONS.AGENT_CONVERSATIONS,
      );
      expect(agentConversationsCall).toBeDefined();

      getCollectionSpy.mockRestore();
    });

    it("should not throw when MongoDB is unavailable for hasSubAgents update", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        null as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      const result = await OrchestratorService.spawnFromTool({
        description: "Sub-agent with null collection",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();

      getCollectionSpy.mockRestore();
    });

    it("should not throw when the MongoDB updateOne rejects for hasSubAgents", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockRejectedValue(new Error("MongoDB connection lost"));
      const mockCollection = { updateOne: mockUpdateOne };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      const result = await OrchestratorService.spawnFromTool({
        description: "Sub-agent with failing DB",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();

      getCollectionSpy.mockRestore();
    });

    it("should set hasSubAgents on parent conversation for each sub-agent spawned via createTeam", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
      const mockCollection = { updateOne: mockUpdateOne };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
        mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      const teamArgs = {
        name: "has_sub_agents_team",
        members: [
          { description: "Agent A", prompt: "Do task A" },
          { description: "Agent B", prompt: "Do task B" },
        ],
      };

      await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      await waitForMockCalls(mockRunAgenticLoop, 2);

      const hasSubAgentsCalls = mockUpdateOne.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).id === orchestratorContext.conversationId &&
          (call[1] as Record<string, unknown>).$set &&
          ((call[1] as Record<string, Record<string, unknown>>).$set as Record<string, unknown>).hasSubAgents === true,
      );
      expect(hasSubAgentsCalls.length).toBeGreaterThanOrEqual(1);

      getCollectionSpy.mockRestore();
    });
  });

  describe("Peer-to-Peer Router 0-Based Agent Naming", () => {
    it("should use 0-based speaker names and correctly tag shared discussion entries", async () => {
      mockRunAgenticLoop.mockClear();

      mockRunAgenticLoop
        .mockResolvedValueOnce({
          messages: [{ role: "assistant", content: "Agent 0 output" }],
        })
        .mockResolvedValueOnce({
          messages: [{ role: "assistant", content: "Agent 1 output [DONE]" }],
        });

      const teamArgs = {
        name: "peer_to_peer_0based_team",
        topology: TOPOLOGIES.PEER_TO_PEER,
        members: [
          {
            description: "First Sub-agent",
            prompt: "Research Pac-Man gameplay mechanics",
          },
          {
            description: "Second Sub-agent",
            prompt: "Research Pac-Man historical feats",
          },
        ],
      };

      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      await waitForMockCalls(mockRunAgenticLoop, 2);
      expect(results).toHaveLength(2);

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2);

      const firstAgentCallArgs = mockRunAgenticLoop.mock.calls[0][0];
      const secondAgentCallArgs = mockRunAgenticLoop.mock.calls[1][0];

      const firstAgentUserMessage = firstAgentCallArgs.messages[1].content;
      const secondAgentUserMessage = secondAgentCallArgs.messages[1].content;

      // The first agent (agent-0) should see its task and identity
      expect(firstAgentUserMessage).toContain("Research Pac-Man gameplay mechanics");
      expect(firstAgentUserMessage).toContain("agent-0");

      // The second agent (agent-1) should see shared discussion with [agent-0] tag
      expect(secondAgentUserMessage).toContain("--- SHARED DISCUSSION BOARD ---");
      expect(secondAgentUserMessage).toContain("[agent-0]: Agent 0 output");
      expect(secondAgentUserMessage).toContain("--- YOUR TASK (agent-1) ---");
      expect(secondAgentUserMessage).toContain("Research Pac-Man historical feats");
    });
  });

  describe("spawnFromTool Spawning & Worktree Integration", () => {
    it("should spawn a sub-agent with correct AgenticLoopService params", async () => {
      const result = await OrchestratorService.spawnFromTool({
        description: "Verify loop parameters",
        prompt: "Run task",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(mockRunAgenticLoop).toHaveBeenCalled();
      
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.providerName).toBe(orchestratorContext.providerName);
      expect(lastCall.resolvedModel).toBe(orchestratorContext.resolvedModel);
      expect(lastCall.agentConversationId).toBeDefined();
      expect(lastCall.options.maxIterations).toBe(15);
    });

    it("should create git worktree for isolated execution when workspaceRoot is provided", async () => {
      const contextWithWorkspace = {
        ...orchestratorContext,
        workspaceRoot: "/path/to/repo",
      };

      vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({
        worktreePath: "/path/to/repo/worktree-abc123"
      });

      await OrchestratorService.spawnFromTool({
        description: "Verify worktree creation",
        prompt: "Run task",
        files: ["/path/to/repo/file.ts"],
        awaitCompletion: true,
      orchestratorContext: contextWithWorkspace,
      });

      expect(GitWorktreeHelper.createWorktree).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.workspaceRoot).toBe("/path/to/repo/worktree-abc123");
    });

    it("should collect diff from worktree on completion", async () => {
      const contextWithWorkspace = {
        ...orchestratorContext,
        workspaceRoot: "/path/to/repo",
      };

      vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({
        worktreePath: "/path/to/repo/worktree-abc123"
      });
      vi.mocked(GitWorktreeHelper.getWorktreeDiff).mockResolvedValue({
        hasChanges: true,
        additions: 10,
        deletions: 2,
        files: ["file.ts"],
      });

      const result = await OrchestratorService.spawnFromTool({
        description: "Verify diff collection",
        prompt: "Run task",
        files: ["/path/to/repo/file.ts"],
        awaitCompletion: true,
      orchestratorContext: contextWithWorkspace,
      });

      expect(GitWorktreeHelper.getWorktreeDiff).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect("diff" in result).toBe(true);
      expect((result as any).diff).toEqual({
        additions: 10,
        deletions: 2,
        files: ["file.ts"],
      });
    });

    it("should clean up worktree after completion", async () => {
      const contextWithWorkspace = {
        ...orchestratorContext,
        workspaceRoot: "/path/to/repo",
      };

      vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({
        worktreePath: "/path/to/repo/worktree-abc123"
      });

      await OrchestratorService.spawnFromTool({
        description: "Verify worktree cleanup",
        prompt: "Run task",
        files: ["/path/to/repo/file.ts"],
        awaitCompletion: true,
      orchestratorContext: contextWithWorkspace,
      });

      expect(GitWorktreeHelper.removeWorktree).toHaveBeenCalledWith("/workspace", "/path/to/repo/worktree-abc123");
    });

    it("should preserve worktree when preserveWorktree flag is set", async () => {
      const contextWithWorkspace = {
        ...orchestratorContext,
        workspaceRoot: "/path/to/repo",
      };

      vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({
        worktreePath: "/path/to/repo/worktree-abc123"
      });

      await OrchestratorService.spawnFromTool({
        description: "Verify worktree preservation",
        prompt: "Run task",
        files: ["/path/to/repo/file.ts"],
        awaitCompletion: true,
      orchestratorContext: contextWithWorkspace,
        preserveWorktree: true,
      });

      expect(GitWorktreeHelper.removeWorktree).not.toHaveBeenCalled();
    });

    it("should enforce MAX_SUB_AGENTS limit", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const runningPromises: Promise<any>[] = [];
      let resolveLoop: any;
      const deferredPromise = new Promise((resolve) => {
        resolveLoop = resolve;
      });

      mockRunAgenticLoop.mockReturnValue(deferredPromise);

      for (let i = 0; i < 10; i++) {
        runningPromises.push(
          OrchestratorService.spawnFromTool({
            description: `Agent ${i}`,
            prompt: "Do work",
            files: [],
            awaitCompletion: true,
      orchestratorContext: {
              ...orchestratorContext,
      awaitCompletion: true,
              agentConversationId: `session-id-456-${i}`,
              conversationId: `conv-id-789-${i}`,
            },
          })
        );
        // Wait for the agent to progress and register in activeSubAgents
        await waitForCondition(() => OrchestratorService.listSubAgents().length === i + 1);
      }

      const result11 = await OrchestratorService.spawnFromTool({
        description: "Agent 11",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result11).toBeDefined();
      expect("error" in result11).toBe(true);
      expect((result11 as any).error).toContain("Maximum concurrent sub-agents");

      resolveLoop({ messages: [] });
      await Promise.all(runningPromises);

      for (let i = 0; i < 10; i++) {
        OrchestratorService.cleanupConversation(`session-id-456-${i}`);
      }
      mockRunAgenticLoop.mockResolvedValue({
        messages: [{ role: "assistant", content: "Mock sub-agent output" }],
      });
    });

    it("should assign sequential agent IDs per conversation", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const res1 = await OrchestratorService.spawnFromTool({
        description: "Seq 1",
        prompt: "Prompt 1",
        orchestratorContext,
      awaitCompletion: true,
      });
      const res2 = await OrchestratorService.spawnFromTool({
        description: "Seq 2",
        prompt: "Prompt 2",
        orchestratorContext,
      awaitCompletion: true,
      });
      const res3 = await OrchestratorService.spawnFromTool({
        description: "Seq 3",
        prompt: "Prompt 3",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(res1).toBeDefined();
      expect((res1 as any).agent_id).toContain("agent-1-");
      expect(res2).toBeDefined();
      expect((res2 as any).agent_id).toContain("agent-2-");
      expect(res3).toBeDefined();
      expect((res3 as any).agent_id).toContain("agent-3-");
    });
  });

  describe("Recursion Depth Tracking", () => {
    it("should reject spawn when maxRecursionDepth is 0", async () => {
      const contextWithZeroDepth = {
        ...orchestratorContext,
        maxRecursionDepth: 0,
      };

      const result = await OrchestratorService.spawnFromTool({
        description: "Depth 0 test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: contextWithZeroDepth,
      });

      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("recursion depth is set to 0");
    });

    it("should reject spawn when current depth matches/exceeds max", async () => {
      const contextWithExceededDepth = {
        ...orchestratorContext,
        recursionDepth: 2,
        maxRecursionDepth: 2,
      };

      const result = await OrchestratorService.spawnFromTool({
        description: "Exceeded depth test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: contextWithExceededDepth,
      });

      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("spawning limit reached");
    });

    it("should apply scope attenuation factor to maxIterations", async () => {
      const contextWithAttenuation = {
        ...orchestratorContext,
        recursionDepth: 1,
        maxRecursionDepth: 3,
        maxSubAgentIterations: 15,
      };

      await OrchestratorService.spawnFromTool({
        description: "Attenuation test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: contextWithAttenuation,
      });

      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.options.maxIterations).toBe(9);
    });

    it("should pass incremented recursionDepth to child runAgenticLoop", async () => {
      const context = {
        ...orchestratorContext,
        recursionDepth: 1,
        maxRecursionDepth: 3,
      };

      await OrchestratorService.spawnFromTool({
        description: "Depth increment test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: context,
      });

      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall._recursionDepth).toBe(2);
    });
  });

  describe("Circuit Breaker - Concurrent Agents Limit Per Conversation", () => {
    it("should reject spawn when total concurrent agents per conversation exceeds limit", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const parentConversationId = "conv-id-789";
      
      for (let i = 0; i < MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION; i++) {
        await OrchestratorService.spawnFromTool({
          description: `CB Agent ${i}`,
          prompt: "Do work",
          awaitCompletion: true,
      orchestratorContext: {
            ...orchestratorContext,
      awaitCompletion: true,
            agentConversationId: `session-id-cb-${i}`,
            conversationId: parentConversationId,
          },
        });
      }

      const resultExceeded = await OrchestratorService.spawnFromTool({
        description: `CB Agent ${MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION}`,
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: {
          ...orchestratorContext,
      awaitCompletion: true,
          agentConversationId: `session-id-cb-${MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION}`,
          conversationId: parentConversationId,
        },
      });

      expect(resultExceeded).toBeDefined();
      expect("error" in resultExceeded).toBe(true);
      expect((resultExceeded as any).error).toContain("Circuit breaker: maximum concurrent agents per conversation");
    });
  });

  describe("Messaging & Sub-Agent Continuation", () => {
    it("should deliver message to active running sub-agent", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Running agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      const activeAgents = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      const agentId = activeAgents[0].agentId;

      const result = await OrchestratorService.sendMessage(agentId, "continue instruction", orchestratorContext);
      expect(result).toBeDefined();
      expect((result as any).status).toBe("message_queued");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should return error when message is sent to non-existent agent", async () => {
      const result = await OrchestratorService.sendMessage("non-existent-agent", "hello", orchestratorContext);
      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("not found");
    });

    it("should return error when agent is in a non-completable state", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const spawnResult = await OrchestratorService.spawnFromTool({
        description: "Completed agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });
      const agentId = (spawnResult as any).agent_id;

      await OrchestratorService.stopAgent(agentId);

      const sendMessageResult = await OrchestratorService.sendMessage(agentId, "continue instruction", orchestratorContext);
      expect(sendMessageResult).toBeDefined();
      expect("error" in sendMessageResult).toBe(true);
      expect((sendMessageResult as any).error).toContain("is in \"stopped\" state. Cannot send message");
    });

    it("should statefully continue a completed agent using continueAgent", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const spawnResult = await OrchestratorService.spawnFromTool({
        description: "Completish agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });
      const agentId = (spawnResult as any).agent_id;

      const continueResult = await OrchestratorService.continueAgent(agentId, "New task instruction", orchestratorContext, 2);
      expect(continueResult).toBeDefined();
      expect("error" in continueResult).toBe(false);
      expect((continueResult as any).status).toBe("completed");
      expect((continueResult as any).iterations).toBeDefined();
    });
  });

  describe("Stop Agent", () => {
    it("should abort running sub-agent and clean up worktree", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "To be stopped",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      const activeAgents = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      const agentId = activeAgents[0].agentId;

      vi.mocked(GitWorktreeHelper.removeWorktree).mockResolvedValue({});

      const stopResult = await OrchestratorService.stopAgent(agentId);
      expect(stopResult).toBeDefined();
      expect((stopResult as any).status).toBe("stopped");

      const statusResult = OrchestratorService.getSubAgentStatus(agentId);
      expect(statusResult?.status).toBe("stopped");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should return error when stopping a non-existent agent", async () => {
      const result = await OrchestratorService.stopAgent("non-existent-agent");
      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("not found");
    });
  });

  describe("List Status / Output / Delete Team", () => {
    it("should return output for a specific completed agent", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      mockRunAgenticLoop.mockResolvedValueOnce({
        messages: [{ role: "assistant", content: "Final task output text summary here" }],
      });

      const spawnResult = await OrchestratorService.spawnFromTool({
        description: "Output agent",
        prompt: "Do something",
        orchestratorContext,
      awaitCompletion: true,
      });
      const agentId = (spawnResult as any).agent_id;

      const output = OrchestratorService.getTaskOutput(agentId);
      expect(output).toBeDefined();
      expect((output as any).result).toBe("Final task output text summary here");
    });

    it("should return running status for a running agent", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Running output agent",
        prompt: "Do something",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      const activeAgents = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      const agentId = activeAgents[0].agentId;

      const output = OrchestratorService.getTaskOutput(agentId);
      expect(output).toBeDefined();
      expect((output as any).status).toBe("running");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should delete team and stop running agents", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Team agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      vi.mocked(GitWorktreeHelper.removeWorktree).mockResolvedValue({});

      const deleteResult = await OrchestratorService.deleteTeam("test_team", orchestratorContext);
      expect(deleteResult).toBeDefined();
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.subAgentsAborted).toBe(1);

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });
  });

  describe("Parent Chain Root Conversation Resolving", () => {
    it("should walk the parent chain to find the root conversation ID", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const originalRandomUUID = globalThis.crypto.randomUUID;
      let uuidCount = 0;
      globalThis.crypto.randomUUID = (() => {
        uuidCount++;
        return `${uuidCount}-uuid-val-${uuidCount}`;
      }) as any;

      try {
        const resA = await OrchestratorService.spawnFromTool({
          description: "Agent A",
          prompt: "Prompt A",
          awaitCompletion: true,
      orchestratorContext: {
            ...orchestratorContext,
      awaitCompletion: true,
            conversationId: "root-conv",
            agentConversationId: "session-root",
          },
        });

        const agentAId = (resA as any).agent_id;
        const descendantList = OrchestratorService.listAllDescendantSubAgents("root-conv");
        console.log("DESCENDANTS 1:", descendantList);
        console.log("ALL SUB AGENTS:", OrchestratorService.listSubAgents());
        const agentAState = descendantList.find(a => a.agentId === agentAId);
        expect(agentAState).toBeDefined();

        const resB = await OrchestratorService.spawnFromTool({
          description: "Agent B",
          prompt: "Prompt B",
          awaitCompletion: true,
      orchestratorContext: {
            ...orchestratorContext,
      awaitCompletion: true,
            conversationId: "2-uuid-val-2",
            agentConversationId: agentAId,
          },
        });

        const agentBId = (resB as any).agent_id;
        const descendantList2 = OrchestratorService.listAllDescendantSubAgents("root-conv");
        console.log("DESCENDANTS 2:", descendantList2);
        expect(descendantList2.length).toBe(2);
        expect(descendantList2.map(a => a.agentId)).toContain(agentAId);
        expect(descendantList2.map(a => a.agentId)).toContain(agentBId);
      } finally {
        globalThis.crypto.randomUUID = originalRandomUUID;
      }
    });
  });

  describe("Shutdown Cleanup", () => {
    it("should abort all running agents on shutdown", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Cleanup agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      vi.mocked(GitWorktreeHelper.removeWorktree).mockResolvedValue({});

      await runCleanupFunctions();

      const list = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      expect(list[0].status).toBe("stopped");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should handle worktree cleanup failure gracefully", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Failing cleanup agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      vi.mocked(GitWorktreeHelper.removeWorktree).mockRejectedValue(new Error("Git command failed"));

      await expect(runCleanupFunctions()).resolves.not.toThrow();

      const list = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      expect(list[0].status).toBe("stopped");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });
  });

  describe("OrchestratorService Edge Cases & Local Providers", () => {
    it("should fallback to sub-agent settings when all instances are at capacity", async () => {
      const getSectionSpy = vi.spyOn(SettingsService, "getSection").mockResolvedValue({
        subAgentProvider: "google",
        subAgentModel: "gemini-3-flash-preview",
      });
      const isLocalSpy = vi.spyOn(localModelQueue, "isLocal").mockReturnValue(true);
      const selectAndReserveSpy = vi.spyOn(InstanceLoadBalancer, "selectAndReserveInstance").mockReturnValue(null);

      await OrchestratorService.spawnFromTool({
        description: "Fallback test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: {
          ...orchestratorContext,
      awaitCompletion: true,
          providerName: "google",
        },
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.providerName).toBe("google");
      expect(lastCall.resolvedModel).toBe("gemini-3-flash-preview");

      getSectionSpy.mockRestore();
      isLocalSpy.mockRestore();
      selectAndReserveSpy.mockRestore();
    });

    it("should fallback to local queue if no fallback settings are configured", async () => {
      const getSectionSpy = vi.spyOn(SettingsService, "getSection").mockResolvedValue(null);
      const isLocalSpy = vi.spyOn(localModelQueue, "isLocal").mockReturnValue(true);
      const selectAndReserveSpy = vi.spyOn(InstanceLoadBalancer, "selectAndReserveInstance").mockReturnValue(null);

      await OrchestratorService.spawnFromTool({
        description: "Queue fallback test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: {
          ...orchestratorContext,
      awaitCompletion: true,
          providerName: "google",
        },
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.providerName).toBe("google");

      getSectionSpy.mockRestore();
      isLocalSpy.mockRestore();
      selectAndReserveSpy.mockRestore();
    });

    it("should trigger fallback catch block on settings service error", async () => {
      const getSectionSpy = vi.spyOn(SettingsService, "getSection").mockRejectedValue(new Error("Settings failed"));
      const isLocalSpy = vi.spyOn(localModelQueue, "isLocal").mockReturnValue(true);
      const selectAndReserveSpy = vi.spyOn(InstanceLoadBalancer, "selectAndReserveInstance").mockReturnValue(null);

      await OrchestratorService.spawnFromTool({
        description: "Error fallback test",
        prompt: "Do work",
        awaitCompletion: true,
      orchestratorContext: {
          ...orchestratorContext,
      awaitCompletion: true,
          providerName: "google",
        },
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.providerName).toBe("google");

      getSectionSpy.mockRestore();
      isLocalSpy.mockRestore();
      selectAndReserveSpy.mockRestore();
    });

    it("should abort sub-agents by conversation", async () => {
      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "To abort",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      const activeAgentsBefore = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      expect(activeAgentsBefore.length).toBe(1);

      await OrchestratorService.abortSubAgentsByConversation("conv-id-789");
      
      const activeAgentsAfter = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      expect(activeAgentsAfter[0].status).toBe("stopped");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should cleanup session as a wrapper for cleanupConversation", () => {
      const spy = vi.spyOn(OrchestratorService, "cleanupConversation");
      OrchestratorService.cleanupSession("some-conv-id");
      expect(spy).toHaveBeenCalledWith("some-conv-id");
      spy.mockRestore();
    });

    it("should return error for continueAgent with non-existent agent", async () => {
      const result = await OrchestratorService.continueAgent("non-existent", "hello", orchestratorContext);
      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("not found for continuation");
    });

    it("should return error for continueAgent with non-idle/complete agent", async () => {
      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Running to continue",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      const activeAgents = OrchestratorService.listSubAgents({ parentConversationId: "conv-id-789" });
      const agentId = activeAgents[0].agentId;

      const result = await OrchestratorService.continueAgent(agentId, "hello", orchestratorContext);
      expect(result).toBeDefined();
      expect("error" in result).toBe(true);
      expect((result as any).error).toContain("is in \"running\" state and cannot be continued");

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });

    it("should handle error in continueAgent runAgenticLoop gracefully", async () => {
      const spawnResult = await OrchestratorService.spawnFromTool({
        description: "Failing continuation agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });
      const agentId = (spawnResult as any).agent_id;

      mockRunAgenticLoop.mockRejectedValueOnce(new Error("Continuation execution failed"));

      const result = await OrchestratorService.continueAgent(agentId, "hello", orchestratorContext);
      expect(result).toBeDefined();
      expect((result as any).status).toBe("failed");
      expect((result as any).error).toContain("Continuation execution failed");
    });

    it("should set workspaceRoot to parent workspace root when worktree creation fails", async () => {
      vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValueOnce({
        error: "Worktree failed to initialize"
      });
      vi.mocked(GitWorktreeHelper.getDefaultWorkspaceRoot).mockReturnValueOnce("/parent/workspace/root");

      const contextWithWorkspace = {
        ...orchestratorContext,
        workspaceRoot: "/parent/workspace/root",
      };

      await OrchestratorService.spawnFromTool({
        description: "Failed worktree agent",
        prompt: "Run task",
        files: ["/parent/workspace/root/file.ts"],
        awaitCompletion: true,
      orchestratorContext: contextWithWorkspace,
      });

      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.workspaceRoot).toBe("/parent/workspace/root");
    });

    it("should warn and fallback when specified agent type is not found in registry", async () => {
      await OrchestratorService.spawnFromTool({
        description: "Non-existent persona agent",
        prompt: "Do work",
        agent: "NON_EXISTENT_PERSONA_ABC",
        orchestratorContext,
      awaitCompletion: true,
      });

      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.agent).toBe("CODING");
    });

    it("should warn when hasSubAgents write matched 0 documents in MongoDB", async () => {
      const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
      const mockUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 0 });
      const mockCollection = { updateOne: mockUpdateOne };

      const getCollectionSpy = vi.spyOn(MongoWrapper, "getCollection").mockReturnValue(
         mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>
      );

      await OrchestratorService.spawnFromTool({
        description: "Sub-agent zero matched docs",
        prompt: "Do work",
        files: [],
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(mockUpdateOne).toHaveBeenCalled();
      getCollectionSpy.mockRestore();
    });

    it("should handle error in spawnFromTool runAgenticLoop gracefully", async () => {
      mockRunAgenticLoop.mockRejectedValueOnce(new Error("Agentic loop initialization failed"));

      const result = await OrchestratorService.spawnFromTool({
        description: "Failed loop agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result).toBeDefined();
      expect((result as any).status).toBe("failed");
      expect((result as any).error).toContain("Agentic loop initialization failed");
    });

    it("should return false in existsSync check inside _runSubAgentLoop on error", async () => {
      const getWorkspaceRootsSpy = vi.spyOn(ToolOrchestratorService, "getWorkspaceRoots").mockReturnValue(["/some-workspace-path"]);
      
      const fs = await import("node:fs");
      const existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation(() => {
        throw new Error("Disk read error");
      });

      await OrchestratorService.spawnFromTool({
        description: "Filesystem error agent",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      expect(lastCall.messages[0].content).not.toContain("Only modify files within your workspace");

      getWorkspaceRootsSpy.mockRestore();
      existsSyncSpy.mockRestore();
    });

    it("should validate member prompt existence in createTeam", async () => {
      const teamArgs = {
        name: "empty_prompt_team",
        members: [
          {
            description: "Agent without prompt",
            prompt: "",
          },
        ],
      };

      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      expect(results).toHaveLength(1);
      expect("error" in results[0]).toBe(true);
      expect((results[0] as { error: string }).error).toContain("missing or empty prompts");
    });

    it("should return spawning disabled error in createTeam when maxRecursionDepth is 0", async () => {
      const teamArgs = {
        name: "disabled_spawning_team",
        members: [
          {
            description: "Sub-agent 1",
            prompt: "Do work",
          },
        ],
      };

      const contextWithZeroDepth = {
        ...orchestratorContext,
        maxRecursionDepth: 0,
      };

      const results = await OrchestratorService.createTeam(teamArgs, contextWithZeroDepth);
      expect(results).toHaveLength(1);
      expect("error" in results[0]).toBe(true);
      expect((results[0] as { error: string }).error).toContain("spawning is disabled");
    });

    it("should fallback to settings or default recursion depth when maxRecursionDepth is not defined in context", async () => {
      const getSectionSpy = vi.spyOn(SettingsService, "getSection").mockResolvedValue({
        maxRecursionDepth: 3,
      });

      const teamArgs = {
        name: "default_depth_team",
        members: [
          {
            description: "Sub-agent 1",
            prompt: "Do work",
          },
        ],
      };

      const contextWithoutDepth = {
        ...orchestratorContext,
        maxRecursionDepth: undefined,
      };

      await OrchestratorService.createTeam(teamArgs, contextWithoutDepth);
      await waitForMockCalls(mockRunAgenticLoop, 1);
      expect(mockRunAgenticLoop).toHaveBeenCalled();

      getSectionSpy.mockRestore();
    });

    it("should fail to get provider when provider name is invalid inside _runSubAgentLoop", async () => {
      const invalidContext = {
        ...orchestratorContext,
        providerName: "completely-invalid-provider",
      };

      const result = await OrchestratorService.spawnFromTool({
        description: "Invalid provider agent",
        prompt: "Prompt",
        awaitCompletion: true,
      orchestratorContext: invalidContext,
      });

      expect(result).toBeDefined();
      expect((result as any).status).toBe("failed");
      expect((result as any).error).toContain("Unknown provider");
    });

    it("should filter out orchestrator only tools when canSpawnRecursively is false", async () => {
      const contextAtMaxDepth = {
        ...orchestratorContext,
        recursionDepth: 1,
        maxRecursionDepth: 2,
      };

      await OrchestratorService.spawnFromTool({
        description: "Max recursion depth agent",
        prompt: "Prompt",
        awaitCompletion: true,
      orchestratorContext: contextAtMaxDepth,
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      const tools = lastCall.options.enabledTools;
      expect(tools).not.toContain("create_team");
      expect(tools).not.toContain("send_message");
      expect(tools).not.toContain("stop_agent");
    });

    it("should filter out orchestrator only tools from all tool schemas when enabledTools is not provided and canSpawnRecursively is false", async () => {
      const contextAtMaxDepth = {
        ...orchestratorContext,
        recursionDepth: 1,
        maxRecursionDepth: 2,
        enabledTools: undefined,
      };

      await OrchestratorService.spawnFromTool({
        description: "Max recursion depth schema tools agent",
        prompt: "Prompt",
        awaitCompletion: true,
      orchestratorContext: contextAtMaxDepth,
      });

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const lastCall = mockRunAgenticLoop.mock.calls[mockRunAgenticLoop.mock.calls.length - 1][0];
      const tools = lastCall.options.enabledTools;
      expect(tools).toBeDefined();
      expect(tools).not.toContain("create_team");
    });

    it("should continue complete/idle sub-agent on sendMessage", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const spawnResult = await OrchestratorService.spawnFromTool({
        description: "Spawning complete agent",
        prompt: "Do task",
        orchestratorContext,
      awaitCompletion: true,
      });
      const agentId = (spawnResult as any).agent_id;

      const messageResult = await OrchestratorService.sendMessage(agentId, "Continue work", orchestratorContext);
      expect(messageResult).toBeDefined();
      expect((messageResult as any).status).toBe("running");
    });

    it("should support createTeam with other topologies", async () => {
      const teamArgs = {
        name: "sequential_team",
        topology: "sequential",
        members: [
          { description: "Agent A", prompt: "Do A" },
        ],
      };

      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      expect(results).toHaveLength(1);
    });

    it("should warn on deleteTeam worktree cleanup failure", async () => {
      OrchestratorService.cleanupConversation("session-id-456");

      const deferredPromise = new Promise((resolve) => {
        resolveDeferredPromise = resolve;
      });
      mockRunAgenticLoop.mockReturnValueOnce(deferredPromise);

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Failing worktree delete",
        prompt: "Prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      await waitForAgentRegistration();

      vi.mocked(GitWorktreeHelper.removeWorktree).mockRejectedValueOnce(new Error("Cleanup failed"));

      const deleteResult = await OrchestratorService.deleteTeam("test_team", orchestratorContext);
      expect(deleteResult).toBeDefined();
      expect(deleteResult.deleted).toBe(true);

      if (resolveDeferredPromise) {
        resolveDeferredPromise({ messages: [] });
        resolveDeferredPromise = undefined;
      }
      await spawnPromise;
    });
  });
});

