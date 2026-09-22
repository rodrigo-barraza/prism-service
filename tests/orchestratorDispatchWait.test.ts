/**
 * Prompt 09, Landing 1 (b): create_subagent(s) must never hang.
 *
 * The non-blocking dispatcher (top-level createTeam) waited for EVERY member
 * to call onRegistered, but the cap / depth / circuit-breaker paths in
 * spawnFromTool return an error before registration — one refused member and
 * the tool never returned (it is exempt from the tool timeout). The
 * concurrency cap was also counted across every conversation in the process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, ORCHESTRATOR } from "#src/constants";
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
    toolsApiPost: vi.fn().mockResolvedValue({}),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    getWorktreeDiff: vi.fn().mockResolvedValue({ hasChanges: false, additions: 0, deletions: 0, files: [] }),
    cleanupWorktrees: vi.fn().mockResolvedValue({}),
  },
}));

import OrchestratorService from "#src/services/OrchestratorService";
import type { OrchestratorContext, OrchestratorSpawnParams, SubAgentState } from "#src/types/orchestrator";

const members = [
  { description: "Member 1", prompt: "Task one" },
  { description: "Member 2", prompt: "Task two" },
  { description: "Member 3", prompt: "Task three" },
];

function buildContext(): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
    traceId: "trace-dispatch",
    agentConversationId: "dispatch-session",
    conversationId: "dispatch-conv",
    enabledTools: ["read_file"],
    maxRecursionDepth: 2,
    recursionDepth: 0,
    emit: vi.fn(),
  } as OrchestratorContext;
}

/** Settle `promise` within `milliseconds` of FAKE time, or report it hung. */
async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | "HUNG"> {
  let settled: { value: T } | null = null;
  promise.then((value) => {
    settled = { value };
  });
  await vi.advanceTimersByTimeAsync(milliseconds);
  return settled ? (settled as { value: T }).value : "HUNG";
}

function seedRunningAgents(count: number, parentConversationId: string) {
  const registry = OrchestratorService._getActiveSubAgents();
  for (let index = 0; index < count; index++) {
    registry.set(`seed-${parentConversationId}-${index}`, {
      agentId: `seed-${parentConversationId}-${index}`,
      subAgentConversationId: `seed-sub-${parentConversationId}-${index}`,
      parentConversationId,
      status: "running",
    } as unknown as SubAgentState);
  }
}

describe("create_subagent(s) dispatch never hangs", () => {
  let realSpawn: typeof OrchestratorService.spawnFromTool;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    mockRunAgenticLoop.mockReset();
    // Sub-agent loops never finish during the test — the dispatcher must not
    // wait for them, only for registration.
    mockRunAgenticLoop.mockImplementation(() => new Promise(() => {}));
    realSpawn = OrchestratorService.spawnFromTool.bind(OrchestratorService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    OrchestratorService.clearAllActiveSubAgents();
    vi.useRealTimers();
  });

  it("returns promptly with 2 started and 1 error when member #2 hits the depth cap", async () => {
    vi.spyOn(OrchestratorService, "spawnFromTool").mockImplementation((assignment: OrchestratorSpawnParams) =>
      assignment.agentIndex === 1
        ? realSpawn({
            ...assignment,
            // The real depth-cap path: current depth already at the max.
            orchestratorContext: { ...assignment.orchestratorContext, recursionDepth: 2, maxRecursionDepth: 2 },
          })
        : realSpawn(assignment),
    );

    const outcome = await settleWithin(
      OrchestratorService.createTeam({ name: "depth_team", members, topology: TOPOLOGIES.HIERARCHICAL }, buildContext()),
      1_000,
    );

    expect(outcome, "createTeam must return without waiting for the refused member").not.toBe("HUNG");
    const results = outcome as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    const errors = results.filter((result) => "error" in result);
    const started = results.filter((result) => !("error" in result));
    expect(started).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(String(errors[0].error)).toContain("Sub-agent spawning limit reached");
  });

  it("a sequential team whose first step is refused returns instead of waiting for steps that never spawn", async () => {
    vi.spyOn(OrchestratorService, "spawnFromTool").mockImplementation((assignment: OrchestratorSpawnParams) =>
      realSpawn({
        ...assignment,
        orchestratorContext: { ...assignment.orchestratorContext, recursionDepth: 2, maxRecursionDepth: 2 },
      }),
    );

    const outcome = await settleWithin(
      OrchestratorService.createTeam({ name: "sequence_team", members, topology: TOPOLOGIES.SEQUENTIAL }, buildContext()),
      1_000,
    );

    expect(outcome).not.toBe("HUNG");
    const results = outcome as Array<Record<string, unknown>>;
    expect(results.some((result) => String(result.error ?? "").includes("Sub-agent spawning limit reached"))).toBe(true);
  });

  it("the dispatch wait is bounded: a member that never registers yields an error after the timeout", async () => {
    vi.spyOn(OrchestratorService, "spawnFromTool").mockImplementation((assignment: OrchestratorSpawnParams) =>
      assignment.agentIndex === 2 ? new Promise(() => {}) : realSpawn(assignment),
    );

    const pending = OrchestratorService.createTeam(
      { name: "stuck_team", members, topology: TOPOLOGIES.HIERARCHICAL },
      buildContext(),
    );
    expect(await settleWithin(pending, 1_000)).toBe("HUNG");

    const outcome = await settleWithin(pending, ORCHESTRATOR.DISPATCH_REGISTRATION_TIMEOUT_MILLISECONDS);
    expect(outcome, "the wait must end at DISPATCH_REGISTRATION_TIMEOUT_MILLISECONDS").not.toBe("HUNG");
    const results = outcome as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results.filter((result) => !("error" in result))).toHaveLength(2);
    expect(String(results.find((result) => "error" in result)?.error)).toMatch(/did not register/);
  });

  it("the concurrency cap counts the root conversation, not the whole process", async () => {
    seedRunningAgents(ORCHESTRATOR.MAX_SUB_AGENTS, "some-other-conversation");

    const outcome = await settleWithin(
      OrchestratorService.spawnFromTool({
        description: "Unrelated spawn",
        prompt: "Do it",
        files: [],
        orchestratorContext: buildContext(),
      }),
      1_000,
    );

    expect(outcome).not.toBe("HUNG");
    expect((outcome as Record<string, unknown>).error).toBeUndefined();
  });

  it("the concurrency cap still holds inside one root conversation", async () => {
    seedRunningAgents(ORCHESTRATOR.MAX_SUB_AGENTS, "dispatch-conv");

    const outcome = await settleWithin(
      OrchestratorService.spawnFromTool({
        description: "One too many",
        prompt: "Do it",
        files: [],
        orchestratorContext: buildContext(),
      }),
      1_000,
    );

    expect(String((outcome as Record<string, unknown>).error)).toContain("Maximum concurrent sub-agents");
  });
});
