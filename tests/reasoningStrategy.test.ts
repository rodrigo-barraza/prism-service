import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AgenticLoopService from "../src/services/AgenticLoopService.ts";
import HarnessRegistry from "../src/services/harnesses/HarnessRegistry.ts";
import ReActHarness from "../src/services/harnesses/ReActHarness.ts";
import { runTreeOfThoughts } from "../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import SettingsService from "../src/services/SettingsService.ts";

// Mock the Tree of Thoughts strategy to avoid calling the provider
vi.mock("../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts", () => ({
  runTreeOfThoughts: vi.fn().mockResolvedValue({
    messages: [{ role: "assistant", content: "Mocked ToT result" }],
  }),
}));

// We also mock the provider in ReActHarness to return simple text response for CoT path
const mockProvider = {
  generateTextStream: vi.fn().mockImplementation(async function* () {
    yield "Mocked CoT result";
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
  }),
};

describe("Reasoning Strategy Routing & Migration Tests", () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Configure default SettingsService mock responses
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      harness: "standard",
      reasoningStrategy: "chain_of_thought",
    });
    vi.mocked(SettingsService.getCached).mockReturnValue({
      agents: {
        harness: "standard",
        topology: "default",
        dynamicToolActivation: true,
      },
    } as any);

    mockContext = {
      provider: mockProvider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: {
        maxInputTokens: 10000,
        inputTypes: ["text"],
        outputTypes: ["text"],
      },
      messages: [{ role: "user", content: "Hi" }],
      options: {
        maxIterations: 1,
      },
      agentSessionId: "session-123",
      parentAgentSessionId: null,
      traceId: "trace-123",
      project: "test-project",
      username: "test-user",
      requestId: "req-123",
      requestStart: performance.now(),
      emit: vi.fn(),
      signal: new AbortController().signal,
    };
  });

  describe("AgenticLoopService Settings & Migration Resolution", () => {
    it("should use reasoningStrategy from options if explicitly provided", async () => {
      mockContext.options.reasoningStrategy = "tree_of_thoughts";
      mockContext.options.harness = "standard";

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe("tree_of_thoughts");
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should resolve reasoningStrategy from SettingsService if missing in options", async () => {
      // Mock SettingsService to return tree_of_thoughts
      vi.mocked(SettingsService.getSection).mockResolvedValue({
        harness: "standard",
        reasoningStrategy: "tree_of_thoughts",
      });

      mockContext.options.reasoningStrategy = undefined;
      mockContext.options.harness = "standard";

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe("tree_of_thoughts");
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should migrate legacy 'tree_of_thought' harness to 'standard' harness + 'tree_of_thoughts' strategy", async () => {
      mockContext.options.harness = "tree_of_thought";
      mockContext.options.reasoningStrategy = undefined;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.harness).toBe("standard");
      expect(mockContext.options.reasoningStrategy).toBe("tree_of_thoughts");
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });
  });

  describe("ReActHarness Strategy Dispatch", () => {
    it("should dispatch to runTreeOfThoughts when strategy is tree_of_thoughts", async () => {
      mockContext.options.harness = "standard";
      mockContext.options.reasoningStrategy = "tree_of_thoughts";

      const harness = new ReActHarness(mockContext, {} as any, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const result = await harness.run();
      expect(runTreeOfThoughts).toHaveBeenCalledWith(harness);
      expect(result.messages[0].content).toBe("Mocked ToT result");
    });

    it("should run the standard CoT loop when strategy is chain_of_thought", async () => {
      mockContext.options.harness = "standard";
      mockContext.options.reasoningStrategy = "chain_of_thought";

      const state = new AgenticLoopState({
        originalMessageCount: 1,
        planModeActive: false,
      });

      const harness = new ReActHarness(mockContext, state, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      await harness.run();
      expect(runTreeOfThoughts).not.toHaveBeenCalled();
      expect(mockContext.provider.generateTextStream).toHaveBeenCalled();
    });
  });
});
