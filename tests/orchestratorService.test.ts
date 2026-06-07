import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";

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


// Mock the GitWorktreeHelper to avoid disk operations
vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
    }),
  },
}));

import type { OrchestratorContext } from "../src/types/orchestrator.ts";
import OrchestratorService from "../src/services/OrchestratorService.ts";
import AgentPersonaRegistry from "../src/services/AgentPersonaRegistry.ts";


describe("OrchestratorService Spawning & Agent Types", () => {
  let orchestratorContext: OrchestratorContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRunAgenticLoop.mockClear();
    AgenticLoopService.runAgenticLoop = mockRunAgenticLoop;
    mockExistsSyncResult = undefined;

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: "google",
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-123",
      agentSessionId: "session-id-456",
      conversationId: "conv-id-789",
      enabledTools: ["read_file", "write_file", "search_web"],
      emit: vi.fn(),
    };
  });

  it("should spawn sub-agent that inherits parent agent type and enabled tools by default", async () => {
    const result = await OrchestratorService.spawnFromTool({
      description: "Default spawn sub-agent",
      prompt: "Do default stuff",
      files: [],
      orchestratorContext,
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
      topology: "peer_to_peer",
      members: [
        {
          description: "Sub-agent 1",
          prompt: "Do something",
        },
      ],
    };

    const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
    expect(results).toHaveLength(2);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { id: "conv-id-789" },
      expect.objectContaining({
        $set: expect.objectContaining({
          "settings.agents.topology": "peer_to_peer",
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
    });

    expect(mockRunAgenticLoop).toHaveBeenCalled();
    const runArguments = mockRunAgenticLoop.mock.calls[0][0];
    const userMessageContent = runArguments.messages[0].content;

    expect(userMessageContent).toContain("Only modify files within your workspace");

    getWorkspaceRootsSpy.mockRestore();
  });
});
