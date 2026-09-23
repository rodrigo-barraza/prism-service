/**
 * An external ACP agent, spawned the way a parent model spawns any
 * sub-agent: the real create_subagent tool → spawnFromTool → the
 * orchestrator's ACP branch → AgenticLoopService → AcpAgentRuntime → a REAL
 * agent process (src/acp/__tests__/fixtures/fakeAcpAgent.ts). Only
 * tools-service's git endpoints are stubbed (the worktree is a temp dir).
 *
 * What the PARENT sees (prompt 24, Landing 3): the sub-agent spawned on the
 * `acp` provider with the agent's name, its tool calls as
 * sub_agent_tool_execution, its permission request as an approval card
 * tagged with where to decide it, a completion whose cost is marked unknown
 * when the agent reported none — and a crash, or a sub-agent with no
 * worktree, as a `failed` sub-agent with a clean error.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const worktreeHelper = vi.hoisted(() => ({
  worktreePath: "",
  createError: null as string | null,
}));
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockImplementation(async (_repository: string, branch: string) =>
      worktreeHelper.createError
        ? { error: worktreeHelper.createError }
        : { worktreePath: worktreeHelper.worktreePath, branch, repoPath: "/workspace" },
    ),
    commitWorktree: vi.fn().mockResolvedValue({ committed: false }),
    getWorktreeDiff: vi.fn().mockImplementation(async (_repository: string, branch: string) => ({
      branch,
      base: "main",
      files: [],
      patch: "",
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    })),
    mergeWorktree: vi.fn().mockResolvedValue({ merged: true }),
    removeWorktree: vi.fn().mockResolvedValue({ removed: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: vi.fn().mockResolvedValue(undefined) };
});

import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import OrchestratorService from "#src/services/OrchestratorService";
import AgenticLoopService from "#src/services/AgenticLoopService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { GitWorktreeHelper } from "#src/services/orchestrator/GitWorktreeHelper";
import { ACP_AGENT_OWNERS_ENV_VAR } from "#src/services/agents/AgentRuntime";

const FAKE_AGENT = fileURLToPath(new URL("../src/acp/__tests__/fixtures/fakeAcpAgent.ts", import.meta.url));
const OWNER = "acp-owner";
const AGENT = {
  agentId: "CUSTOM_CLAUDE_CODE",
  name: "Claude Code",
  description: "Claude Code, through its ACP adapter.",
  runtime: "acp",
  acp: { command: process.execPath, args: [FAKE_AGENT], envAllowlist: [], owner: OWNER },
};

type Event = { type: string; [key: string]: unknown };

function parentContext(events: Event[]) {
  return {
    project: "test-project",
    username: OWNER,
    agent: "CODING",
    agentConversationId: "parent-session",
    conversationId: "parent-conversation",
    _providerName: PROVIDERS.GOOGLE,
    _resolvedModel: "gemini-3-flash-preview",
    enabledTools: ["read_file", "write_file"],
    _recursionDepth: 0,
    _maxRecursionDepth: 2,
    workspaceRoot: "/workspace",
    _emit: (event: Event) => events.push(event),
  };
}

async function spawnAcpAgent(prompt: string, events: Event[]) {
  const result = await ToolOrchestratorService.executeTool(
    "create_subagent",
    { description: "Delegate to Claude Code", prompt, agent: "Claude Code" },
    parentContext(events),
  );
  expect(result).not.toHaveProperty("error");
}

function subAgentStatus(events: Event[], message: string): Event | undefined {
  return events.find((event) => event.type === "sub_agent_status" && event.message === message);
}

async function waitFor(events: Event[], predicate: (event: Event) => boolean): Promise<Event> {
  let found: Event | undefined;
  await vi.waitFor(
    () => {
      found = events.find(predicate);
      expect(found).toBeDefined();
    },
    { timeout: 15_000, interval: 25 },
  );
  return found!;
}

describe("a custom agent on the acp runtime, spawned by a parent", () => {
  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
    worktreeHelper.worktreePath = mkdtempSync(join(tmpdir(), "prism-acp-spawn-"));
  });
  afterAll(() => {
    rmSync(worktreeHelper.worktreePath, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env[ACP_AGENT_OWNERS_ENV_VAR] = OWNER;
    worktreeHelper.createError = null;
    OrchestratorService.clearAllActiveSubAgents();
    AgentPersonaRegistry.registerCustom({ ...AGENT });
    // Not connected: pending decisions live in memory, request rows are skipped.
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
      aggregate: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    OrchestratorService.clearAllActiveSubAgents();
    AgentPersonaRegistry.unregister(AGENT.agentId);
    delete process.env[ACP_AGENT_OWNERS_ENV_VAR];
  });

  it("runs in its worktree and reaches the parent as a sub-agent on the acp provider", async () => {
    const events: Event[] = [];
    await spawnAcpAgent("SCENARIO=stream Read the notes.", events);
    const complete = await waitFor(events, (event) => event.type === "sub_agent_status" && event.message === "complete");

    expect(subAgentStatus(events, "spawned")).toMatchObject({ provider: "acp", model: "Claude Code" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sub_agent_tool_execution",
        status: "done",
        tool: expect.objectContaining({ id: "read-1", name: "Read notes.md" }),
      }),
    );
    expect(complete).toMatchObject({ estimatedCost: 0.0123, toolCount: 1 });
    expect(complete).not.toHaveProperty("costUnknown");
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    expect(subAgent.output).toBe("All done: the file has two lines.");
    expect(subAgent.runtime).toBe("acp");
  });

  it("marks the completion's cost unknown when the agent reported none", async () => {
    const events: Event[] = [];
    await spawnAcpAgent("SCENARIO=echo hi", events);
    const complete = await waitFor(events, (event) => event.type === "sub_agent_status" && event.message === "complete");
    expect(complete).toMatchObject({ estimatedCost: null, costUnknown: true });
  });

  it("puts its permission request on the parent's stream, tagged with where to decide it", async () => {
    const events: Event[] = [];
    await spawnAcpAgent("SCENARIO=permission edit the notes", events);
    const card = await waitFor(events, (event) => event.type === "approval_required");
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    expect(card).toMatchObject({
      requestedBy: "external_agent",
      subAgentId: subAgent.agentId,
      subAgentDescription: "Delegate to Claude Code",
      approvalConversationId: subAgent.subAgentConversationId,
    });
    const outcome = await AgenticLoopService.decideApproval(card.approvalConversationId as string, {
      toolCallId: card.toolCallId as string,
      decision: "allow",
    });
    expect(outcome).toMatchObject({ status: "decided", delivered: true });
    await waitFor(events, (event) => event.type === "sub_agent_status" && event.message === "complete");
    expect(subAgent.output).toBe("PERMISSION:selected:yes");
  });

  it("a crash fails the sub-agent with a clean error for the parent", async () => {
    const events: Event[] = [];
    await spawnAcpAgent("SCENARIO=crash", events);
    const failed = await waitFor(events, (event) => event.type === "sub_agent_status" && event.message === "failed");
    expect(failed.error).toMatch(/^Claude Code exited with code 3 during the prompt\. Its last output: fatal: the fake agent broke on purpose/);
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    expect(subAgent.status).toBe("failed");
  });

  it("resumed after its worktree was merged back, it runs in a fresh worktree of its own", async () => {
    const events: Event[] = [];
    const isComplete = (event: Event) => event.type === "sub_agent_status" && event.message === "complete";
    await spawnAcpAgent("SCENARIO=echo first", events);
    await waitFor(events, isComplete);
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    expect(subAgent.worktreePath).toBeNull();
    const created = vi.mocked(GitWorktreeHelper.createWorktree).mock.calls.length;

    const resumed = await ToolOrchestratorService.executeTool(
      "resume_subagent",
      { agent_id: subAgent.agentId, prompt: "SCENARIO=echo again" },
      parentContext(events),
    );
    expect(resumed).not.toHaveProperty("error");
    await vi.waitFor(() => expect(events.filter(isComplete)).toHaveLength(2), { timeout: 15_000, interval: 25 });
    expect(vi.mocked(GitWorktreeHelper.createWorktree).mock.calls.length).toBe(created + 1);
    expect(vi.mocked(GitWorktreeHelper.createWorktree).mock.calls.at(-1)![1]).toMatch(
      new RegExp(`^orchestrator/${subAgent.agentId}-[a-z0-9]+$`),
    );
    expect(subAgent.output).toContain("SCENARIO=echo again");
  });

  it("never runs outside a worktree of its own", async () => {
    worktreeHelper.createError = "not a git repository";
    const events: Event[] = [];
    await spawnAcpAgent("SCENARIO=echo hi", events);
    const failed = await waitFor(events, (event) => event.type === "sub_agent_status" && event.message === "failed");
    expect(failed.error).toMatch(/runs only in its own git worktree, and none could be created in \/workspace: not a git repository/);
  });
});
