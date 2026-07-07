import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  OrchestratorContext,
  SubAgentResult,
  OrchestratorSpawnParams,
  SubtreeMetrics,
} from "#src/types/orchestrator";
import type { ChatMessage, ProviderOptions } from "#src/types/ProviderTypes";
import type { GenerateTextResult } from "#src/types/provider";
import type { ContinueSubAgentCallback } from "#src/services/orchestrator/TopologyRouter";

vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({
      subAgentProvider: PROVIDERS.GOOGLE,
      subAgentModel: "gemini-3.5-flash",
      topology: TOPOLOGIES.HIERARCHICAL,
    }),
  },
}));

const mockGenerateText = vi.fn<(messages: ChatMessage[], model?: string, options?: ProviderOptions) => Promise<GenerateTextResult>>().mockResolvedValue({
  text: "Synthesized results summary.",
  usage: { inputTokens: 100, outputTokens: 50 },
});

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

import { getProvider } from "#src/providers/index";
import { HierarchicalRouter } from "#src/services/orchestrator/routers/HierarchicalRouter";
import { SequentialRouter } from "#src/services/orchestrator/routers/SequentialRouter";
import { PeerToPeerRouter } from "#src/services/orchestrator/routers/PeerToPeerRouter";
import { DivideAndConquerRouter } from "#src/services/orchestrator/routers/DivideAndConquerRouter";
import { CriticLoopRouter } from "#src/services/orchestrator/routers/CriticLoopRouter";
import { TournamentRouter } from "#src/services/orchestrator/routers/TournamentRouter";
import { HierarchicalAggregationRouter } from "#src/services/orchestrator/routers/HierarchicalAggregationRouter";
import {
  extractSubtreeMetrics,
  buildSubAgentResult,
  buildToolCallFallbackSummary,
  getLastAssistantText,
  estimateTokens,
} from "#src/services/orchestrator/SubAgentResultBuilder";
import type { ConversationMessage } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function createSubAgentResult(overrides: Partial<SubAgentResult> & { description: string }): SubAgentResult {
  const result: SubAgentResult = {
    agent_id: overrides.agent_id ?? `agent-${Math.random().toString(36).slice(2, 8)}`,
    description: overrides.description,
    status: overrides.status ?? "completed",
    summary: overrides.summary ?? "Done",
    result: overrides.result ?? `Output from "${overrides.description}"`,
    toolUses: overrides.toolUses ?? 2,
    durationMilliseconds: overrides.durationMilliseconds ?? 150,
    iterations: overrides.iterations ?? 1,
    messages: overrides.messages ?? [],
    diff: overrides.diff,
    recursionDepth: overrides.recursionDepth,
    subtreeMetrics: overrides.subtreeMetrics,
    toolNames: overrides.toolNames,
  };
  // Only include error key when explicitly provided — routers use
  // "error" in result (the `in` operator) to branch on error vs success,
  // so an `error: undefined` key would incorrectly trigger the error path.
  if (overrides.error !== undefined) {
    result.error = overrides.error;
  }
  return result;
}

function createToolResultMessage(results: SubAgentResult[]): ConversationMessage {
  return {
    role: "tool" as const,
    content: JSON.stringify(
      results.map((result) => ({
        agent_id: result.agent_id,
        description: result.description,
        status: result.status,
        result: result.result,
        error: result.error,
        recursionDepth: result.recursionDepth,
        durationMilliseconds: result.durationMilliseconds,
        toolUses: result.toolUses,
        subtreeMetrics: result.subtreeMetrics,
      })),
    ),
  };
}

function createOrchestratorContext(overrides?: Partial<OrchestratorContext>): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3.5-flash",
    traceId: "trace-depth-test",
    agentConversationId: "session-depth-test",
    conversationId: "conv-depth-test",
    emit: vi.fn(),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════
// SUB-AGENT TOPOLOGY DEPTH TESTS (Depth 1 → 2 → 3)
// ════════════════════════════════════════════════════════════════

describe("Sub-Agent Topology Depth Tests (depth 1→2→3)", () => {
  let orchestratorContext: OrchestratorContext;
  let spawnSubAgentMock: Mock<(assignment: OrchestratorSpawnParams) => Promise<SubAgentResult | { error: string }>>;
  let continueSubAgentMock: Mock<ContinueSubAgentCallback>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-establish provider mocks cleared by clearAllMocks
    mockGenerateText.mockResolvedValue({
      text: "Synthesized results summary.",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    vi.mocked(getProvider).mockImplementation((() => ({
      generateText: mockGenerateText,
    })) as any);

    orchestratorContext = createOrchestratorContext();

    spawnSubAgentMock = vi.fn().mockImplementation(async (assignment: OrchestratorSpawnParams) =>
      createSubAgentResult({
        description: assignment.description || "",
        result: `Completed: ${assignment.description}`,
      }),
    );

    continueSubAgentMock = vi.fn().mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      status: "completed",
      result: `Continued output from ${agentId}`,
      summary: "Continued",
      toolUses: 1,
      durationMilliseconds: 80,
      iterations: 1,
      messages: [],
    }));
  });

  // ── DEPTH 1: Direct child spawning ────────────────────────────

  describe("Depth 1 — Direct child sub-agents", () => {
    it("HierarchicalRouter should spawn 4 children at depth 1 and return all results", async () => {
      const router = new HierarchicalRouter();
      const members = Array.from({ length: 4 }, (_, index) => ({
        description: `Worker-D1-${index}`,
        prompt: `Task ${index} at depth 1`,
      }));

      const results = await router.execute("depth-1-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(4);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(4);
      for (const result of results) {
        expect("status" in result && result.status).toBe("completed");
      }
    });

    it("SequentialRouter should chain 3 depth-1 children with context accumulation", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Setup-D1", prompt: "Initialize the database schema" },
        { description: "Migrate-D1", prompt: "Run data migration scripts" },
        { description: "Verify-D1", prompt: "Validate migration integrity" },
      ];

      const results = await router.execute("depth-1-seq", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(3);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(3);

      const thirdCallPrompt = spawnSubAgentMock.mock.calls[2][0].prompt;
      expect(thirdCallPrompt).toContain("PREVIOUS STEPS RESULTS");
      expect(thirdCallPrompt).toContain("Completed: Setup-D1");
      expect(thirdCallPrompt).toContain("Completed: Migrate-D1");
    });

    it("PeerToPeerRouter should spawn depth-1 agents and rotate them through discussion rounds", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Architect", description: "System Design", prompt: "Design the API architecture" },
        { agent: "Reviewer", description: "Code Review", prompt: "Review the architecture proposal" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createSubAgentResult({ description: "System Design", agent_id: "arch-d1", result: "API design complete" }))
        .mockResolvedValueOnce(createSubAgentResult({ description: "Code Review", agent_id: "rev-d1", result: "LGTM. [DONE]" }));

      const results = await router.execute("depth-1-p2p", members, orchestratorContext, spawnSubAgentMock, continueSubAgentMock);

      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
    });

    it("CriticLoopRouter should run actor→critic cycle at depth 1", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Writer-D1", prompt: "Write the authentication module" },
        { description: "Reviewer-D1", prompt: "Review the authentication module" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createSubAgentResult({ description: "Writer-D1", agent_id: "writer-d1", result: "Auth module implemented" }))
        .mockResolvedValueOnce(createSubAgentResult({ description: "Reviewer-D1", result: "PASS — authentication looks solid" }));

      const results = await router.execute("depth-1-critic", members, orchestratorContext, spawnSubAgentMock, continueSubAgentMock);

      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(continueSubAgentMock).not.toHaveBeenCalled();
    });

    it("TournamentRouter should spawn candidates at depth 1 and select winner", async () => {
      const router = new TournamentRouter();
      const members = [
        { description: "Candidate-A-D1", prompt: "Implement sorting algorithm v1" },
        { description: "Candidate-B-D1", prompt: "Implement sorting algorithm v2" },
      ];

      mockGenerateText.mockResolvedValueOnce({
        text: "**Winner:** Sub-Agent #1\n**Justification:** Candidate A has better time complexity.",
        usage: { inputTokens: 200, outputTokens: 80 },
      });

      const results = await router.execute("depth-1-tourn", members, orchestratorContext, spawnSubAgentMock, continueSubAgentMock);

      expect(results).toHaveLength(3);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── DEPTH 2: Children spawning grandchildren ───────────────────

  describe("Depth 2 — Grandchild sub-agents via subtreeMetrics", () => {
    it("extractSubtreeMetrics should correctly aggregate depth-2 child results from tool messages", () => {
      const grandchildResults: SubAgentResult[] = [
        createSubAgentResult({ description: "GC-1", agent_id: "gc-1", recursionDepth: 2, durationMilliseconds: 500, toolUses: 3, result: "Grandchild 1 done" }),
        createSubAgentResult({ description: "GC-2", agent_id: "gc-2", recursionDepth: 2, durationMilliseconds: 700, toolUses: 5, result: "Grandchild 2 done" }),
      ];

      const messages: ConversationMessage[] = [
        { role: "user", content: "Orchestrator prompt" },
        { role: "assistant", content: "Spawning sub-team..." },
        createToolResultMessage(grandchildResults),
        { role: "assistant", content: "All grandchildren complete." },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(2);
      expect(metrics!.maxDepthReached).toBe(2);
      expect(metrics!.aggregatedDurationMilliseconds).toBe(1200);
      expect(metrics!.aggregatedToolUses).toBe(8);
      expect(metrics!.childResults).toHaveLength(2);
      expect(metrics!.childResults![0].result).toBe("Grandchild 1 done");
      expect(metrics!.childResults![1].result).toBe("Grandchild 2 done");
    });

    it("extractSubtreeMetrics should extract child results from ReAct-style assistant toolCalls (inline result objects)", () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Orchestrator prompt" },
        {
          role: "assistant",
          content: "I'll spawn a sub-team to handle this.",
          toolCalls: [
            {
              id: "tool-call-1",
              name: "create_subagents",
              args: { name: "Research_Team", members: [] },
              result: [
                {
                  agent_id: "agent-1-55df",
                  description: "Pokemon TCG Investment Expert",
                  status: "completed",
                  summary: "Agent completed successfully",
                  result: "The sub-agents provided research results about Pokemon card values.",
                  toolUses: 3,
                  iterations: 4,
                  durationMilliseconds: 422847,
                  recursionDepth: 1,
                },
                {
                  agent_id: "agent-2-a1b2",
                  description: "Market Analysis Specialist",
                  status: "completed",
                  summary: "Agent completed successfully",
                  result: "Market trends analyzed across Japanese and English markets.",
                  toolUses: 5,
                  iterations: 3,
                  durationMilliseconds: 315000,
                  recursionDepth: 1,
                },
              ],
            },
          ],
        },
        { role: "assistant", content: "All research complete." },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(2);
      expect(metrics!.maxDepthReached).toBe(1);
      expect(metrics!.aggregatedDurationMilliseconds).toBe(422847 + 315000);
      expect(metrics!.aggregatedToolUses).toBe(3 + 5);
      expect(metrics!.childResults).toHaveLength(2);
      expect(metrics!.childResults![0].agent_id).toBe("agent-1-55df");
      expect(metrics!.childResults![0].result).toContain("Pokemon card values");
      expect(metrics!.childResults![1].agent_id).toBe("agent-2-a1b2");
    });

    it("extractSubtreeMetrics should handle mixed Anthropic-style and ReAct-style messages in the same conversation", () => {
      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify({
            agent_id: "anthropic-child",
            description: "Anthropic-format child",
            status: "completed",
            recursionDepth: 1,
            durationMilliseconds: 1000,
            toolUses: 2,
            result: "Anthropic style result",
          }),
        },
        {
          role: "assistant",
          content: "Spawning another team...",
          toolCalls: [
            {
              id: "tool-call-2",
              name: "create_subagents",
              args: { name: "Second_Team", members: [] },
              result: [
                {
                  agent_id: "react-child",
                  description: "ReAct-format child",
                  status: "completed",
                  recursionDepth: 1,
                  durationMilliseconds: 2000,
                  toolUses: 4,
                  result: "ReAct style result",
                },
              ],
            },
          ],
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(2);
      expect(metrics!.childResults).toHaveLength(2);
      expect(metrics!.childResults![0].agent_id).toBe("anthropic-child");
      expect(metrics!.childResults![1].agent_id).toBe("react-child");
      expect(metrics!.aggregatedDurationMilliseconds).toBe(3000);
      expect(metrics!.aggregatedToolUses).toBe(6);
    });

    it("extractSubtreeMetrics should ignore non-create_team tool results on assistant messages", () => {
      const messages: ConversationMessage[] = [
        {
          role: "assistant",
          content: "Running some tools...",
          toolCalls: [
            {
              id: "tool-call-search",
              name: "search_files",
              args: { query: "test" },
              result: { agent_id: "not-a-real-agent", status: "completed" },
            },
            {
              id: "tool-call-team",
              name: "create_subagents",
              args: { name: "Real_Team", members: [] },
              result: [
                {
                  agent_id: "real-agent",
                  description: "Real sub-agent",
                  status: "completed",
                  recursionDepth: 1,
                  durationMilliseconds: 500,
                  toolUses: 1,
                  result: "Real result",
                },
              ],
            },
          ],
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(1);
      expect(metrics!.childResults).toHaveLength(1);
      expect(metrics!.childResults![0].agent_id).toBe("real-agent");
    });

    it("HierarchicalRouter depth-2 scenario: children report grandchild subtreeMetrics", async () => {
      const router = new HierarchicalRouter();
      const members = [
        { description: "Coordinator-A", prompt: "Handle frontend module" },
        { description: "Coordinator-B", prompt: "Handle backend module" },
      ];

      const subtreeMetricsA: SubtreeMetrics = {
        totalDescendants: 3,
        maxDepthReached: 2,
        aggregatedCost: 0.08,
        aggregatedDurationMilliseconds: 5000,
        aggregatedToolUses: 15,
        childResults: [
          { agent_id: "gc-a1", description: "React components", status: "completed", recursionDepth: 2, durationMilliseconds: 1500, toolUses: 5, cost: 0.02, result: "Components built" },
          { agent_id: "gc-a2", description: "CSS styling", status: "completed", recursionDepth: 2, durationMilliseconds: 1200, toolUses: 4, cost: 0.02, result: "Styles applied" },
          { agent_id: "gc-a3", description: "Unit tests", status: "completed", recursionDepth: 2, durationMilliseconds: 2300, toolUses: 6, cost: 0.04, result: "Tests passing" },
        ],
      };

      const subtreeMetricsB: SubtreeMetrics = {
        totalDescendants: 2,
        maxDepthReached: 2,
        aggregatedCost: 0.05,
        aggregatedDurationMilliseconds: 3000,
        aggregatedToolUses: 10,
        childResults: [
          { agent_id: "gc-b1", description: "API routes", status: "completed", recursionDepth: 2, durationMilliseconds: 1800, toolUses: 6, cost: 0.03, result: "Routes created" },
          { agent_id: "gc-b2", description: "Database models", status: "failed", recursionDepth: 2, durationMilliseconds: 1200, toolUses: 4, cost: 0.02, result: null, error: "Schema validation failed" },
        ],
      };

      spawnSubAgentMock
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Coordinator-A",
          agent_id: "coord-a",
          recursionDepth: 1,
          subtreeMetrics: subtreeMetricsA,
          result: "Frontend module complete with 3 sub-tasks",
        }))
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Coordinator-B",
          agent_id: "coord-b",
          recursionDepth: 1,
          subtreeMetrics: subtreeMetricsB,
          result: "Backend module partially complete (1 failure)",
        }));

      const results = await router.execute("depth-2-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);

      const coordinatorA = results[0] as SubAgentResult;
      expect(coordinatorA.subtreeMetrics).toBeDefined();
      expect(coordinatorA.subtreeMetrics!.totalDescendants).toBe(3);
      expect(coordinatorA.subtreeMetrics!.maxDepthReached).toBe(2);
      expect(coordinatorA.subtreeMetrics!.childResults).toHaveLength(3);

      const coordinatorB = results[1] as SubAgentResult;
      expect(coordinatorB.subtreeMetrics).toBeDefined();
      expect(coordinatorB.subtreeMetrics!.totalDescendants).toBe(2);
      expect(coordinatorB.subtreeMetrics!.childResults![1].error).toBe("Schema validation failed");
    });

    it("SequentialRouter depth-2: second step should see accumulated grandchild context from first step", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Phase-1-Coordinator", prompt: "Build the core services" },
        { description: "Phase-2-Coordinator", prompt: "Build the integration layer" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Phase-1-Coordinator",
          result: "Core services built via 2 grandchild agents",
          recursionDepth: 1,
          subtreeMetrics: {
            totalDescendants: 2,
            maxDepthReached: 2,
            aggregatedCost: 0.04,
            aggregatedDurationMilliseconds: 3000,
            aggregatedToolUses: 8,
          },
        }))
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Phase-2-Coordinator",
          result: "Integration layer connected to core services",
          recursionDepth: 1,
        }));

      const results = await router.execute("depth-2-seq", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);

      const secondCallPrompt = spawnSubAgentMock.mock.calls[1][0].prompt;
      expect(secondCallPrompt).toContain("PREVIOUS STEPS RESULTS");
      expect(secondCallPrompt).toContain("Core services built via 2 grandchild agents");
    });

    it("DivideAndConquerRouter depth-2: recursive decomposition spawns grandchild subtasks", async () => {
      const router = new DivideAndConquerRouter();
      const members = [
        { description: "Complex system", prompt: "A".repeat(400) },
      ];

      let generateCallCount = 0;
      mockGenerateText.mockImplementation(async () => {
        generateCallCount++;
        if (generateCallCount === 1) {
          return {
            text: JSON.stringify([
              { description: "Sub-A (complex)", prompt: "B".repeat(350) },
              { description: "Sub-B (simple)", prompt: "Simple leaf task" },
            ]),
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        if (generateCallCount === 2) {
          return {
            text: JSON.stringify([
              { description: "Grandchild-A1", prompt: "Leaf A1" },
              { description: "Grandchild-A2", prompt: "Leaf A2" },
            ]),
            usage: { inputTokens: 50, outputTokens: 30 },
          };
        }
        return {
          text: "Synthesized result at this level.",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      });

      await router.execute(
        "depth-2-dnc",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        continueSubAgentMock,
        { maxRecursionDepth: 2, recursionComplexityThreshold: 300 },
      );

      expect(spawnSubAgentMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(generateCallCount).toBeGreaterThanOrEqual(3);
    });

    it("CriticLoopRouter depth-2: actor spawns grandchildren, critic evaluates synthesized result", async () => {
      const router = new CriticLoopRouter();
      const members = [
        { description: "Coordinator-Actor", prompt: "Build the full-stack feature" },
        { description: "Quality-Critic", prompt: "Evaluate the feature implementation" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Coordinator-Actor",
          agent_id: "actor-coord-d2",
          result: "Feature built across frontend and backend via 2 sub-agents",
          recursionDepth: 1,
          subtreeMetrics: {
            totalDescendants: 2,
            maxDepthReached: 2,
            aggregatedCost: 0.06,
            aggregatedDurationMilliseconds: 4000,
            aggregatedToolUses: 12,
          },
        }))
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Quality-Critic",
          result: "PASS — all components properly integrated",
        }));

      const results = await router.execute(
        "depth-2-critic",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        continueSubAgentMock,
      );

      expect(results).toHaveLength(2);
      const actorResult = results[0] as SubAgentResult;
      expect(actorResult.subtreeMetrics?.totalDescendants).toBe(2);
      expect(actorResult.subtreeMetrics?.maxDepthReached).toBe(2);
    });
  });

  // ── DEPTH 3: Great-grandchildren (max depth) ──────────────────

  describe("Depth 3 — Great-grandchild sub-agents (maximum recursion)", () => {
    it("extractSubtreeMetrics should recursively aggregate through 3 levels of nesting", () => {
      const depth3ChildResults = [
        {
          agent_id: "ggc-1",
          description: "Great-grandchild worker 1",
          status: "completed",
          result: "Leaf worker 1 output",
          recursionDepth: 3,
          durationMilliseconds: 300,
          toolUses: 2,
        },
        {
          agent_id: "ggc-2",
          description: "Great-grandchild worker 2",
          status: "completed",
          result: "Leaf worker 2 output",
          recursionDepth: 3,
          durationMilliseconds: 400,
          toolUses: 3,
        },
      ];

      const depth2SubtreeMetrics: SubtreeMetrics = {
        totalDescendants: 2,
        maxDepthReached: 3,
        aggregatedCost: 0.03,
        aggregatedDurationMilliseconds: 700,
        aggregatedToolUses: 5,
        childResults: depth3ChildResults.map((child) => ({
          ...child,
          cost: 0.015,
        })),
      };

      const depth2ChildResults = [
        {
          agent_id: "gc-coord-1",
          description: "Grandchild coordinator",
          status: "completed",
          result: "Coordinated 2 great-grandchildren",
          recursionDepth: 2,
          durationMilliseconds: 1000,
          toolUses: 4,
          subtreeMetrics: depth2SubtreeMetrics,
        },
      ];

      const depth1SubtreeMetrics: SubtreeMetrics = {
        totalDescendants: 3,
        maxDepthReached: 3,
        aggregatedCost: 0.06,
        aggregatedDurationMilliseconds: 1700,
        aggregatedToolUses: 9,
        childResults: depth2ChildResults.map((child) => ({
          ...child,
          cost: 0.03,
        })),
      };

      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify([
            {
              agent_id: "child-coord-1",
              description: "Child coordinator",
              status: "completed",
              result: "All descendant work complete",
              recursionDepth: 1,
              durationMilliseconds: 2000,
              toolUses: 6,
              subtreeMetrics: depth1SubtreeMetrics,
            },
          ]),
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      // 1 direct child + 3 nested descendants (from its subtreeMetrics)
      expect(metrics!.totalDescendants).toBe(4);
      expect(metrics!.maxDepthReached).toBe(3);
      expect(metrics!.aggregatedDurationMilliseconds).toBe(2000 + 1700); // child duration + subtree duration
      expect(metrics!.aggregatedToolUses).toBe(6 + 9);
      expect(metrics!.childResults).toHaveLength(1);
      expect(metrics!.childResults![0].subtreeMetrics).toBeDefined();
      expect(metrics!.childResults![0].subtreeMetrics!.totalDescendants).toBe(3);
      expect(metrics!.childResults![0].subtreeMetrics!.maxDepthReached).toBe(3);
    });

    it("should correctly propagate depth-3 subtreeMetrics through HierarchicalRouter results", async () => {
      const router = new HierarchicalRouter();
      const members = [
        { description: "Top-Coordinator", prompt: "Build the entire system" },
      ];

      const greatGrandchildMetrics: SubtreeMetrics = {
        totalDescendants: 2,
        maxDepthReached: 3,
        aggregatedCost: 0.02,
        aggregatedDurationMilliseconds: 600,
        aggregatedToolUses: 4,
        childResults: [
          { agent_id: "ggc-x", description: "GGC-X", status: "completed", recursionDepth: 3, durationMilliseconds: 300, toolUses: 2, cost: 0.01, result: "Leaf X done" },
          { agent_id: "ggc-y", description: "GGC-Y", status: "completed", recursionDepth: 3, durationMilliseconds: 300, toolUses: 2, cost: 0.01, result: "Leaf Y done" },
        ],
      };

      const grandchildMetrics: SubtreeMetrics = {
        totalDescendants: 3,
        maxDepthReached: 3,
        aggregatedCost: 0.05,
        aggregatedDurationMilliseconds: 1600,
        aggregatedToolUses: 10,
        childResults: [
          {
            agent_id: "gc-coord",
            description: "GC-Coordinator",
            status: "completed",
            recursionDepth: 2,
            durationMilliseconds: 1000,
            toolUses: 6,
            cost: 0.03,
            result: "Coordinated great-grandchildren",
            subtreeMetrics: greatGrandchildMetrics,
          },
        ],
      };

      spawnSubAgentMock.mockResolvedValueOnce(
        createSubAgentResult({
          description: "Top-Coordinator",
          agent_id: "top-coord",
          recursionDepth: 1,
          result: "Entire system built across 3 levels of sub-agents",
          subtreeMetrics: grandchildMetrics,
        }),
      );

      const results = await router.execute("depth-3-hier", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(1);
      const topResult = results[0] as SubAgentResult;
      expect(topResult.subtreeMetrics).toBeDefined();
      expect(topResult.subtreeMetrics!.maxDepthReached).toBe(3);
      expect(topResult.subtreeMetrics!.totalDescendants).toBe(3);
      expect(topResult.subtreeMetrics!.childResults![0].subtreeMetrics).toBeDefined();
      expect(topResult.subtreeMetrics!.childResults![0].subtreeMetrics!.totalDescendants).toBe(2);
    });

    it("DivideAndConquerRouter depth-3: triple-recursive decomposition should cap at maximum depth", async () => {
      const router = new DivideAndConquerRouter();
      const members = [
        { description: "Mega-complex task", prompt: "Z".repeat(500) },
      ];

      let decompositionCallCount = 0;
      mockGenerateText.mockImplementation(async () => {
        decompositionCallCount++;
        if (decompositionCallCount <= 7) {
          return {
            text: JSON.stringify([
              { description: `Level-${decompositionCallCount}-A`, prompt: "X".repeat(400) },
              { description: `Level-${decompositionCallCount}-B`, prompt: "Y".repeat(400) },
            ]),
            usage: { inputTokens: 50, outputTokens: 30 },
          };
        }
        return {
          text: "Final synthesis at this level.",
          usage: { inputTokens: 50, outputTokens: 30 },
        };
      });

      await router.execute(
        "depth-3-dnc",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        continueSubAgentMock,
        { maxRecursionDepth: 3, recursionComplexityThreshold: 100 },
      );

      // The tree must be bounded at maxRecursionDepth=3 (configured limit)
      expect(spawnSubAgentMock.mock.calls.length).toBeLessThanOrEqual(50);
      expect(decompositionCallCount).toBeGreaterThanOrEqual(4);
    });

    it("should aggregate tool uses correctly across 3 levels of nesting with mixed failures", () => {
      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify([
            {
              agent_id: "depth1-coord",
              description: "Depth-1 Coordinator",
              status: "completed",
              recursionDepth: 1,
              durationMilliseconds: 5000,
              toolUses: 10,
              result: "Coordinated 2 sub-teams",
              subtreeMetrics: {
                totalDescendants: 5,
                maxDepthReached: 3,
                aggregatedCost: 0.12,
                aggregatedDurationMilliseconds: 8000,
                aggregatedToolUses: 25,
                childResults: [
                  {
                    agent_id: "depth2-a",
                    description: "Depth-2A",
                    status: "completed",
                    recursionDepth: 2,
                    durationMilliseconds: 3000,
                    toolUses: 8,
                    cost: 0.04,
                    result: "Sub-team A output",
                    subtreeMetrics: {
                      totalDescendants: 2,
                      maxDepthReached: 3,
                      aggregatedCost: 0.04,
                      aggregatedDurationMilliseconds: 4000,
                      aggregatedToolUses: 12,
                    },
                  },
                  {
                    agent_id: "depth2-b",
                    description: "Depth-2B",
                    status: "failed",
                    recursionDepth: 2,
                    durationMilliseconds: 1000,
                    toolUses: 5,
                    cost: 0.02,
                    error: "Timeout after 60s",
                    subtreeMetrics: {
                      totalDescendants: 1,
                      maxDepthReached: 3,
                      aggregatedCost: 0.02,
                      aggregatedDurationMilliseconds: 1000,
                      aggregatedToolUses: 5,
                    },
                  },
                ],
              },
            },
          ]),
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      // 1 direct child (depth1-coord) + 5 nested descendants
      expect(metrics!.totalDescendants).toBe(6);
      expect(metrics!.maxDepthReached).toBe(3);
      // Direct child: 5000 + nested: 8000
      expect(metrics!.aggregatedDurationMilliseconds).toBe(13000);
      // Direct child: 10 + nested: 25
      expect(metrics!.aggregatedToolUses).toBe(35);

      const depth2AChild = metrics!.childResults![0].subtreeMetrics!.childResults![0];
      expect(depth2AChild.status).toBe("completed");
      expect(depth2AChild.subtreeMetrics!.totalDescendants).toBe(2);

      const depth2BChild = metrics!.childResults![0].subtreeMetrics!.childResults![1];
      expect(depth2BChild.status).toBe("failed");
      expect(depth2BChild.error).toBe("Timeout after 60s");
    });
  });

  // ── CROSS-TOPOLOGY: All routers handle depth-2 subtreeMetrics ──

  describe("Cross-topology subtreeMetrics propagation", () => {
    const childWithGrandchildren = (description: string, agentId: string): SubAgentResult =>
      createSubAgentResult({
        description,
        agent_id: agentId,
        recursionDepth: 1,
        result: `${description} done with grandchildren`,
        subtreeMetrics: {
          totalDescendants: 2,
          maxDepthReached: 2,
          aggregatedCost: 0.04,
          aggregatedDurationMilliseconds: 2000,
          aggregatedToolUses: 8,
          childResults: [
            { agent_id: `${agentId}-gc1`, description: `${description} GC1`, status: "completed", recursionDepth: 2, durationMilliseconds: 1000, toolUses: 4, cost: 0.02, result: "GC1 done" },
            { agent_id: `${agentId}-gc2`, description: `${description} GC2`, status: "completed", recursionDepth: 2, durationMilliseconds: 1000, toolUses: 4, cost: 0.02, result: "GC2 done" },
          ],
        },
      });

    it("HierarchicalAggregationRouter preserves subtreeMetrics through synthesis pass", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Frontend-Team", prompt: "Build frontend" },
        { description: "Backend-Team", prompt: "Build backend" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(childWithGrandchildren("Frontend-Team", "fe-team"))
        .mockResolvedValueOnce(childWithGrandchildren("Backend-Team", "be-team"));

      const results = await router.execute("cross-topo-agg", members, orchestratorContext, spawnSubAgentMock);

      expect(results.length).toBeGreaterThanOrEqual(2);
      const frontendResult = results[0] as SubAgentResult;
      expect(frontendResult.subtreeMetrics).toBeDefined();
      expect(frontendResult.subtreeMetrics!.totalDescendants).toBe(2);
    });

    it("SequentialRouter preserves subtreeMetrics on each step result", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Phase-1", prompt: "Build infrastructure" },
        { description: "Phase-2", prompt: "Build application layer" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(childWithGrandchildren("Phase-1", "phase1"))
        .mockResolvedValueOnce(childWithGrandchildren("Phase-2", "phase2"));

      const results = await router.execute("cross-topo-seq", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      for (const result of results) {
        const agentResult = result as SubAgentResult;
        expect(agentResult.subtreeMetrics).toBeDefined();
        expect(agentResult.subtreeMetrics!.totalDescendants).toBe(2);
      }
    });

    it("TournamentRouter preserves subtreeMetrics on candidate results", async () => {
      const router = new TournamentRouter();
      const members = [
        { description: "Approach-Alpha", prompt: "Implement via approach A" },
        { description: "Approach-Beta", prompt: "Implement via approach B" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(childWithGrandchildren("Approach-Alpha", "alpha"))
        .mockResolvedValueOnce(childWithGrandchildren("Approach-Beta", "beta"));

      mockGenerateText.mockResolvedValueOnce({
        text: "**Winner:** Sub-Agent #1\n**Justification:** Alpha approach is more maintainable.",
        usage: { inputTokens: 200, outputTokens: 80 },
      });

      const results = await router.execute("cross-topo-tourn", members, orchestratorContext, spawnSubAgentMock, continueSubAgentMock);

      expect(results).toHaveLength(3);
      const alphaResult = results[0] as SubAgentResult;
      expect(alphaResult.subtreeMetrics?.totalDescendants).toBe(2);
    });

    it("PeerToPeerRouter preserves subtreeMetrics through round-robin turns", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Lead", description: "Team Lead", prompt: "Coordinate the implementation" },
        { agent: "Dev", description: "Developer", prompt: "Execute the implementation" },
      ];

      spawnSubAgentMock
        .mockResolvedValueOnce(childWithGrandchildren("Team Lead", "lead-1"))
        .mockResolvedValueOnce(createSubAgentResult({
          description: "Developer",
          agent_id: "dev-1",
          result: "Implementation complete. [DONE]",
        }));

      const results = await router.execute("cross-topo-p2p", members, orchestratorContext, spawnSubAgentMock, continueSubAgentMock);

      const leadResult = results.find((result) => "description" in result && result.description === "Team Lead") as SubAgentResult;
      expect(leadResult?.subtreeMetrics?.totalDescendants).toBe(2);
    });
  });

  // ── EDGE CASES: Failure propagation through depth ──────────────

  describe("Failure propagation through multi-depth hierarchies", () => {
    it("should propagate errors from depth-3 great-grandchild through metrics chain", () => {
      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify({
            agent_id: "child-1",
            description: "Top coordinator",
            status: "completed",
            recursionDepth: 1,
            durationMilliseconds: 3000,
            toolUses: 5,
            result: "Partial success with nested failures",
            subtreeMetrics: {
              totalDescendants: 3,
              maxDepthReached: 3,
              aggregatedCost: 0.05,
              aggregatedDurationMilliseconds: 6000,
              aggregatedToolUses: 15,
              childResults: [
                {
                  agent_id: "gc-ok",
                  description: "Healthy grandchild",
                  status: "completed",
                  recursionDepth: 2,
                  durationMilliseconds: 2000,
                  toolUses: 5,
                  cost: 0.02,
                  result: "Grandchild completed successfully",
                },
                {
                  agent_id: "gc-fail",
                  description: "Failing grandchild",
                  status: "failed",
                  recursionDepth: 2,
                  durationMilliseconds: 1000,
                  toolUses: 3,
                  cost: 0.01,
                  error: "Provider returned 429: Rate limit exceeded",
                  subtreeMetrics: {
                    totalDescendants: 1,
                    maxDepthReached: 3,
                    aggregatedCost: 0.01,
                    aggregatedDurationMilliseconds: 500,
                    aggregatedToolUses: 2,
                    childResults: [
                      {
                        agent_id: "ggc-crash",
                        description: "Crashed great-grandchild",
                        status: "failed",
                        recursionDepth: 3,
                        durationMilliseconds: 500,
                        toolUses: 2,
                        cost: 0.01,
                        error: "CUDA out of memory",
                      },
                    ],
                  },
                },
              ],
            },
          }),
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(4);
      expect(metrics!.maxDepthReached).toBe(3);

      const failingGrandchild = metrics!.childResults![0].subtreeMetrics!.childResults![1];
      expect(failingGrandchild.error).toBe("Provider returned 429: Rate limit exceeded");
      expect(failingGrandchild.subtreeMetrics!.childResults![0].error).toBe("CUDA out of memory");
    });

    it("should handle mixed success/failure results across all 3 depths", () => {
      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify([
            {
              agent_id: "d1-success",
              description: "Depth-1 Success",
              status: "completed",
              recursionDepth: 1,
              durationMilliseconds: 2000,
              toolUses: 5,
              result: "First coordinator succeeded",
            },
            {
              agent_id: "d1-partial",
              description: "Depth-1 Partial",
              status: "completed",
              recursionDepth: 1,
              durationMilliseconds: 4000,
              toolUses: 8,
              result: "Second coordinator had mixed results",
              subtreeMetrics: {
                totalDescendants: 2,
                maxDepthReached: 3,
                aggregatedCost: 0.04,
                aggregatedDurationMilliseconds: 3000,
                aggregatedToolUses: 10,
                childResults: [
                  {
                    agent_id: "d2-ok",
                    description: "Depth-2 Success",
                    status: "completed",
                    recursionDepth: 2,
                    durationMilliseconds: 1500,
                    toolUses: 5,
                    cost: 0.02,
                    result: "Subtask completed",
                  },
                  {
                    agent_id: "d2-fail",
                    description: "Depth-2 Failure",
                    status: "failed",
                    recursionDepth: 2,
                    durationMilliseconds: 1500,
                    toolUses: 5,
                    cost: 0.02,
                    error: "Context window exceeded",
                  },
                ],
              },
            },
          ]),
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(4); // 2 direct + 2 nested from d1-partial
      expect(metrics!.childResults).toHaveLength(2);
      expect(metrics!.childResults![0].subtreeMetrics).toBeUndefined();
      expect(metrics!.childResults![1].subtreeMetrics).toBeDefined();
      expect(metrics!.childResults![1].subtreeMetrics!.childResults![1].error).toBe("Context window exceeded");
    });

    it("should handle empty subtreeMetrics (no grandchildren) at depth 2", () => {
      const messages: ConversationMessage[] = [
        {
          role: "tool",
          content: JSON.stringify({
            agent_id: "leaf-agent",
            description: "Leaf worker",
            status: "completed",
            recursionDepth: 2,
            durationMilliseconds: 800,
            toolUses: 3,
            result: "Completed task without spawning",
          }),
        },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(1);
      expect(metrics!.maxDepthReached).toBe(2);
      expect(metrics!.childResults![0].subtreeMetrics).toBeUndefined();
    });

    it("should handle multiple tool result messages across the conversation", () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Build the system" },
        { role: "assistant", content: "Spawning first team..." },
        {
          role: "tool",
          content: JSON.stringify({
            agent_id: "first-child",
            description: "First batch",
            status: "completed",
            recursionDepth: 1,
            durationMilliseconds: 1000,
            toolUses: 3,
            result: "Batch 1 done",
          }),
        },
        { role: "assistant", content: "Spawning second team..." },
        {
          role: "tool",
          content: JSON.stringify({
            agent_id: "second-child",
            description: "Second batch",
            status: "completed",
            recursionDepth: 1,
            durationMilliseconds: 2000,
            toolUses: 5,
            result: "Batch 2 done",
          }),
        },
        { role: "assistant", content: "All done." },
      ];

      const metrics = extractSubtreeMetrics(messages);

      expect(metrics).not.toBeNull();
      expect(metrics!.totalDescendants).toBe(2);
      expect(metrics!.childResults).toHaveLength(2);
      expect(metrics!.childResults![0].agent_id).toBe("first-child");
      expect(metrics!.childResults![1].agent_id).toBe("second-child");
    });
  });

  // ── buildSubAgentResult integration with deep metrics ─────────

  describe("buildSubAgentResult with multi-depth subtreeMetrics", () => {
    it("should populate subtreeMetrics on SubAgentResult when messages contain grandchild results", () => {
      const subAgentState = {
        agentId: "parent-agent-1",
        subAgentConversationId: "sub-conv-1",
        parentAgentConversationId: "parent-conv-1",
        description: "Parent coordinator",
        branchName: null,
        worktreePath: null,
        repositoryPath: "/workspace",
        isolated: false,
        status: "complete" as const,
        output: "Coordinated two grandchildren successfully",
        toolCalls: [],
        diff: null,
        error: null,
        startedAt: Date.now() - 5000,
        durationMilliseconds: 5000,
        totalCost: null,
        usage: null,
        abortController: null,
        files: [],
        project: "test",
        username: "user",
        agent: "CODING",
        providerName: "google",
        resolvedModel: "gemini-3.5-flash",
        traceId: null,
        maxIterations: 15,
        minContextLength: null,
        parentConversationId: "root-conv",
        recursionDepth: 1,
        messages: [
          { role: "user" as const, content: "Do the task" },
          { role: "assistant" as const, content: "Spawning sub-agents..." },
          {
            role: "tool" as const,
            content: JSON.stringify([
              {
                agent_id: "grandchild-1",
                description: "GC-1",
                status: "completed",
                result: "GC-1 output",
                recursionDepth: 2,
                durationMilliseconds: 1500,
                toolUses: 4,
              },
              {
                agent_id: "grandchild-2",
                description: "GC-2",
                status: "completed",
                result: "GC-2 output",
                recursionDepth: 2,
                durationMilliseconds: 2000,
                toolUses: 6,
              },
            ]),
          },
          { role: "assistant" as const, content: "Coordinated two grandchildren successfully" },
        ],
      };

      const result = buildSubAgentResult(subAgentState as any);

      expect(result.recursionDepth).toBe(1);
      expect(result.subtreeMetrics).toBeDefined();
      expect(result.subtreeMetrics!.totalDescendants).toBe(2);
      expect(result.subtreeMetrics!.maxDepthReached).toBe(2);
      expect(result.subtreeMetrics!.aggregatedDurationMilliseconds).toBe(3500);
      expect(result.subtreeMetrics!.aggregatedToolUses).toBe(10);
    });
  });

  // ── estimateTokens utility tests ──────────────────────────────

  describe("estimateTokens utility", () => {
    it("should estimate tokens using chars/4 formula", () => {
      expect(estimateTokens(0)).toBe(0);
      expect(estimateTokens(4)).toBe(1);
      expect(estimateTokens(100)).toBe(25);
      expect(estimateTokens(401)).toBe(101);
    });

    it("should ceil fractional results", () => {
      expect(estimateTokens(1)).toBe(1);
      expect(estimateTokens(5)).toBe(2);
      expect(estimateTokens(7)).toBe(2);
    });
  });

  // ── getLastAssistantText edge cases for multi-depth ────────────

  describe("getLastAssistantText in multi-depth conversations", () => {
    it("should find text after interleaved tool results from grandchildren", () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Build the system" },
        { role: "assistant", content: "Starting team creation..." },
        {
          role: "tool",
          content: JSON.stringify({ agent_id: "gc-1", status: "completed", result: "Done" }),
        },
        { role: "assistant", content: "" },
        {
          role: "tool",
          content: JSON.stringify({ agent_id: "gc-2", status: "completed", result: "Done" }),
        },
        { role: "assistant", content: "Final synthesized report from coordinator." },
      ];

      expect(getLastAssistantText(messages)).toBe("Final synthesized report from coordinator.");
    });

    it("should skip empty assistant messages after tool results and find the last substantive one", () => {
      const messages: ConversationMessage[] = [
        { role: "assistant", content: "First real output from sub-agent" },
        {
          role: "tool",
          content: JSON.stringify({ agent_id: "gc-1", status: "completed" }),
        },
        { role: "assistant", content: "" },
        { role: "assistant", content: "   " },
      ];

      expect(getLastAssistantText(messages)).toBe("First real output from sub-agent");
    });
  });

  // ── buildToolCallFallbackSummary for coordinator agents ────────

  describe("buildToolCallFallbackSummary for coordinator agents", () => {
    it("should include create_team tool usage in fallback for coordinator agents", () => {
      const coordinatorResult: SubAgentResult = {
        agent_id: "coordinator-1",
        description: "System Coordinator",
        status: "completed",
        summary: "Agent completed",
        result: null,
        toolUses: 5,
        toolNames: { create_team: 2, read_file: 3 },
        iterations: 8,
        durationMilliseconds: 15000,
        messages: [],
      };

      const fallback = buildToolCallFallbackSummary(coordinatorResult);

      expect(fallback).toContain("create_team (2×)");
      expect(fallback).toContain("read_file (3×)");
      expect(fallback).toContain("8 iterations");
    });

    it("should handle coordinator with only orchestrator tools", () => {
      const coordinatorResult: SubAgentResult = {
        agent_id: "coordinator-only",
        description: "Pure Coordinator",
        status: "completed",
        summary: "Agent completed",
        result: null,
        toolUses: 3,
        toolNames: { create_team: 1, send_message: 1, stop_agent: 1 },
        iterations: 3,
        durationMilliseconds: 5000,
        messages: [],
      };

      const fallback = buildToolCallFallbackSummary(coordinatorResult);

      expect(fallback).toContain("create_team (1×)");
      expect(fallback).toContain("send_message (1×)");
      expect(fallback).toContain("stop_agent (1×)");
    });
  });
});
