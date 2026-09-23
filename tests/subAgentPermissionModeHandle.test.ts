/**
 * A sub-agent whose definition names a permission mode runs under a mode
 * handle of its own — its parent's live mode, narrowed (subAgentModeHandle).
 *
 * agent-definitions-as-files narrowed only `autoApprove`, and
 * permission-modes handed every sub-agent its parent's handle itself: in
 * the union a `plan` agent under a parent in acceptEdits ran in acceptEdits,
 * and its workspace edits were approved without a card.
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
    getDefaultWorkspaceRoot: vi.fn((root?: string) => root || "/workspace"),
    resolveRepositoryPath: vi.fn((root: string) => root),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    commitWorktree: vi.fn().mockResolvedValue({ committed: false }),
    getWorktreeDiff: vi.fn().mockResolvedValue(null),
    mergeWorktree: vi.fn().mockResolvedValue(null),
    removeWorktree: vi.fn().mockResolvedValue({ branchDeleted: false }),
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
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";

function toolContext(permissionMode: PermissionModeHandle) {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    agentConversationId: "parent-session",
    conversationId: "parent-conversation",
    _providerName: PROVIDERS.GOOGLE,
    _resolvedModel: "gemini-3-flash-preview",
    enabledTools: ["read_file"],
    _recursionDepth: 0,
    _maxRecursionDepth: 2,
    _autoApprove: false,
    _permissionMode: permissionMode,
  };
}

function registerAgent(name: string, permissionMode?: string) {
  AgentPersonaRegistry.registerCustom({
    agentId: `CUSTOM_${name.toUpperCase()}`,
    name,
    description: `the ${name} agent`,
    availableTools: ["read_file"],
    ...(permissionMode && { permissionMode }),
  });
}

async function spawn(agent: string, parent: PermissionModeHandle) {
  await ToolOrchestratorService.executeTool(
    "create_subagent",
    { description: "Look at it", prompt: "Look at the notes.", agent },
    toolContext(parent),
  );
  const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
  await vi.waitFor(() => expect(subAgent.status).toBe("complete"));
}

/** The mode handle each run of the loop was given, and the modes it read while running. */
function recordModes(duringRun: (parent: PermissionModeHandle) => void, parent: PermissionModeHandle) {
  const seen: { handle: PermissionModeHandle | null; modes: string[] } = { handle: null, modes: [] };
  mockRunAgenticLoop.mockImplementation(async (context: { messages: unknown[]; options: { _permissionMode?: PermissionModeHandle } }) => {
    const handle = context.options._permissionMode ?? null;
    seen.handle = handle;
    seen.modes.push(handle?.mode ?? "none");
    duringRun(parent);
    seen.modes.push(handle?.mode ?? "none");
    return { messages: [...context.messages, { role: "assistant", content: "done" }] };
  });
  return seen;
}

describe("a sub-agent's definition narrows its parent's live permission mode", () => {
  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
    OrchestratorService.clearAllActiveSubAgents();
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
    for (const id of ["CUSTOM_REVIEWER", "CUSTOM_SILENT", "CUSTOM_HELPER"]) AgentPersonaRegistry.unregister(id);
  });

  it("a plan agent under a parent in acceptEdits runs in plan, whatever the parent switches to", async () => {
    registerAgent("Reviewer", "plan");
    const parent = new PermissionModeHandle("acceptEdits", { source: "request" });
    const seen = recordModes((running) => running.set("bypass", "user"), parent);

    await spawn("Reviewer", parent);

    expect(seen.handle).not.toBe(parent);
    expect(seen.modes).toEqual(["plan", "plan"]);
  });

  it("a dontAsk agent follows its parent into plan while it runs, and lets go when it ends", async () => {
    registerAgent("Silent", "dontAsk");
    const parent = new PermissionModeHandle("default");
    const seen = recordModes((running) => running.set("plan", "user"), parent);

    await spawn("Silent", parent);

    expect(seen.modes).toEqual(["dontAsk", "plan"]);
    parent.set("default", "plan_approved");
    expect(seen.handle?.mode).toBe("plan");
  });

  it("an agent that names no mode shares its parent's handle", async () => {
    registerAgent("Helper");
    const parent = new PermissionModeHandle("acceptEdits");
    const seen = recordModes((running) => running.set("default", "user"), parent);

    await spawn("Helper", parent);

    expect(seen.handle).toBe(parent);
    expect(seen.modes).toEqual(["acceptEdits", "default"]);
  });
});
