import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_PROJECT, TEST_USER, TEST_CONVERSATION_ID } from "./setup.ts";
import {
  MCTSRouter,
  computeUpperConfidenceBound,
  backpropagateScores,
  parseEvaluationResponse,
  selectNodeToExpand,
  buildEvaluationPrompt,
  buildRefinementPrompt,
  extractNodeOutput,
  type MCTSTreeNode,
} from "#src/services/orchestrator/routers/MCTSRouter";
import { MOCK_GENERATE_TEXT } from "./setup.ts";
import { getProvider } from "#src/providers/index";
import RequestLogger from "#src/services/RequestLogger";
import type {
  TeamMember,
  OrchestratorContext,
  SubAgentResult,
  OrchestratorSpawnParams,
} from "#src/types/orchestrator";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("#src/services/orchestrator/InstanceResolver", () => ({
  resolveSiblingInstances: vi.fn().mockResolvedValue({
    isLocal: false,
    siblings: [],
    instanceModelOverrides: new Map(),
    orchestratorFallback: null,
  }),
  selectInstanceForMember: vi.fn().mockImplementation((
    _member: TeamMember,
    _resolvedSiblings: unknown,
    context: { providerName: string; resolvedModel: string },
  ) => ({
    assignedProvider: context.providerName,
    assignedModel: context.resolvedModel,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────

function createMockNode(overrides: Partial<MCTSTreeNode> = {}): MCTSTreeNode {
  return {
    nodeIndex: 0,
    depth: 1,
    branchIndex: 0,
    result: {
      agent_id: `agent-${overrides.nodeIndex || 0}`,
      description: "mock node",
      status: "completed",
      summary: "mock",
      result: "mock-result",
      toolUses: 0,
      iterations: 1,
      durationMilliseconds: 100,
      messages: [],
    },
    score: 0.5,
    visitCount: 1,
    parentNodeIndex: null,
    childNodeIndices: [],
    isExpanded: false,
    evaluationFeedback: "",
    ...overrides,
  };
}

describe("MCTSRouter - Pure Functions", () => {
  describe("computeUpperConfidenceBound()", () => {
    it("should return Infinity when visitCount is 0", () => {
      const result = computeUpperConfidenceBound(0.5, 0, 10, 1.41);
      expect(result).toBe(Infinity);
    });

    it("should return correct UCB1 value for visited node", () => {
      const score = 0.8;
      const nodeVisitCount = 5;
      const parentVisitCount = 20;
      const explorationWeight = 1.41;
      const expectedValue = score + explorationWeight * Math.sqrt(Math.log(parentVisitCount) / nodeVisitCount);
      const result = computeUpperConfidenceBound(score, nodeVisitCount, parentVisitCount, explorationWeight);
      expect(result).toBeCloseTo(expectedValue, 5);
    });

    it("should increase UCB score with higher exploration weight for under-visited nodes", () => {
      const score = 0.8;
      const nodeVisitCount = 5;
      const parentVisitCount = 20;

      const lowExplorationUcb = computeUpperConfidenceBound(score, nodeVisitCount, parentVisitCount, 1.0);
      const highExplorationUcb = computeUpperConfidenceBound(score, nodeVisitCount, parentVisitCount, 2.0);

      expect(highExplorationUcb).toBeGreaterThan(lowExplorationUcb);
    });
  });

  describe("backpropagateScores()", () => {
    it("should update leaf and all ancestors correctly", () => {
      const initialNodes: MCTSTreeNode[] = [
        createMockNode({ nodeIndex: 0, depth: 1, childNodeIndices: [1], isExpanded: true }),
        createMockNode({ nodeIndex: 1, depth: 2, parentNodeIndex: 0, childNodeIndices: [2], isExpanded: true }),
        createMockNode({ nodeIndex: 2, depth: 3, parentNodeIndex: 1, isExpanded: false }),
      ];

      backpropagateScores(initialNodes, 2, 0.9);

      // Node 2 (leaf) should have visitCount = 2, and new score = (0.5 * 1 + 0.9) / 2 = 0.7
      expect(initialNodes[2].visitCount).toBe(2);
      expect(initialNodes[2].score).toBeCloseTo(0.7, 5);

      // Node 1 (child) should have visitCount = 2, and new score = (0.5 * 1 + 0.9) / 2 = 0.7
      expect(initialNodes[1].visitCount).toBe(2);
      expect(initialNodes[1].score).toBeCloseTo(0.7, 5);

      // Node 0 (root) should have visitCount = 2, and new score = (0.5 * 1 + 0.9) / 2 = 0.7
      expect(initialNodes[0].visitCount).toBe(2);
      expect(initialNodes[0].score).toBeCloseTo(0.7, 5);
    });

    it("should handle single-node tree", () => {
      const initialNodes: MCTSTreeNode[] = [
        createMockNode({ nodeIndex: 0, depth: 1 }),
      ];

      backpropagateScores(initialNodes, 0, 0.9);

      expect(initialNodes[0].visitCount).toBe(2);
      expect(initialNodes[0].score).toBeCloseTo(0.7, 5);
    });

    it("should handle null parentNodeIndex at root and terminate cleanly", () => {
      const initialNodes: MCTSTreeNode[] = [
        {
          nodeIndex: 0,
          depth: 1,
          branchIndex: 0,
          result: {
            agent_id: "agent-0",
            description: "root node",
            status: "completed",
            summary: "root",
            result: "root-result",
            toolUses: 0,
            iterations: 1,
            durationMilliseconds: 100,
            messages: [],
          },
          score: 0.5,
          visitCount: 1,
          parentNodeIndex: null,
          childNodeIndices: [],
          isExpanded: false,
          evaluationFeedback: "",
        },
      ];

      expect(() => backpropagateScores(initialNodes, 0, 0.9)).not.toThrow();
    });
  });

  describe("parseEvaluationResponse()", () => {
    it("should parse valid JSON response correctly", () => {
      const responseText = JSON.stringify({
        scores: [0.85, 0.72, 0.91],
        bestBranchIndex: 2,
        isComplete: false,
        feedback: "Good progress",
        branchFeedback: ["Strong", "Weak", "Best"],
      });

      const result = parseEvaluationResponse(responseText, 3);

      expect(result.scores).toEqual([0.85, 0.72, 0.91]);
      expect(result.bestBranchIndex).toBe(2);
      expect(result.isComplete).toBe(false);
      expect(result.feedback).toBe("Good progress");
      expect(result.branchFeedback).toEqual(["Strong", "Weak", "Best"]);
    });

    it("should handle markdown-fenced JSON responses", () => {
      const rawResponseText = "```json\n" + JSON.stringify({
        scores: [0.85, 0.72, 0.91],
        bestBranchIndex: 2,
        isComplete: false,
        feedback: "Good progress",
        branchFeedback: ["Strong", "Weak", "Best"],
      }) + "\n```";

      const result = parseEvaluationResponse(rawResponseText, 3);

      expect(result.scores).toEqual([0.85, 0.72, 0.91]);
      expect(result.bestBranchIndex).toBe(2);
    });

    it("should return default results on completely invalid input", () => {
      const result = parseEvaluationResponse("not json at all", 2);

      expect(result.scores).toEqual([0.5, 0.5]);
      expect(result.bestBranchIndex).toBe(0);
      expect(result.isComplete).toBe(false);
      expect(result.feedback).toBe("");
      expect(result.branchFeedback).toEqual(["", ""]);
    });

    it("should extract JSON from mixed content via regex fallback", () => {
      const mixedText = "Here's my evaluation:\n{\n  \"scores\": [0.9],\n  \"bestBranchIndex\": 0,\n  \"isComplete\": true,\n  \"feedback\": \"Excellent\"\n}\nHave a nice day!";

      const result = parseEvaluationResponse(mixedText, 1);

      expect(result.scores).toEqual([0.9]);
      expect(result.bestBranchIndex).toBe(0);
      expect(result.isComplete).toBe(true);
      expect(result.feedback).toBe("Excellent");
    });

    it("should clamp scores to [0.0, 1.0] range", () => {
      const responseText = JSON.stringify({
        scores: [1.5, -0.3, 0.8],
        bestBranchIndex: 2,
      });

      const result = parseEvaluationResponse(responseText, 3);

      expect(result.scores).toEqual([1.0, 0.0, 0.8]);
    });

    it("should default bestBranchIndex to index of the highest score if omitted", () => {
      const responseText = JSON.stringify({
        scores: [0.6, 0.9, 0.7],
      });

      const result = parseEvaluationResponse(responseText, 3);

      expect(result.bestBranchIndex).toBe(1);
    });
  });

  describe("selectNodeToExpand()", () => {
    it("should select unexpanded node with highest UCB score", () => {
      const allTreeNodes: MCTSTreeNode[] = [
        {
          nodeIndex: 0,
          depth: 1,
          branchIndex: 0,
          result: {} as any,
          score: 0.5,
          visitCount: 1,
          parentNodeIndex: null,
          childNodeIndices: [1, 2],
          isExpanded: true,
          evaluationFeedback: "",
        },
        {
          nodeIndex: 1,
          depth: 2,
          branchIndex: 0,
          result: {} as any,
          score: 0.6,
          visitCount: 1,
          parentNodeIndex: 0,
          childNodeIndices: [],
          isExpanded: false,
          evaluationFeedback: "",
        },
        {
          nodeIndex: 2,
          depth: 2,
          branchIndex: 1,
          result: {} as any,
          score: 0.8,
          visitCount: 1,
          parentNodeIndex: 0,
          childNodeIndices: [],
          isExpanded: false,
          evaluationFeedback: "",
        },
      ];

      const result = selectNodeToExpand(allTreeNodes, [1, 2], 1.41, 3);
      expect(result).toBe(2);
    });

    it("should descend into expanded node's children", () => {
      const allTreeNodes: MCTSTreeNode[] = [
        {
          nodeIndex: 0,
          depth: 1,
          branchIndex: 0,
          result: {} as any,
          score: 0.5,
          visitCount: 2,
          parentNodeIndex: null,
          childNodeIndices: [1],
          isExpanded: true,
          evaluationFeedback: "",
        },
        {
          nodeIndex: 1,
          depth: 2,
          branchIndex: 0,
          result: {} as any,
          score: 0.8,
          visitCount: 2,
          parentNodeIndex: 0,
          childNodeIndices: [2],
          isExpanded: true,
          evaluationFeedback: "",
        },
        {
          nodeIndex: 2,
          depth: 3,
          branchIndex: 0,
          result: {} as any,
          score: 0.9,
          visitCount: 1,
          parentNodeIndex: 1,
          childNodeIndices: [],
          isExpanded: false,
          evaluationFeedback: "",
        },
      ];

      const result = selectNodeToExpand(allTreeNodes, [1], 1.41, 4);
      expect(result).toBe(2);
    });

    it("should return null when all nodes are fully explored or exceed maximum depth", () => {
      const allTreeNodes: MCTSTreeNode[] = [
        {
          nodeIndex: 0,
          depth: 1,
          branchIndex: 0,
          result: {} as any,
          score: 0.5,
          visitCount: 1,
          parentNodeIndex: null,
          childNodeIndices: [1],
          isExpanded: true,
          evaluationFeedback: "",
        },
        {
          nodeIndex: 1,
          depth: 2,
          branchIndex: 0,
          result: {} as any,
          score: 0.8,
          visitCount: 1,
          parentNodeIndex: 0,
          childNodeIndices: [],
          isExpanded: true,
          evaluationFeedback: "",
        },
      ];

      const result = selectNodeToExpand(allTreeNodes, [1], 1.41, 2);
      expect(result).toBe(null);
    });

    it("should return null for empty candidateIndices", () => {
      const result = selectNodeToExpand([], [], 1.41, 3);
      expect(result).toBe(null);
    });
  });

  describe("buildEvaluationPrompt() / buildRefinementPrompt() / extractNodeOutput()", () => {
    it("should build evaluation prompt including all branch sections", () => {
      const candidates = [
        { branchIndex: 0, output: "Branch 1 output" },
        { branchIndex: 1, output: "Branch 2 output" },
      ];
      const prompt = buildEvaluationPrompt("Implement feature X", candidates, 1, 3);

      expect(prompt).toContain("Branch 1");
      expect(prompt).toContain("Branch 2");
      expect(prompt).toContain("Branch 1 output");
      expect(prompt).toContain("Branch 2 output");
      expect(prompt).toContain("Implement feature X");
    });

    it("should truncate long candidate outputs inside buildEvaluationPrompt", () => {
      const longOutput = "a".repeat(70000);
      const candidates = [
        { branchIndex: 0, output: longOutput },
        { branchIndex: 1, output: "short" },
      ];
      const prompt = buildEvaluationPrompt("Implement feature X", candidates, 1, 3);

      expect(prompt).toContain("truncated");
    });

    it("should build refinement prompt with previous output and feedback", () => {
      const prompt = buildRefinementPrompt(
        "Implement feature X",
        "Previous execution text",
        "Add error handling",
        2,
        4,
      );

      expect(prompt).toContain("Implement feature X");
      expect(prompt).toContain("Previous execution text");
      expect(prompt).toContain("Add error handling");
      expect(prompt).toContain("iteration 2 of 4");
    });

    it("should extract result or fallback from SubAgentResult", () => {
      const resultA: SubAgentResult = {
        agent_id: "agent-1",
        description: "description",
        status: "completed",
        summary: "short summary",
        result: "primary result text",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      };

      expect(extractNodeOutput(resultA)).toBe("primary result text");

      const resultB: SubAgentResult = {
        agent_id: "agent-1",
        description: "description",
        status: "completed",
        summary: "short summary",
        result: "",
        toolUses: 1,
        toolNames: { test: 1 },
        iterations: 1,
        durationMilliseconds: 100,
        messages: [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "test", arguments: "{}" } }] }],
      };

      expect(extractNodeOutput(resultB)).toContain("test");

      const resultC: SubAgentResult = {
        agent_id: "agent-1",
        description: "description",
        status: "completed",
        summary: "fallback summary",
        result: "",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      };

      expect(extractNodeOutput(resultC)).toContain("Agent completed 1 iteration with 0 tool call(s)");

      const resultD: SubAgentResult = {
        agent_id: "agent-1",
        description: "description",
        status: "completed",
        summary: "absolute fallback summary",
        result: "",
        toolUses: 0,
        iterations: 0,
        durationMilliseconds: 100,
        messages: [],
      };

      expect(extractNodeOutput(resultD)).toBe("absolute fallback summary");
    });
  });
});

describe("MCTSRouter.execute() - Main Orchestration Loop", () => {
  let mockSpawnSubAgent: any;
  let orchestratorContext: OrchestratorContext;
  let members: TeamMember[];

  beforeEach(() => {
    vi.clearAllMocks();

    mockSpawnSubAgent = vi.fn().mockResolvedValue({
      agent_id: "agent-1",
      description: "task",
      status: "completed",
      summary: "Task done",
      result: "Success implementation",
      toolUses: 3,
      iterations: 5,
      durationMilliseconds: 1000,
      messages: [],
    });

    orchestratorContext = {
      project: TEST_PROJECT,
      username: TEST_USER,
      agent: null,
      providerName: "google",
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-123",
      agentConversationId: TEST_CONVERSATION_ID,
      conversationId: TEST_CONVERSATION_ID,
      emit: vi.fn(),
    };

    members = [
      {
        description: "Implement feature X",
        prompt: "Implement feature X with tests",
        model: undefined,
        agent: undefined,
        files: [],
      },
    ];

    MOCK_GENERATE_TEXT.mockResolvedValue({
      text: JSON.stringify({
        scores: [0.85, 0.72],
        bestBranchIndex: 0,
        isComplete: false,
        feedback: "Good progress",
        branchFeedback: ["Strong", "Weak"],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });
  });

  it("should complete a single iteration and return results including search summary", async () => {
    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 1,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Should have spawned two parallel branches (branchFactor = 2)
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);

    // Should have requested evaluation from the provider
    expect(MOCK_GENERATE_TEXT).toHaveBeenCalledTimes(1);

    // Results length should be: 2 branch results + 1 search summary result = 3
    expect(results).toHaveLength(3);

    const searchSummary = results[results.length - 1] as SubAgentResult;
    expect(searchSummary.agent_id).toContain("mcts-search");
    expect(searchSummary.summary).toContain("MCTS search explored 2 nodes");
    expect(searchSummary.result).toBe("Success implementation");
  });

  it("should perform multiple iterations with UCB1 node selection", async () => {
    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 2,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Iteration 1 spawns 2 branches.
    // Iteration 2 selects the best node (index 0) and expands it into 2 more branches.
    // Total spawn calls = 4
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(4);

    // Evaluated at both iterations
    expect(MOCK_GENERATE_TEXT).toHaveBeenCalledTimes(2);

    // Results: 4 branch results + 1 search summary = 5
    expect(results).toHaveLength(5);
  });

  it("should terminate early when the evaluator marks the solution as complete", async () => {
    MOCK_GENERATE_TEXT.mockResolvedValue({
      text: JSON.stringify({
        scores: [0.95, 0.70],
        bestBranchIndex: 0,
        isComplete: true,
        feedback: "Perfect work",
        branchFeedback: ["Excellent", "Adequate"],
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 3,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Marks complete on iteration 1, so iteration 2 and 3 should be skipped.
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
    expect(MOCK_GENERATE_TEXT).toHaveBeenCalledTimes(1);

    expect(results).toHaveLength(3);
  });

  it("should terminate early when the tree is fully explored", async () => {
    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 1, // Only root depth 1 can be expanded since maxDepth is 1
      explorationWeight: 1.41,
      searchIterations: 3,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Iteration 1: Spawns 2 branches. Nodes are created at depth 1.
    // Iteration 2: Attempts to select node to expand.
    // Since depth of candidates is 1, and maxDepth is 1, no candidate is expandable.
    // selectNodeToExpand returns null, leading to early termination.
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
  });

  it("should abort search when all branches fail in iteration 1", async () => {
    mockSpawnSubAgent.mockResolvedValue({ error: "Failed to spawn sandbox" });

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 3,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
    expect(MOCK_GENERATE_TEXT).not.toHaveBeenCalled();

    // Contains only the error results (length 2), no search summary because no nodes were added
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ error: "Failed to spawn sandbox" });
  });

  it("should handle failures at later iterations and continue searching", async () => {
    // First iteration succeeds, second fails
    mockSpawnSubAgent
      .mockResolvedValueOnce({
        agent_id: "agent-1",
        description: "task",
        status: "completed",
        summary: "Ok",
        result: "Result A",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      })
      .mockResolvedValueOnce({
        agent_id: "agent-2",
        description: "task",
        status: "completed",
        summary: "Ok",
        result: "Result B",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      })
      .mockResolvedValue({ error: "Execution failure" }); // Iteration 2 branches fail

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 2,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Iteration 1: spawns 2 branches (success).
    // Iteration 2: selectNodeToExpand selects a node, spawns 2 branches (fail).
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(4);

    // Evaluated only on iteration 1
    expect(MOCK_GENERATE_TEXT).toHaveBeenCalledTimes(1);

    // 4 branch results + 1 search summary (based on successful iteration 1 nodes) = 5
    expect(results).toHaveLength(5);
  });

  it("should handle evaluation LLM failure, apply default scores, and continue", async () => {
    MOCK_GENERATE_TEXT.mockRejectedValue(new Error("LLM Rate limit reached"));

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 2,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 2,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    // Loop should continue despite the evaluation throw
    expect(mockSpawnSubAgent).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(5);
  });

  it("should select the highest-scoring node across the whole tree as final result", async () => {
    // We will run 2 iterations, with 1 branch each.
    // Iteration 1: branch 1 receives score 0.7
    // Iteration 2: branch 2 receives score 0.6 (worse than iteration 1)
    mockSpawnSubAgent
      .mockResolvedValueOnce({
        agent_id: "agent-1",
        description: "task",
        status: "completed",
        summary: "Ok",
        result: "Highest Score Output",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      })
      .mockResolvedValueOnce({
        agent_id: "agent-2",
        description: "task",
        status: "completed",
        summary: "Ok",
        result: "Lower Score Output",
        toolUses: 0,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      });

    MOCK_GENERATE_TEXT
      .mockResolvedValueOnce({
        text: JSON.stringify({ scores: [0.7], bestBranchIndex: 0, isComplete: false }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ scores: [0.6], bestBranchIndex: 0, isComplete: false }),
        usage: { inputTokens: 10, outputTokens: 5 },
      });

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 1,
      maxDepth: 3,
      explorationWeight: 1.41,
      searchIterations: 2,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    const searchSummary = results[results.length - 1] as SubAgentResult;
    // Final result output should correspond to branch 1 (score 0.7) rather than branch 2 (score 0.6)
    expect(searchSummary.result).toBe("Highest Score Output");
  });

  it("should return error when provider is not found", async () => {
    const invalidContext = {
      ...orchestratorContext,
      providerName: "nonexistent",
    };

    // Temporarily mock getProvider to return undefined for this test
    vi.mocked(getProvider).mockReturnValueOnce(undefined as any);

    const router = new MCTSRouter();
    const results = await router.execute(
      "test-team",
      members,
      invalidContext,
      mockSpawnSubAgent,
    );

    expect(results).toEqual([{ error: 'Provider "nonexistent" not found' }]);
  });

  it("should handle request logging failure gracefully", async () => {
    const logBackgroundLlmCallSpy = vi.spyOn(RequestLogger, "logBackgroundLlmCall").mockRejectedValueOnce(new Error("Database write failed"));

    const router = new MCTSRouter();
    const topologyConfig = {
      branchFactor: 1,
      maxDepth: 1,
      searchIterations: 1,
    };

    const results = await router.execute(
      "test-team",
      members,
      orchestratorContext,
      mockSpawnSubAgent,
      undefined,
      topologyConfig,
    );

    expect(results).toHaveLength(2);
    expect(logBackgroundLlmCallSpy).toHaveBeenCalled();
    logBackgroundLlmCallSpy.mockRestore();
  });
});
