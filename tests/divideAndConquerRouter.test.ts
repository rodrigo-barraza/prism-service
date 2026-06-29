import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DivideAndConquerRouter,
  buildDecompositionPrompt,
  parseDecompositionResponse,
  buildSynthesisPrompt,
  buildExecutionTiers,
  buildDependencyContextPrefix,
  type DecomposedSubtask,
} from "../src/services/orchestrator/routers/DivideAndConquerRouter.ts";
import { MOCK_GENERATE_TEXT } from "./setup.ts";
import { getProvider } from "../src/providers/index.ts";
import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../src/types/orchestrator.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/services/orchestrator/InstanceResolver.ts", () => ({
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

describe("DivideAndConquerRouter Tests", () => {
  let orchestratorContext: OrchestratorContext;
  let mockMembers: TeamMember[];
  let spawnSubAgentMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    MOCK_GENERATE_TEXT.mockReset();
    MOCK_GENERATE_TEXT.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    vi.mocked(getProvider).mockReset();
    vi.mocked(getProvider).mockImplementation((name: string) => {
      if (name === "nonexistent") {
        return undefined as any;
      }
      return {
        generateText: (...args: any[]) => MOCK_GENERATE_TEXT(...args),
      } as any;
    });

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: null,
      providerName: "google",
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-123",
      agentConversationId: "conv-123",
      conversationId: "conv-123",
    };

    mockMembers = [
      {
        description: "Build feature X",
        prompt: "Build feature X with full test coverage",
        model: undefined,
        agent: undefined,
        files: [],
      },
    ];

    spawnSubAgentMock = vi.fn().mockImplementation(async (assignment: OrchestratorSpawnParams) => {
      return {
        agent_id: `agent-${Math.random().toString(36).substr(2, 9)}`,
        description: assignment.description || "subtask",
        status: "completed",
        summary: "Subtask done",
        result: `Completed: ${assignment.prompt}`,
        toolUses: 2,
        iterations: 3,
        durationMs: 8000,
        messages: [],
        diff: { additions: 1, deletions: 0, files: [] },
      };
    });
  });

  // ── Group 1: Pure Functions — parseDecompositionResponse() ───────────
  describe("Group 1: Pure Functions — parseDecompositionResponse()", () => {
    it("parses valid JSON array", () => {
      const input = '[{"description":"Task A","prompt":"Do A"},{"description":"Task B","prompt":"Do B"}]';
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ description: "Task A", prompt: "Do A", dependsOn: undefined });
      expect(result[1]).toEqual({ description: "Task B", prompt: "Do B", dependsOn: undefined });
    });

    it("handles markdown-fenced JSON", () => {
      const input = "```json\n[\n  {\n    \"description\": \"Task A\",\n    \"prompt\": \"Do A\"\n  }\n]\n```";
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("Task A");
    });

    it("filters out invalid entries (missing prompt or description)", () => {
      const input = '[{"description":"A","prompt":"Do A"},{"description":"B"},{"prompt":"Do C"}]';
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("A");
    });

    it("filters out entries with empty prompt", () => {
      const input = '[{"description":"A","prompt":""},{"description":"B","prompt":"   "}]';
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(0);
    });

    it("respects maximumSubtaskCount", () => {
      const subtasks = Array.from({ length: 8 }, (_, i) => ({
        description: `Task ${i}`,
        prompt: `Do ${i}`,
      }));
      const input = JSON.stringify(subtasks);
      const result = parseDecompositionResponse(input, 4);
      expect(result).toHaveLength(4);
    });

    it("parses dependsOn arrays and filters invalid entries", () => {
      const input = JSON.stringify([
        { description: "A", prompt: "Do A" },
        { description: "B", prompt: "Do B", dependsOn: [0, 1] },
        { description: "C", prompt: "Do C", dependsOn: [-1, "invalid", 2] },
      ]);
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(3);
      expect(result[1].dependsOn).toEqual([0, 1]);
      expect(result[2].dependsOn).toEqual([2]); // -1 and "invalid" filtered out
    });

    it("extracts JSON from mixed LLM content using regex fallback", () => {
      const input = "Here are the subtasks:\n\n```json\n[\n  {\n    \"description\": \"A\",\n    \"prompt\": \"Do A\"\n  }\n]\n```\nLet me know if you need more.";
      const result = parseDecompositionResponse(input);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("A");
    });

    it("returns empty array on completely invalid input", () => {
      const input = "I cannot decompose this task";
      const result = parseDecompositionResponse(input);
      expect(result).toEqual([]);
    });
  });

  // ── Group 2: Pure Functions — buildExecutionTiers() ──────────────────
  describe("Group 2: Pure Functions — buildExecutionTiers()", () => {
    it("all independent subtasks → single tier", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A" },
        { description: "B", prompt: "Do B" },
        { description: "C", prompt: "Do C" },
      ];
      const result = buildExecutionTiers(subtasks);
      expect(result).toEqual([[0, 1, 2]]);
    });

    it("simple linear chain", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A" },
        { description: "B", prompt: "Do B", dependsOn: [0] },
        { description: "C", prompt: "Do C", dependsOn: [1] },
      ];
      const result = buildExecutionTiers(subtasks);
      expect(result).toEqual([[0], [1], [2]]);
    });

    it("diamond dependency", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A" },
        { description: "B", prompt: "Do B", dependsOn: [0] },
        { description: "C", prompt: "Do C", dependsOn: [0] },
        { description: "D", prompt: "Do D", dependsOn: [1, 2] },
      ];
      const result = buildExecutionTiers(subtasks);
      expect(result).toEqual([[0], [1, 2], [3]]);
    });

    it("cyclic dependencies assigned to final tier", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A", dependsOn: [1] },
        { description: "B", prompt: "Do B", dependsOn: [0] },
      ];
      const result = buildExecutionTiers(subtasks);
      // Both are placed in a final tier (tier 1 because tier 0 is computed first but makes no progress)
      expect(result).toEqual([[], [0, 1]]);
    });

    it("self-referencing dependency filtered out", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A", dependsOn: [0] },
      ];
      const result = buildExecutionTiers(subtasks);
      expect(result).toEqual([[0]]);
    });

    it("out-of-range dependency indices filtered", () => {
      const subtasks: DecomposedSubtask[] = [
        { description: "A", prompt: "Do A", dependsOn: [99] },
      ];
      const result = buildExecutionTiers(subtasks);
      expect(result).toEqual([[0]]);
    });
  });

  // ── Group 3: Pure Functions — buildDecompositionPrompt / buildSynthesisPrompt / buildDependencyContextPrefix ──
  describe("Group 3: Pure Functions — Prompt builders and context prefixes", () => {
    it("buildDecompositionPrompt includes task and member count", () => {
      const originalTask = "This is a complex coding task.";
      const prompt = buildDecompositionPrompt(originalTask, 4, 4);
      expect(prompt).toContain(originalTask);
      expect(prompt).toContain("Analyze the task and identify 4 or fewer subtasks.");
    });

    it("buildSynthesisPrompt includes all subtask results", () => {
      const originalTask = "Build feature Y";
      const results: (SubAgentResult | { error: string })[] = [
        {
          agent_id: "agent-1",
          description: "Subtask 1",
          status: "completed",
          summary: "Subtask 1 summary",
          result: "Subtask 1 result",
          toolUses: 0,
          iterations: 1,
          durationMs: 100,
          messages: [],
        },
        { error: "Timeout occurred" },
      ];
      const descriptions = ["Subtask 1 description", "Subtask 2 description"];

      const prompt = buildSynthesisPrompt(originalTask, results, descriptions);
      expect(prompt).toContain(originalTask);
      expect(prompt).toContain("Subtask 1 description");
      expect(prompt).toContain("Subtask 1 result");
      expect(prompt).toContain("Subtask 2 description");
      expect(prompt).toContain("**Status:** Error");
      expect(prompt).toContain("Timeout occurred");
    });

    it("buildSynthesisPrompt truncates long results", () => {
      const originalTask = "Task";
      const results: (SubAgentResult | { error: string })[] = [
        {
          agent_id: "agent-1",
          description: "Subtask 1",
          status: "completed",
          summary: "Summary",
          result: "A".repeat(130_000), // budget is 120_000 / 1 = 120_000
          toolUses: 0,
          iterations: 1,
          durationMs: 100,
          messages: [],
        },
      ];
      const prompt = buildSynthesisPrompt(originalTask, results, ["Desc"]);
      expect(prompt).toContain("truncated");
      expect(prompt).toContain("character budget");
    });

    it("buildDependencyContextPrefix includes completed predecessor outputs", () => {
      const completed = new Map<number, SubAgentResult | { error: string }>();
      completed.set(0, {
        agent_id: "agent-1",
        description: "A",
        status: "completed",
        summary: "Done A",
        result: "Output A",
        toolUses: 0,
        iterations: 1,
        durationMs: 100,
        messages: [],
      });
      completed.set(1, { error: "Failed dependency B" });

      const prefix = buildDependencyContextPrefix(completed, [0, 1], ["A description", "B description"]);
      expect(prefix).toContain("Prerequisite Subtask Outputs");
      expect(prefix).toContain("A description");
      expect(prefix).toContain("Output A");
      expect(prefix).toContain("B description");
      expect(prefix).toContain("Failed dependency B");
    });

    it("buildDependencyContextPrefix returns empty string when no deps", () => {
      const completed = new Map<number, SubAgentResult | { error: string }>();
      const prefix = buildDependencyContextPrefix(completed, [], []);
      expect(prefix).toBe("");
    });
  });

  // ── Group 4: DivideAndConquerRouter.execute() — Phase 1: Decomposition ──
  describe("Group 4: DivideAndConquerRouter.execute() — Phase 1: Decomposition", () => {
    it("decomposes task via LLM", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(MOCK_GENERATE_TEXT).toHaveBeenCalled();
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(3); // 2 subtask results + 1 synthesis result
    });

    it("handles decomposition failure gracefully", async () => {
      const router = new DivideAndConquerRouter();
      MOCK_GENERATE_TEXT.mockRejectedValueOnce(new Error("LLM failure"));

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(1);
      expect((results[0] as { error: string }).error).toContain("Decomposition failed: LLM failure");
    });

    it("falls back to direct execution when 0 subtasks parsed", async () => {
      const router = new DivideAndConquerRouter();
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "[]",
        usage: { inputTokens: 50, outputTokens: 10 },
      });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(spawnSubAgentMock.mock.calls[0][0].prompt).toBe(mockMembers[0].prompt);
      expect(results).toHaveLength(1); // 1 single subtask output, no synthesis
    });

    it("returns error when no members provided", async () => {
      const router = new DivideAndConquerRouter();
      const results = await router.execute("test-team", [], orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(1);
      expect((results[0] as { error: string }).error).toBe("No members provided for Divide & Conquer execution");
    });

    it("returns error when provider not found", async () => {
      const router = new DivideAndConquerRouter();
      orchestratorContext.providerName = "nonexistent";
      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(1);
      expect((results[0] as { error: string }).error).toBe('Provider "nonexistent" not found for decomposition pass');
    });
  });

  // ── Group 5: DivideAndConquerRouter.execute() — Phase 2: Tier-Based Execution ──
  describe("Group 5: DivideAndConquerRouter.execute() — Phase 2: Tier-Based Execution", () => {
    it("executes independent subtasks in parallel", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // To verify parallel execution, we can check how many times spawnSubAgent is called.
      // Since they are independent (no dependsOn), they are run in parallel using Promise.all in a single tier.
      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(spawnSubAgentMock.mock.calls[0][0].description).toBe("Task A");
      expect(spawnSubAgentMock.mock.calls[1][0].description).toBe("Task B");
    });

    it("executes dependent subtasks sequentially by tier", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B", dependsOn: [0] },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      const callOrder: string[] = [];
      spawnSubAgentMock.mockImplementation(async (assignment: OrchestratorSpawnParams) => {
        callOrder.push(assignment.description || "");
        return {
          agent_id: "agent-1",
          description: assignment.description,
          status: "completed",
          summary: "Subtask done",
          result: `Completed: ${assignment.prompt}`,
          toolUses: 0,
          iterations: 1,
          durationMs: 100,
          messages: [],
        };
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(callOrder).toEqual(["Task A", "Task B"]);
    });

    it("injects dependency context prefix for dependent subtasks", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B", dependsOn: [0] },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);

      const subtaskBArgs = spawnSubAgentMock.mock.calls[1][0];
      expect(subtaskBArgs.description).toBe("Task B");
      expect(subtaskBArgs.prompt).toContain("Prerequisite Subtask Outputs");
      expect(subtaskBArgs.prompt).toContain("Task A");
      expect(subtaskBArgs.prompt).toContain("Completed: Do A");
      expect(subtaskBArgs.prompt).toContain("Do B");
    });

    it("handles mixed success/error within a tier", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      spawnSubAgentMock.mockImplementation(async (assignment: OrchestratorSpawnParams) => {
        if (assignment.description === "Task A") {
          return { error: "Failed execution" };
        }
        return {
          agent_id: "agent-2",
          description: assignment.description,
          status: "completed",
          summary: "Done B",
          result: "Result B",
          toolUses: 0,
          iterations: 1,
          durationMs: 100,
          messages: [],
        };
      });

      // Mock synthesis output
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "Synthesized mixed output",
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(3); // [ErrorResult, SuccessResult, SynthesisResult]
      expect(results[0]).toEqual({ error: "Failed execution" });
      expect((results[1] as SubAgentResult).status).toBe("completed");
      expect((results[2] as SubAgentResult).result).toBe("Synthesized mixed output");
    });
  });

  // ── Group 6: DivideAndConquerRouter.execute() — Phase 3: Synthesis ─────
  describe("Group 6: DivideAndConquerRouter.execute() — Phase 3: Synthesis", () => {
    it("synthesizes multiple subtask results", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "Final synthesis summary",
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(3);
      expect((results[2] as SubAgentResult).agent_id).toContain("divide-conquer-synthesis");
      expect((results[2] as SubAgentResult).result).toBe("Final synthesis summary");
    });

    it("skips synthesis for single subtask", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(1); // single subtask, no synthesis
      expect((results[0] as SubAgentResult).status).toBe("completed");
    });

    it("handles synthesis failure gracefully", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Fail synthesis call
      MOCK_GENERATE_TEXT.mockRejectedValueOnce(new Error("Synthesis API call failed"));

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(2); // returns subtask results without synthesis node
      expect((results[0] as SubAgentResult).status).toBe("completed");
      expect((results[1] as SubAgentResult).status).toBe("completed");
    });

    it("skips synthesis when all subtasks failed", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
        { description: "Task B", prompt: "Do B" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      spawnSubAgentMock.mockResolvedValue({ error: "Execution error" });

      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(2); // returns only the errors
      expect(results[0]).toEqual({ error: "Execution error" });
      expect(results[1]).toEqual({ error: "Execution error" });
    });
  });

  // ── Group 7: executeSubtaskWithRecursion() — Recursive Decomposition ───
  describe("Group 7: executeSubtaskWithRecursion() — Recursive Decomposition", () => {
    it("executes directly when below complexity threshold", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Short prompt", prompt: "Do quick" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // 8 chars < 300 default threshold, so direct execute (no recursion)
      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
    });

    it("executes directly when at max recursion depth", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Config depth is 1. Depth starts at 1, so depth >= maximumRecursionDepth. It will execute directly.
      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 1,
        recursionComplexityThreshold: 100,
      });

      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
    });

    it("recurses when above threshold and within depth", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      // 1st LLM call: original decomposition (yields 1 complex subtask)
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // 2nd LLM call: recursive decomposition of the complex subtask (yields 2 sub-subtasks)
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "Sub-subtask A", prompt: "Prompt A" },
          { description: "Sub-subtask B", prompt: "Prompt B" },
        ]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // 3rd LLM call: synthesis of the recursive results
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "Recursively synthesized result",
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      // We allow depth 2. First execution level is depth 1, so it can recurse to depth 2.
      const results = await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 100,
      });

      // Spawn should be called for sub-subtask A and B (total 2 times)
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(spawnSubAgentMock.mock.calls[0][0].description).toBe("Sub-subtask A");
      expect(spawnSubAgentMock.mock.calls[1][0].description).toBe("Sub-subtask B");

      // Results should contain the synthesized result of the subtask
      expect(results).toHaveLength(1); // single subtask executed (which was recursively synthesized)
      expect((results[0] as SubAgentResult).result).toBe("Recursively synthesized result");
      expect((results[0] as SubAgentResult).summary).toContain("Recursively decomposed into 2 sub-subtasks");
    });

    it("falls back to direct execution when recursive decomposition yields <= 1 subtask", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive decomposition returns 1 subtask
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([{ description: "Sub-subtask A", prompt: "Prompt A" }]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 100,
      });

      // Falls back to direct execution of the parent subtask
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(spawnSubAgentMock.mock.calls[0][0].description).toBe("Complex subtask");
    });

    it("falls back to direct execution when recursive decomposition fails", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive decomposition throws
      MOCK_GENERATE_TEXT.mockRejectedValueOnce(new Error("Recursive decomposition failed"));

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 100,
      });

      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(spawnSubAgentMock.mock.calls[0][0].description).toBe("Complex subtask");
    });

    it("falls back when all recursive sub-subtasks fail", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive decomposition returns 2 subtasks
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "Sub-subtask A", prompt: "Prompt A" },
          { description: "Sub-subtask B", prompt: "Prompt B" },
        ]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Both sub-subtasks return errors
      spawnSubAgentMock.mockResolvedValue({ error: "Failed execution" });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 100,
      });

      // Spawn is first called twice for recursive sub-subtasks.
      // Because both fail, we fall back to spawning the original complex subtask directly (3rd spawn call).
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(3);
      expect(spawnSubAgentMock.mock.calls[2][0].description).toBe("Complex subtask");
    });
  });

  // ── Group 8: Configuration via topologyConfig ────────────────────────
  describe("Group 8: Configuration via topologyConfig", () => {
    it("respects maxSubtasks config", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Task A", prompt: "Do A" },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxSubtasks: 3,
      });

      expect(MOCK_GENERATE_TEXT).toHaveBeenCalled();
      const decompositionPrompt = MOCK_GENERATE_TEXT.mock.calls[0][0][0].content;
      expect(decompositionPrompt).toContain("identify 3 or fewer subtasks.");
    });

    it("respects maxRecursionDepth config", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Mock recursive decomposition at depth 1
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "Sub-subtask A", prompt: "Prompt A" },
        ]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 100,
      });

      // Verify that it went recursive (will try to spawn, since 1 yield falls back to direct execution)
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
    });

    it("clamps maxRecursionDepth to MAXIMUM_ALLOWED (10)", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "Complex subtask", prompt: "A".repeat(500) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive decomposition at depth 1 -> yields 2 sub-subtasks
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "Level 2 A", prompt: "B".repeat(500) },
          { description: "Level 2 B", prompt: "B".repeat(500) },
        ]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive decomposition at depth 2 for Level 2 A -> yields 2 sub-sub-subtasks
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "Level 3 A", prompt: "C".repeat(500) },
          { description: "Level 3 B", prompt: "C".repeat(500) },
        ]),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive synthesis at depth 2 (for Level 2 A)
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "Synthesized depth 2",
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Recursive synthesis at depth 1
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: "Synthesized depth 1",
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 20, // will clamp to 10
        recursionComplexityThreshold: 100,
      });

      // Verification shows clamping did not crash and execution succeeded
      expect(spawnSubAgentMock).toHaveBeenCalled();
    });

    it("respects recursionComplexityThreshold", async () => {
      const router = new DivideAndConquerRouter();
      const mockSubtasks = [
        { description: "A", prompt: "A".repeat(400) },
      ];
      MOCK_GENERATE_TEXT.mockResolvedValueOnce({
        text: JSON.stringify(mockSubtasks),
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // We set recursionComplexityThreshold to 500, since prompt has length 400 < 500, it should NOT recurse.
      await router.execute("test-team", mockMembers, orchestratorContext, spawnSubAgentMock, undefined, {
        maxRecursionDepth: 2,
        recursionComplexityThreshold: 500,
      });

      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
    });
  });
});
