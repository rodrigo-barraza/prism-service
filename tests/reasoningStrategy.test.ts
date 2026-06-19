import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HARNESS_IDS, REASONING_STRATEGIES } from "../src/constants.ts";
import AgenticLoopService from "../src/services/AgenticLoopService.ts";
import HarnessRegistry from "../src/services/harnesses/HarnessRegistry.ts";
import ReActHarness from "../src/services/harnesses/ReActHarness.ts";
import { runTreeOfThoughts } from "../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "../src/services/harnesses/strategies/GraphOfThoughtsStrategy.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import SettingsService from "../src/services/SettingsService.ts";

// Mock the Tree of Thoughts strategy to avoid calling the provider
vi.mock("../src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts", () => ({
  runTreeOfThoughts: vi.fn().mockResolvedValue({
    messages: [{ role: "assistant", content: "Mocked ToT result" }],
  }),
}));

// Mock the Graph of Thoughts strategy to avoid calling the provider
vi.mock("../src/services/harnesses/strategies/GraphOfThoughtsStrategy.ts", () => ({
  runGraphOfThoughts: vi.fn().mockResolvedValue({
    messages: [{ role: "assistant", content: "Mocked GoT result" }],
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
      harness: HARNESS_IDS.STANDARD,
      reasoningStrategy: REASONING_STRATEGIES.CHAIN_OF_THOUGHT,
    });
    vi.mocked(SettingsService.getCached).mockReturnValue({
      agents: {
        harness: HARNESS_IDS.STANDARD,
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
      mockContext.options.reasoningStrategy = REASONING_STRATEGIES.TREE_OF_THOUGHTS;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe(REASONING_STRATEGIES.TREE_OF_THOUGHTS);
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should resolve reasoningStrategy from SettingsService if missing in options", async () => {
      // Mock SettingsService to return tree_of_thoughts
      vi.mocked(SettingsService.getSection).mockResolvedValue({
        harness: HARNESS_IDS.STANDARD,
        reasoningStrategy: REASONING_STRATEGIES.TREE_OF_THOUGHTS,
      });

      mockContext.options.reasoningStrategy = undefined;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe(REASONING_STRATEGIES.TREE_OF_THOUGHTS);
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should migrate legacy 'tree_of_thought' harness to 'standard' harness + 'tree_of_thoughts' strategy", async () => {
      mockContext.options.harness = HARNESS_IDS.TREE_OF_THOUGHT;
      mockContext.options.reasoningStrategy = undefined;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.harness).toBe(HARNESS_IDS.STANDARD);
      expect(mockContext.options.reasoningStrategy).toBe(REASONING_STRATEGIES.TREE_OF_THOUGHTS);
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should dispatch to GoT when reasoningStrategy is graph_of_thoughts", async () => {
      mockContext.options.reasoningStrategy = REASONING_STRATEGIES.GRAPH_OF_THOUGHTS;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe(REASONING_STRATEGIES.GRAPH_OF_THOUGHTS);
      expect(runGraphOfThoughts).toHaveBeenCalled();
      expect(runTreeOfThoughts).not.toHaveBeenCalled();
    });

    it("should resolve GoT from SettingsService when options omit reasoningStrategy", async () => {
      vi.mocked(SettingsService.getSection).mockResolvedValue({
        harness: HARNESS_IDS.STANDARD,
        reasoningStrategy: REASONING_STRATEGIES.GRAPH_OF_THOUGHTS,
      });

      mockContext.options.reasoningStrategy = undefined;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.reasoningStrategy).toBe(REASONING_STRATEGIES.GRAPH_OF_THOUGHTS);
      expect(runGraphOfThoughts).toHaveBeenCalled();
    });
  });

  describe("ReActHarness Strategy Dispatch", () => {
    it("should dispatch to runTreeOfThoughts when strategy is tree_of_thoughts", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.reasoningStrategy = REASONING_STRATEGIES.TREE_OF_THOUGHTS;

      const harness = new ReActHarness(mockContext, {} as any, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const result = await harness.run();
      expect(runTreeOfThoughts).toHaveBeenCalledWith(harness);
      expect(result.messages[0].content).toBe("Mocked ToT result");
    });

    it("should dispatch to runGraphOfThoughts when strategy is graph_of_thoughts", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.reasoningStrategy = REASONING_STRATEGIES.GRAPH_OF_THOUGHTS;

      const harness = new ReActHarness(mockContext, {} as any, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const result = await harness.run();
      expect(runGraphOfThoughts).toHaveBeenCalledWith(harness);
      expect(runTreeOfThoughts).not.toHaveBeenCalled();
      expect(result.messages[0].content).toBe("Mocked GoT result");
    });

    it("should run the standard CoT loop when strategy is chain_of_thought", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.reasoningStrategy = REASONING_STRATEGIES.CHAIN_OF_THOUGHT;

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
      expect(runGraphOfThoughts).not.toHaveBeenCalled();
      expect(mockContext.provider.generateTextStream).toHaveBeenCalled();
    });

    it("should NOT dispatch to any strategy for undefined reasoningStrategy (falls through to CoT loop)", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.reasoningStrategy = undefined;

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
      expect(runGraphOfThoughts).not.toHaveBeenCalled();
      expect(mockContext.provider.generateTextStream).toHaveBeenCalled();
    });
  });
});
