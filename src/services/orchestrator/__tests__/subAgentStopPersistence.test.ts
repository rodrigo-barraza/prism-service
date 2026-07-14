/**
 * Sub-Agent Stop Persistence Tests
 *
 * Validates that the SubAgentLifecycleService correctly transitions
 * sub-agent status to terminal states when stopped or aborted, covering
 * the bug where `subAgentStatus` was left as "running" in MongoDB after
 * a conversation was stopped — causing the frontend to perpetually
 * display "Generating…" badges.
 *
 * Root Cause:
 *   `abortSubAgentsByConversation` updated in-memory status to "stopped"
 *   but never persisted the change to the database document. When the
 *   conversation was reloaded (page refresh / server restart), the stale
 *   "running" DB value was read and normalised to "generating" by the
 *   frontend's `normalizeSubAgentStatusToPhase`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock infrastructure before importing the module under test ────
// MongoWrapper is the only real external dependency; everything else
// is pure logic that we can exercise directly.

const mockUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
const mockCollection = { updateOne: mockUpdateOne };

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: vi.fn(() => mockCollection),
  },
}));

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    removeWorktree: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { SubAgentLifecycleService } from "#src/services/orchestrator/SubAgentLifecycleService";
import { SYSTEM_STATUSES } from "#src/constants";
import type { SubAgentState } from "#src/types/orchestrator";

// ── Test Helpers ───────────────────────────────────────────────

function createMockSubAgentState(
  overrides: Partial<SubAgentState> = {},
): SubAgentState {
  return {
    agentId: overrides.agentId ?? "agent-1",
    subAgentConversationId: overrides.subAgentConversationId ?? "sub-conv-1",
    parentAgentConversationId: overrides.parentAgentConversationId ?? "parent-agent-conv-1",
    description: "Test sub-agent",
    branchName: null,
    worktreePath: null,
    repositoryPath: "/repo",
    isolated: false,
    status: SYSTEM_STATUSES.RUNNING,
    output: "",
    toolCalls: [],
    diff: null,
    error: null,
    startedAt: Date.now() - 5000,
    durationMilliseconds: 0,
    totalCost: null,
    usage: null,
    abortController: new AbortController(),
    messages: null,
    files: [],
    project: "test-project",
    username: "test-user",
    agent: "omni",
    providerName: "test-provider",
    resolvedModel: "test-model",
    traceId: null,
    maxIterations: 10,
    minContextLength: null,
    parentConversationId: overrides.parentConversationId ?? "parent-conv-1",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("SubAgentLifecycleService — Stop / Abort Persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── stopSubAgent ──────────────────────────────────────────

  describe("stopSubAgent", () => {
    it("transitions in-memory status to 'stopped'", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const subAgentState = createMockSubAgentState({ agentId: "agent-stop-1" });
      activeSubAgents.set("agent-stop-1", subAgentState);

      const result = await SubAgentLifecycleService.stopSubAgent(
        "agent-stop-1",
        activeSubAgents,
      );

      expect(subAgentState.status).toBe(SYSTEM_STATUSES.STOPPED);
      expect(result).toEqual({
        agent_id: "agent-stop-1",
        status: SYSTEM_STATUSES.STOPPED,
      });
    });

    it("persists 'stopped' status to MongoDB", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const subAgentState = createMockSubAgentState({
        agentId: "agent-stop-2",
        subAgentConversationId: "sub-conv-persist",
      });
      activeSubAgents.set("agent-stop-2", subAgentState);

      await SubAgentLifecycleService.stopSubAgent(
        "agent-stop-2",
        activeSubAgents,
      );

      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: "sub-conv-persist" },
        {
          $set: expect.objectContaining({
            subAgentStatus: SYSTEM_STATUSES.STOPPED,
            subAgentDurationMilliseconds: expect.any(Number),
            subAgentCompletedAt: expect.any(String),
          }),
        },
      );
    });

    it("aborts the sub-agent's AbortController signal", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const abortController = new AbortController();
      const subAgentState = createMockSubAgentState({
        agentId: "agent-abort-signal",
        abortController,
      });
      activeSubAgents.set("agent-abort-signal", subAgentState);

      await SubAgentLifecycleService.stopSubAgent(
        "agent-abort-signal",
        activeSubAgents,
      );

      expect(abortController.signal.aborted).toBe(true);
    });

    it("records non-zero duration on stop", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const subAgentState = createMockSubAgentState({
        agentId: "agent-duration",
        startedAt: Date.now() - 10000,
      });
      activeSubAgents.set("agent-duration", subAgentState);

      await SubAgentLifecycleService.stopSubAgent(
        "agent-duration",
        activeSubAgents,
      );

      expect(subAgentState.durationMilliseconds).toBeGreaterThan(0);
    });

    it("returns error for non-existent agent", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();

      const result = await SubAgentLifecycleService.stopSubAgent(
        "nonexistent",
        activeSubAgents,
      );

      expect(result).toEqual({
        error: `Sub-agent "nonexistent" not found.`,
      });
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });
  });

  // ── abortSubAgentsByConversation ──────────────────────────

  describe("abortSubAgentsByConversation", () => {
    it("transitions all running sub-agents to 'stopped'", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const parentConversationId = "parent-conv-abort";

      const subAgentOne = createMockSubAgentState({
        agentId: "agent-a",
        parentConversationId,
        subAgentConversationId: "sub-conv-a",
      });
      const subAgentTwo = createMockSubAgentState({
        agentId: "agent-b",
        parentConversationId,
        subAgentConversationId: "sub-conv-b",
      });
      activeSubAgents.set("agent-a", subAgentOne);
      activeSubAgents.set("agent-b", subAgentTwo);

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        parentConversationId,
        activeSubAgents,
      );

      expect(subAgentOne.status).toBe(SYSTEM_STATUSES.STOPPED);
      expect(subAgentTwo.status).toBe(SYSTEM_STATUSES.STOPPED);
    });

    it("persists 'stopped' to MongoDB for each aborted sub-agent", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const parentConversationId = "parent-conv-persist-all";

      const subAgentOne = createMockSubAgentState({
        agentId: "agent-persist-a",
        parentConversationId,
        subAgentConversationId: "sub-conv-pa",
      });
      const subAgentTwo = createMockSubAgentState({
        agentId: "agent-persist-b",
        parentConversationId,
        subAgentConversationId: "sub-conv-pb",
      });
      activeSubAgents.set("agent-persist-a", subAgentOne);
      activeSubAgents.set("agent-persist-b", subAgentTwo);

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        parentConversationId,
        activeSubAgents,
      );

      // One updateOne call per stopped sub-agent
      const persistedConversationIds = mockUpdateOne.mock.calls.map(
        (callArguments: unknown[]) => (callArguments[0] as { id: string }).id,
      );
      expect(persistedConversationIds).toContain("sub-conv-pa");
      expect(persistedConversationIds).toContain("sub-conv-pb");
    });

    it("does NOT modify already-completed sub-agents", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const parentConversationId = "parent-conv-mixed";

      const runningSubAgent = createMockSubAgentState({
        agentId: "agent-running",
        parentConversationId,
        subAgentConversationId: "sub-conv-running",
      });
      const completedSubAgent = createMockSubAgentState({
        agentId: "agent-done",
        parentConversationId,
        subAgentConversationId: "sub-conv-done",
        status: SYSTEM_STATUSES.COMPLETE,
      });
      activeSubAgents.set("agent-running", runningSubAgent);
      activeSubAgents.set("agent-done", completedSubAgent);

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        parentConversationId,
        activeSubAgents,
      );

      expect(runningSubAgent.status).toBe(SYSTEM_STATUSES.STOPPED);
      expect(completedSubAgent.status).toBe(SYSTEM_STATUSES.COMPLETE);

      // Only the running agent should have been persisted
      const persistedConversationIds = mockUpdateOne.mock.calls.map(
        (callArguments: unknown[]) => (callArguments[0] as { id: string }).id,
      );
      expect(persistedConversationIds).toContain("sub-conv-running");
      expect(persistedConversationIds).not.toContain("sub-conv-done");
    });

    it("does NOT modify sub-agents belonging to other conversations", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();

      const ownSubAgent = createMockSubAgentState({
        agentId: "agent-own",
        parentConversationId: "parent-target",
        subAgentConversationId: "sub-conv-own",
      });
      const otherSubAgent = createMockSubAgentState({
        agentId: "agent-other",
        parentConversationId: "parent-different",
        subAgentConversationId: "sub-conv-other",
      });
      activeSubAgents.set("agent-own", ownSubAgent);
      activeSubAgents.set("agent-other", otherSubAgent);

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        "parent-target",
        activeSubAgents,
      );

      expect(ownSubAgent.status).toBe(SYSTEM_STATUSES.STOPPED);
      expect(otherSubAgent.status).toBe(SYSTEM_STATUSES.RUNNING);
    });

    it("is a no-op when no sub-agents match the conversation", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      activeSubAgents.set(
        "agent-unrelated",
        createMockSubAgentState({
          agentId: "agent-unrelated",
          parentConversationId: "some-other-conv",
        }),
      );

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        "non-matching-parent",
        activeSubAgents,
      );

      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it("aborts all AbortController signals for running sub-agents", async () => {
      const activeSubAgents = new Map<string, SubAgentState>();
      const parentConversationId = "parent-conv-signals";

      const abortControllerOne = new AbortController();
      const abortControllerTwo = new AbortController();

      activeSubAgents.set(
        "agent-sig-1",
        createMockSubAgentState({
          agentId: "agent-sig-1",
          parentConversationId,
          abortController: abortControllerOne,
        }),
      );
      activeSubAgents.set(
        "agent-sig-2",
        createMockSubAgentState({
          agentId: "agent-sig-2",
          parentConversationId,
          abortController: abortControllerTwo,
        }),
      );

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        parentConversationId,
        activeSubAgents,
      );

      expect(abortControllerOne.signal.aborted).toBe(true);
      expect(abortControllerTwo.signal.aborted).toBe(true);
    });

    it("handles MongoDB persistence failure gracefully (does not throw)", async () => {
      mockUpdateOne.mockRejectedValueOnce(new Error("DB connection lost"));

      const activeSubAgents = new Map<string, SubAgentState>();
      const subAgentState = createMockSubAgentState({
        agentId: "agent-db-fail",
        parentConversationId: "parent-db-fail",
      });
      activeSubAgents.set("agent-db-fail", subAgentState);

      // Should not throw despite DB failure
      await expect(
        SubAgentLifecycleService.abortSubAgentsByConversation(
          "parent-db-fail",
          activeSubAgents,
        ),
      ).resolves.toBeUndefined();

      // In-memory status should still be stopped
      expect(subAgentState.status).toBe(SYSTEM_STATUSES.STOPPED);
    });
  });

  // ── emitSpawnedStatus ─────────────────────────────────────

  describe("emitSpawnedStatus", () => {
    it("emits a running sub_agent_status event with the agent's identity", () => {
      const emit = vi.fn();
      const subAgent = createMockSubAgentState({
        agentId: "agent-spawn-1",
        agentIndex: 1,
        globalSpawnIndex: 3,
      });

      SubAgentLifecycleService.emitSpawnedStatus(emit, subAgent);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          subAgentId: "agent-spawn-1",
          status: SYSTEM_STATUSES.RUNNING,
          conversationId: "sub-conv-1",
          agentConversationId: "parent-agent-conv-1",
          provider: "test-provider",
          model: "test-model",
          agentIndex: 1,
          globalSpawnIndex: 3,
        }),
      );
    });

    it("is a no-op when no emit function is provided", () => {
      expect(() =>
        SubAgentLifecycleService.emitSpawnedStatus(
          undefined,
          createMockSubAgentState(),
        ),
      ).not.toThrow();
    });
  });

  // ── markSubAgentFailed ────────────────────────────────────

  describe("markSubAgentFailed", () => {
    it("sets terminal status/error/duration and emits FAILED", () => {
      const emit = vi.fn();
      const subAgent = createMockSubAgentState({ agentId: "agent-fail-1" });

      SubAgentLifecycleService.markSubAgentFailed(
        subAgent,
        new Error("boom"),
        { emit },
      );

      expect(subAgent.status).toBe(SYSTEM_STATUSES.FAILED);
      expect(subAgent.error).toBe("boom");
      expect(subAgent.durationMilliseconds).toBeGreaterThan(0);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          subAgentId: "agent-fail-1",
          message: SYSTEM_STATUSES.FAILED,
          error: "boom",
        }),
      );
    });

    it("skips worktree cleanup and DB persistence when cleanupResources is unset", async () => {
      const { GitWorktreeHelper } = await import(
        "#src/services/orchestrator/GitWorktreeHelper"
      );
      const subAgent = createMockSubAgentState({
        agentId: "agent-fail-2",
        isolated: true,
        worktreePath: "/repo/.worktrees/agent-fail-2",
      });

      SubAgentLifecycleService.markSubAgentFailed(subAgent, new Error("x"));

      expect(GitWorktreeHelper.removeWorktree).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it("removes the worktree and persists the terminal status when cleanupResources is set", async () => {
      const { GitWorktreeHelper } = await import(
        "#src/services/orchestrator/GitWorktreeHelper"
      );
      const subAgent = createMockSubAgentState({
        agentId: "agent-fail-3",
        isolated: true,
        worktreePath: "/repo/.worktrees/agent-fail-3",
      });

      SubAgentLifecycleService.markSubAgentFailed(subAgent, new Error("x"), {
        cleanupResources: true,
      });
      // Let the fire-and-forget cleanup/persist microtasks settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(GitWorktreeHelper.removeWorktree).toHaveBeenCalledWith(
        "/repo",
        "/repo/.worktrees/agent-fail-3",
      );
      expect(mockUpdateOne).toHaveBeenCalled();
    });
  });
});
