import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import type {
  OrchestratorContext,
  SubAgentResult,
  OrchestratorSpawnParams,
} from "../src/types/orchestrator.ts";
import type { ChatMessage, ProviderOptions } from "../src/types/ProviderTypes.ts";
import type { GenerateTextResult } from "../src/types/provider.ts";
import { DivideAndConquerRouter } from "../src/services/orchestrator/routers/DivideAndConquerRouter.ts";

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
const mockGenerateText = vi.fn<(messages: ChatMessage[], model?: string, options?: ProviderOptions) => Promise<GenerateTextResult>>().mockResolvedValue({
  text: JSON.stringify([
    { description: "Subtask 1", prompt: "Decomposed prompt 1" },
    { description: "Subtask 2", prompt: "Decomposed prompt 2" },
  ]),
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

describe("Divide & Conquer Router — Adversarial Test Suite", () => {
  let orchestratorContext: OrchestratorContext;
  let spawnSubAgentMock: Mock<(assignment: OrchestratorSpawnParams) => Promise<SubAgentResult | { error: string }>>;

  const createMockResult = (description: string, result: string): SubAgentResult => ({
    agent_id: `agent-mock-${Math.random().toString(36).slice(2, 6)}`,
    description,
    status: "completed",
    result,
    summary: "Done",
    toolUses: 2,
    durationMilliseconds: 120,
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
  });

  // 1. Boundary & Edge Cases
  describe("Boundary & Edge Cases", () => {
    it("should handle empty members list gracefully without crashing", async () => {
      const router = new DivideAndConquerRouter();
      
      // Passing an empty members array is expected to crash due to members[0] access.
      // We wrap it to assert it does not crash or we catch the crash.
      const action = () => router.execute(
        "test-team",
        [],
        orchestratorContext,
        spawnSubAgentMock
      );
      
      await expect(action()).resolves.toBeDefined();
    });

    it("should handle boundary maxSubtasks values (0, negative, extremely large) correctly", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Task", prompt: "Prompt text" }];

      // 0 maxSubtasks should clamp to at least 1
      const resultZero = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        undefined,
        { maxSubtasks: 0 }
      );
      expect(resultZero).toBeDefined();

      // Negative maxSubtasks should clamp to at least 1
      const resultNegative = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        undefined,
        { maxSubtasks: -5 }
      );
      expect(resultNegative).toBeDefined();

      // Extremely large maxSubtasks should handle gracefully
      const resultLarge = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        undefined,
        { maxSubtasks: 999999 }
      );
      expect(resultLarge).toBeDefined();
    });

    it("should parse decomposition results containing highly nested JSON or markdown fences successfully", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Task", prompt: "Prompt text" }];

      // Mock return value containing deeply nested structure and backticks code block
      mockGenerateText.mockResolvedValueOnce({
        text: "```json\n[\n  {\n    \"description\": \"Nested JSON task\",\n    \"prompt\": \"Run with nested args: {\\\"nested\\\": {\\\"depth\\\": 100}}\"\n  }\n]\n```",
        usage: { inputTokens: 50, outputTokens: 30 },
      });

      const result = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock
      );
      
      // Should have successfully spawned the nested subtask
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(spawnSubAgentMock.mock.calls[0][0].description).toBe("Nested JSON task");
    });
  });

  // 2. Type Coercion & Schema Violations
  describe("Type Coercion & Schema Violations", () => {
    it("should handle members having coercion-violating types safely", async () => {
      const router = new DivideAndConquerRouter();
      
      // Coerce prompt as number and files as string instead of array
      const malformedMembers = [
        {
          description: "Malformed",
          prompt: 12345 as unknown as string,
          files: "not-an-array" as unknown as string[],
        },
      ];

      const result = await router.execute(
        "test-team",
        malformedMembers,
        orchestratorContext,
        spawnSubAgentMock
      );
      expect(result).toBeDefined();
    });

    it("should handle topologyConfig containing non-numeric values gracefully", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Task", prompt: "Prompt text" }];

      const result = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock,
        undefined,
        { maxSubtasks: "invalid-number" as unknown as number }
      );
      expect(result).toBeDefined();
    });
  });

  // 3. Concurrency & Race Conditions
  describe("Concurrency & Race Conditions", () => {
    it("should execute concurrently without instance state leakage", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Task", prompt: "Prompt text" }];

      // Run multiple divide-and-conquer flows in parallel
      const executionPromises = Array.from({ length: 5 }).map((_, index) =>
        router.execute(
          `team-${index}`,
          members,
          orchestratorContext,
          spawnSubAgentMock
        )
      );

      const results = await Promise.all(executionPromises);
      expect(results).toHaveLength(5);
    });
  });

  // 4. State Machine Violations
  describe("State Machine Violations", () => {
    it("should fallback to direct execution when planner returns completely malformed non-JSON text", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Direct Task", prompt: "Base prompt text" }];

      mockGenerateText.mockResolvedValueOnce({
        text: "This is completely garbage text and not JSON format at all!",
        usage: { inputTokens: 50, outputTokens: 20 },
      });

      const result = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock
      );

      // Should fall back to running the original task with 1 sub-agent
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(spawnSubAgentMock.mock.calls[0][0].prompt).toBe("Base prompt text");
    });
  });

  // 5. Error Recovery & Graceful Degradation
  describe("Error Recovery & Graceful Degradation", () => {
    it("should handle total failure of LLM planner or subtasks gracefully", async () => {
      const router = new DivideAndConquerRouter();
      const members = [{ description: "Task", prompt: "Prompt text" }];

      // Planner throws error
      mockGenerateText.mockRejectedValueOnce(new Error("API Timeout"));

      const result = await router.execute(
        "test-team",
        members,
        orchestratorContext,
        spawnSubAgentMock
      );

      expect(result).toHaveLength(1);
      expect((result[0] as { error: string }).error).toContain("Decomposition failed");
    });
  });
});
