import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the GitWorktreeHelper to avoid disk operations
vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
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
import AgenticLoopService from "../src/services/AgenticLoopService.ts";
import OrchestratorService from "../src/services/OrchestratorService.ts";
import AgentPersonaRegistry from "../src/services/AgentPersonaRegistry.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";

const mockRunAgenticLoop = vi.fn().mockResolvedValue({
  messages: [{ role: "assistant", content: "Mock sub-agent output" }],
});

describe("OrchestratorService Spawning & Agent Types", () => {
  let orchestratorContext: OrchestratorContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(mockRunAgenticLoop);

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
});
