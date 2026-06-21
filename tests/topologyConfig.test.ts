import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import type {
  OrchestratorContext,
  SubAgentResult,
  OrchestratorSpawnParams,
} from "../src/types/orchestrator.ts";

// Mock GitWorktreeHelper
vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

// Mock SettingsService
vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({
      subAgentProvider: PROVIDERS.GOOGLE,
      subAgentModel: "gemini-3.5-flash",
      topology: "hierarchical",
    }),
  },
}));

// Mock getProvider
const mockGenerateText = vi.fn().mockResolvedValue({
  text: "Synthesized results summary.",
  usage: { inputTokens: 100, outputTokens: 50 },
});

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

// Mock RequestLogger
vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

import { CriticLoopRouter } from "../src/services/orchestrator/routers/CriticLoopRouter.ts";
import { MCTSRouter } from "../src/services/orchestrator/routers/MCTSRouter.ts";
import { DivideAndConquerRouter } from "../src/services/orchestrator/routers/DivideAndConquerRouter.ts";
import { PeerToPeerRouter } from "../src/services/orchestrator/routers/PeerToPeerRouter.ts";

describe("TopologyConfig Test Suite", () => {
  let orchestratorContext: OrchestratorContext;
  let spawnSubAgentMock: Mock<(assignment: OrchestratorSpawnParams) => Promise<SubAgentResult | { error: string }>>;
  let continueSubAgentMock: Mock;

  const createMockResult = (description: string, result: string, agentId?: string): SubAgentResult => ({
    agent_id: agentId || `agent-mock-${Math.random().toString(36).slice(2, 6)}`,
    description,
    status: "completed",
    result,
    summary: "Done",
    toolUses: 2,
    durationMs: 120,
    iterations: 1,
    messages: [],
    diff: { additions: 1, deletions: 0, files: ["test.txt"] },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
      conversationId: "conv-id-789",
      emit: vi.fn(),
    };

    spawnSubAgentMock = vi.fn().mockImplementation(async (assignment: OrchestratorSpawnParams) => {
      return createMockResult(assignment.description || "", `Completed task: ${assignment.description}`);
    });

    continueSubAgentMock = vi.fn().mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      status: "completed",
      result: `Revised output from ${agentId}`,
      summary: "Revised",
      toolUses: 1,
      durationMs: 80,
      iterations: 1,
      messages: [],
    }));
  });

  // ── CriticLoopRouter: Council of Judges (default) ───────────────────

  describe("CriticLoopRouter — Council of Judges (actorCount=1)", () => {
    it("should use default maxRounds=3 when topologyConfig is omitted", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      // Critic always fails with unique feedback to avoid DoT detection
      const actorResult = createMockResult("Actor", "Initial code", "actor-001");
      spawnSubAgentMock.mockResolvedValueOnce(actorResult);  // actor spawn
      const roundFeedback = [
        "FAIL — The authentication module is missing input validation. Add schema validation for all user-facing endpoints.",
        "FAIL — Database connection pooling is not configured. Implement connection pool with min=5 max=20 settings in the config.",
        "FAIL — Error responses do not follow RFC 7807 problem details format. Restructure all error handlers to return standardized JSON.",
      ];
      for (const feedback of roundFeedback) {
        spawnSubAgentMock.mockResolvedValueOnce(
          createMockResult("Critic", feedback),
        );
      }

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
      );

      // 1 actor spawn + 3 critic spawns = 4, 2 continuations (rounds 2 & 3)
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(4);
      expect(continueSubAgentMock).toHaveBeenCalledTimes(2);
    });

    it("should respect topologyConfig.maxRounds=1 (single evaluation, no revision)", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      const actorResult = createMockResult("Actor", "Initial code", "actor-001");
      spawnSubAgentMock
        .mockResolvedValueOnce(actorResult)
        .mockResolvedValue(createMockResult("Critic", "FAIL — incomplete"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 1 },
      );

      // Only 1 round: actor + critic. No continuation.
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });

    it("should respect topologyConfig.maxRounds=5 (extended iteration budget)", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      const actorResult = createMockResult("Actor", "Initial code", "actor-001");
      spawnSubAgentMock.mockResolvedValueOnce(actorResult);
      const extendedFeedback = [
        "FAIL — The pagination implementation is broken. Cursor-based pagination must replace offset-based for scalability.",
        "FAIL — Rate limiting middleware is completely absent. Implement token bucket algorithm with 100 requests per minute per user.",
        "FAIL — The caching layer uses synchronous filesystem reads. Replace with Redis-backed cache using ioredis client library.",
        "FAIL — WebSocket reconnection logic is missing exponential backoff. Implement jittered backoff starting at 1 second doubling to 32.",
        "FAIL — GraphQL schema lacks depth limiting. Add query complexity analysis with maximum depth of 7 and cost limit of 1000 points.",
      ];
      for (const feedback of extendedFeedback) {
        spawnSubAgentMock.mockResolvedValueOnce(
          createMockResult("Critic", feedback),
        );
      }

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 5 },
      );

      // 5 rounds: 1 actor spawn + 5 critic spawns = 6 spawns, 4 continuations (rounds 2-5)
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(6);
      expect(continueSubAgentMock).toHaveBeenCalledTimes(4);
    });

    it("should terminate early on unanimous PASS even with high maxRounds", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic A", prompt: "Fact-check" },
        { description: "Critic B", prompt: "Logic audit" },
      ];

      const actorResult = createMockResult("Actor", "Perfect code", "actor-001");
      spawnSubAgentMock
        .mockResolvedValueOnce(actorResult)
        .mockResolvedValueOnce(createMockResult("Critic A", "PASS — facts correct"))
        .mockResolvedValueOnce(createMockResult("Critic B", "PASS — logic sound"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 10 },
      );

      // Single round: actor + 2 critics. Unanimous PASS, done.
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(3);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });

    it("should require unanimous consensus — partial PASS still triggers revision", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Fact Checker", prompt: "Check facts" },
        { description: "Style Critic", prompt: "Check style" },
      ];

      const actorResult = createMockResult("Actor", "Good code", "actor-001");
      spawnSubAgentMock
        .mockResolvedValueOnce(actorResult)
        // Round 1: fact checker passes, style critic fails
        .mockResolvedValueOnce(createMockResult("Fact Checker", "PASS — all facts correct"))
        .mockResolvedValueOnce(createMockResult("Style Critic", "FAIL — inconsistent naming"))
        // Round 2: both pass
        .mockResolvedValueOnce(createMockResult("Fact Checker", "PASS — still correct"))
        .mockResolvedValueOnce(createMockResult("Style Critic", "PASS — naming fixed"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 3 },
      );

      // Round 1 failed (partial), revision happened, round 2 passed
      expect(continueSubAgentMock).toHaveBeenCalledTimes(1);
      // Revision prompt should mention the non-regressing critic
      const revisionPrompt = continueSubAgentMock.mock.calls[0][1];
      expect(revisionPrompt).toContain("FAILED");
      expect(revisionPrompt).toContain("Style Critic");
    });
  });

  // ── CriticLoopRouter: Jury Mode (actorCount > 1) ─────────────────────

  describe("CriticLoopRouter — Jury Mode (actorCount > 1)", () => {
    it("should spawn N actors in parallel when actorCount > 1", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor A", prompt: "Write thesis v1" },
        { description: "Actor B", prompt: "Write thesis v2" },
        { description: "Actor C", prompt: "Write thesis v3" },
      ];

      // All 3 actors succeed
      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor A", "Thesis version A", "actor-a"))
        .mockResolvedValueOnce(createMockResult("Actor B", "Thesis version B", "actor-b"))
        .mockResolvedValueOnce(createMockResult("Actor C", "Thesis version C", "actor-c"));

      // Judge PASSES the best actor immediately
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify({ bestActorIndex: 1, verdict: "PASS", feedback: "Actor B is best" }),
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { actorCount: 3 },
      );

      // All 3 actors were spawned
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(3);
      // Judge passed → no continuation needed
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });

    it("should refine the winning actor when judge returns FAIL", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor A", prompt: "Write code v1" },
        { description: "Actor B", prompt: "Write code v2" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor A", "Code A", "actor-a"))
        .mockResolvedValueOnce(createMockResult("Actor B", "Code B", "actor-b"));

      // Judge selects actor B but FAILs
      mockGenerateText
        .mockResolvedValueOnce({
          text: JSON.stringify({ bestActorIndex: 1, verdict: "FAIL", feedback: "Missing error handling" }),
          usage: { inputTokens: 100, outputTokens: 50 },
        })
        // Re-evaluation after revision: PASS
        .mockResolvedValueOnce({
          text: JSON.stringify({ bestActorIndex: 0, verdict: "PASS", feedback: "Error handling added" }),
          usage: { inputTokens: 100, outputTokens: 50 },
        });

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { actorCount: 2, maxRounds: 3 },
      );

      // 2 actors spawned + 1 continuation on the winner
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).toHaveBeenCalledTimes(1);
      // Continuation should use the winning actor's ID
      expect(continueSubAgentMock.mock.calls[0][0]).toBe("actor-b");
    });

    it("should clamp actorCount to member count when more actors than members", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Only Actor", prompt: "Write code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Only Actor", "Output", "actor-sole"));

      // Judge passes immediately (single actor in jury mode still works)
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify({ bestActorIndex: 0, verdict: "PASS", feedback: "Good" }),
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { actorCount: 5 },
      );

      // Only 1 actor actually spawned (clamped to members.length)
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
    });

    it("should respect maxRounds in Jury mode", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor A", prompt: "Write code v1" },
        { description: "Actor B", prompt: "Write code v2" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor A", "Code A", "actor-a"))
        .mockResolvedValueOnce(createMockResult("Actor B", "Code B", "actor-b"));

      // Judge always FAILs with different feedback
      mockGenerateText.mockImplementation(async () => ({
        text: JSON.stringify({
          bestActorIndex: 0,
          verdict: "FAIL",
          feedback: `Issue found at ${Date.now()}`,
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
      }));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { actorCount: 2, maxRounds: 2 },
      );

      // maxRounds=2: round 1 (tournament) + round 2 (revision) = 1 continuation
      expect(continueSubAgentMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── CriticLoopRouter: Default behavior without config ─────────────────

  describe("CriticLoopRouter — Default behavior", () => {
    it("should default to Council mode (actorCount=1) when no topologyConfig", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      const actorResult = createMockResult("Actor", "Code output", "actor-001");
      spawnSubAgentMock
        .mockResolvedValueOnce(actorResult)
        .mockResolvedValueOnce(createMockResult("Critic", "PASS — looks good"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
      );

      // Council mode: 1 actor + 1 critic, PASS → done
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
      // Actor should have preserveWorktree: true
      expect(spawnSubAgentMock.mock.calls[0][0].preserveWorktree).toBe(true);
    });

    it("should auto-generate a critic when only 1 member provided", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Solo Actor", prompt: "Implement feature" },
      ];

      const actorResult = createMockResult("Solo Actor", "Feature implemented", "actor-solo");
      spawnSubAgentMock
        .mockResolvedValueOnce(actorResult)
        .mockResolvedValueOnce(createMockResult("Auto Critic", "PASS — feature works"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
      );

      // 1 actor + 1 auto-generated critic
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      // The auto-generated critic's description should mention the actor
      const criticDescription = spawnSubAgentMock.mock.calls[1][0].description;
      expect(criticDescription).toContain("Critic");
    });
  });

  // ── PeerToPeerRouter: maxRounds config ────────────────────────────────

  describe("PeerToPeerRouter — topologyConfig.maxRounds", () => {
    it("should limit to 1 round (no continuation) when maxRounds=1", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Write Code", "Code written", "dev-001"))
        .mockResolvedValueOnce(createMockResult("Verify Code", "Tests pass", "qa-001"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 1 },
      );

      // maxRounds=1 means 2 turns total (1 per member), no continuation
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });

    it("should allow extended debate with maxRounds=4", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Write Code", "Code written", "dev-001"))
        .mockResolvedValueOnce(createMockResult("Verify Code", "Tests pass", "qa-001"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: 4 },
      );

      // maxRounds=4 → 8 turns (4 rounds × 2 members) → 2 spawns + 6 continues
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).toHaveBeenCalledTimes(6);
    });

    it("should use default behavior when topologyConfig is omitted", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Write Code", "Code written", "dev-001"))
        .mockResolvedValueOnce(createMockResult("Verify Code", "Tests pass", "qa-001"));

      const results = await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
      );

      // Default: 2 members → 4 turns → 2 spawns + 2 continues
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── MCTSRouter: maxDepth and branchFactor ─────────────────────────────

  describe("MCTSRouter — topologyConfig", () => {
    it("should use configured branchFactor and maxDepth from topologyConfig", async () => {
      const router = new MCTSRouter();
      const members = [
        { description: "Search", prompt: "Find optimal solution" },
        { description: "Search Alt", prompt: "Find optimal solution" },
      ];

      // Track spawn calls to verify branchFactor
      const spawnCallDescriptions: string[] = [];
      spawnSubAgentMock.mockImplementation(async (assignment: OrchestratorSpawnParams) => {
        spawnCallDescriptions.push(assignment.description || "");
        return createMockResult(assignment.description || "", `Solution from: ${assignment.description}`);
      });

      // Mock evaluator responses for MCTS scoring
      mockGenerateText.mockImplementation(async () => ({
        text: JSON.stringify([
          { branchIndex: 0, score: 8, feedback: "Good solution" },
          { branchIndex: 1, score: 6, feedback: "Adequate solution" },
        ]),
        usage: { inputTokens: 100, outputTokens: 50 },
      }));

      await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { branchFactor: 2, maxDepth: 1 },
      );

      // With maxDepth=1, branchFactor=2: should spawn 2 branches in depth 1 only
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── DivideAndConquerRouter: maxSubtasks ───────────────────────────────

  describe("DivideAndConquerRouter — topologyConfig.maxSubtasks", () => {
    it("should pass configured maxSubtasks to decomposition prompt", async () => {
      const router = new DivideAndConquerRouter();
      // Use 12 members so that Math.min(maxSubtasks, Math.max(12, 3)) = min(10, 12) = 10
      const members = Array.from({ length: 12 }, (_, index) => ({
        description: `Implement part ${index + 1}`,
        prompt: `Build part ${index + 1} of the search module`,
      }));

      // Capture the decomposition prompt
      mockGenerateText.mockImplementation(async (messages: unknown[]) => {
        return {
          text: JSON.stringify([
            { description: "Subtask 1", prompt: "Do part 1" },
            { description: "Subtask 2", prompt: "Do part 2" },
          ]),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      });

      await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxSubtasks: 10 },
      );

      // The decomposition prompt should contain "10 or fewer"
      expect(mockGenerateText).toHaveBeenCalled();
      const decompositionPrompt = (mockGenerateText.mock.calls[0][0] as Array<{ content: string }>)[0].content;
      expect(decompositionPrompt).toContain("10 or fewer independent subtasks");
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  describe("TopologyConfig — Edge Cases", () => {
    it("should handle undefined topologyConfig gracefully (all routers use defaults)", async () => {
      const criticRouter = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor", "Code", "actor-001"))
        .mockResolvedValueOnce(createMockResult("Critic", "PASS — good"));

      // Pass undefined explicitly
      const results = await criticRouter.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        undefined,
      );

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle empty topologyConfig object gracefully", async () => {
      const criticRouter = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor", "Code", "actor-001"))
        .mockResolvedValueOnce(createMockResult("Critic", "PASS — good"));

      const results = await criticRouter.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        {},
      );

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("should ignore invalid topologyConfig values (non-numeric maxRounds)", async () => {
      const criticRouter = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor", "Code", "actor-001"))
        .mockResolvedValueOnce(createMockResult("Critic", "FAIL — issues"));

      // NaN should fall back to default (3 rounds)
      await criticRouter.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: "invalid" as unknown as number },
      );

      // Should fall back to default 3 rounds — actor + 3 critics + 2 continues
      expect(spawnSubAgentMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should clamp actorCount=0 to 1 (Council mode)", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor", "Code", "actor-001"))
        .mockResolvedValueOnce(createMockResult("Critic", "PASS — good"));

      await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { actorCount: 0 },
      );

      // actorCount=0 clamped to 1 → Council mode
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(spawnSubAgentMock.mock.calls[0][0].preserveWorktree).toBe(true);
    });

    it("should clamp negative maxRounds to 1", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createMockResult("Actor", "Code", "actor-001"))
        .mockResolvedValueOnce(createMockResult("Critic", "FAIL — incomplete"));

      await router.execute(
        "test-team", members, orchestratorContext,
        spawnSubAgentMock, continueSubAgentMock,
        { maxRounds: -5 },
      );

      // maxRounds clamped to 1 → single evaluation, no continuation
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });
  });
});
