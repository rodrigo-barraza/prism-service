import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HARNESS_IDS, THOUGHT_STRUCTURES, TYPES } from "../src/constants.ts";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticLoopService from "../src/services/AgenticLoopService.ts";
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

describe("Thought Structure Routing & Migration Tests", () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Configure default SettingsService mock responses
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      harness: HARNESS_IDS.STANDARD,
      thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
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
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.TEXT],
      },
      messages: [{ role: "user", content: "Hi" }],
      options: {
        maxIterations: 1,
      },
      agentConversationId: "session-123",
      parentAgentConversationId: null,
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
    it("should use thoughtStructure from options if explicitly provided", async () => {
      mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.TREE_OF_THOUGHTS;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.TREE_OF_THOUGHTS);
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should resolve thoughtStructure from SettingsService if missing in options", async () => {
      // Mock SettingsService to return tree_of_thoughts
      vi.mocked(SettingsService.getSection).mockResolvedValue({
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
      });

      mockContext.options.thoughtStructure = undefined;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.TREE_OF_THOUGHTS);
      expect(runTreeOfThoughts).toHaveBeenCalled();
    });

    it("should dispatch to GoT when thoughtStructure is graph_of_thoughts", async () => {
      mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS);
      expect(runGraphOfThoughts).toHaveBeenCalled();
      expect(runTreeOfThoughts).not.toHaveBeenCalled();
    });

    it("should resolve GoT from SettingsService when options omit thoughtStructure", async () => {
      vi.mocked(SettingsService.getSection).mockResolvedValue({
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
      });

      mockContext.options.thoughtStructure = undefined;
      mockContext.options.harness = HARNESS_IDS.STANDARD;

      await AgenticLoopService.runAgenticLoop(mockContext);

      expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS);
      expect(runGraphOfThoughts).toHaveBeenCalled();
    });
  });

  describe("ReActHarness ThoughtStructure Dispatch", () => {
    it("should dispatch to runTreeOfThoughts when thoughtStructure is tree_of_thoughts", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.TREE_OF_THOUGHTS;

      const harness = new ReActHarness(mockContext, {} as any, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const result = await harness.run();
      expect(runTreeOfThoughts).toHaveBeenCalledWith(harness);
      expect(result.messages[0].content).toBe("Mocked ToT result");
    });

    it("should dispatch to runGraphOfThoughts when thoughtStructure is graph_of_thoughts", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS;

      const harness = new ReActHarness(mockContext, {} as any, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const result = await harness.run();
      expect(runGraphOfThoughts).toHaveBeenCalledWith(harness);
      expect(runTreeOfThoughts).not.toHaveBeenCalled();
      expect(result.messages[0].content).toBe("Mocked GoT result");
    });

    it("should run the standard CoT loop when thoughtStructure is chain_of_thought", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT;

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

    it("should NOT dispatch to any strategy for undefined thoughtStructure (falls through to CoT loop)", async () => {
      mockContext.options.harness = HARNESS_IDS.STANDARD;
      mockContext.options.thoughtStructure = undefined;

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

// ═══════════════════════════════════════════════════════════════
// Strategy × Topology Full Combination Matrix
//
// Reasoning strategies and topologies are orthogonal axes:
//   - Strategy controls the main agent's inner loop (CoT / ToT / GoT)
//   - Topology controls sub-agent coordination (sequential / hierarchical / etc.)
//
// This matrix verifies every valid combination resolves correctly through
// AgenticLoopService, ensuring both options are persisted on the context.
// ═══════════════════════════════════════════════════════════════

const THOUGHT_STRUCTURE_ENTRIES = [
  { key: "CHAIN_OF_THOUGHT", value: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT },
  { key: "TREE_OF_THOUGHTS", value: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS },
  { key: "GRAPH_OF_THOUGHTS", value: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS },
] as const;

const TOPOLOGY_ENTRIES = Object.entries(TOPOLOGIES).map(
  ([key, value]) => ({ key, value }),
);

describe("ThoughtStructure × Topology Combination Matrix", () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      harness: HARNESS_IDS.STANDARD,
      thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
      topology: TOPOLOGIES.HIERARCHICAL,
    });
    vi.mocked(SettingsService.getCached).mockReturnValue({
      agents: {
        harness: HARNESS_IDS.STANDARD,
        topology: TOPOLOGIES.HIERARCHICAL,
        dynamicToolActivation: true,
      },
    } as any);

    mockContext = {
      provider: {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "Matrix test result";
          yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
        }),
      },
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: {
        maxInputTokens: 10000,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.TEXT],
      },
      messages: [{ role: "user", content: "Matrix test" }],
      options: {
        maxIterations: 1,
      },
      agentConversationId: "matrix-session",
      parentAgentConversationId: null,
      traceId: "matrix-trace",
      project: "test-project",
      username: "test-user",
      requestId: "matrix-req",
      requestStart: performance.now(),
      emit: vi.fn(),
      signal: new AbortController().signal,
    };
  });

  for (const thoughtStructureEntry of THOUGHT_STRUCTURE_ENTRIES) {
    for (const topology of TOPOLOGY_ENTRIES) {
      it(`should resolve ${thoughtStructureEntry.key} + ${topology.key} and persist both on options`, async () => {
        mockContext.options.harness = HARNESS_IDS.STANDARD;
        mockContext.options.thoughtStructure = thoughtStructureEntry.value;
        mockContext.options.topology = topology.value;

        await AgenticLoopService.runAgenticLoop(mockContext);

        expect(mockContext.options.thoughtStructure).toBe(thoughtStructureEntry.value);
        expect(mockContext.options.topology).toBe(topology.value);
        expect(mockContext.options.harness).toBe(HARNESS_IDS.STANDARD);

        if (thoughtStructureEntry.value === THOUGHT_STRUCTURES.TREE_OF_THOUGHTS) {
          expect(runTreeOfThoughts).toHaveBeenCalled();
          expect(runGraphOfThoughts).not.toHaveBeenCalled();
        } else if (thoughtStructureEntry.value === THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS) {
          expect(runGraphOfThoughts).toHaveBeenCalled();
          expect(runTreeOfThoughts).not.toHaveBeenCalled();
        } else {
          expect(runTreeOfThoughts).not.toHaveBeenCalled();
          expect(runGraphOfThoughts).not.toHaveBeenCalled();
        }
      });
    }
  }

  it("should fall back to SettingsService defaults when neither thoughtStructure nor topology is provided", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      harness: HARNESS_IDS.STANDARD,
      thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
      topology: TOPOLOGIES.PEER_TO_PEER,
    });

    mockContext.options.harness = undefined;
    mockContext.options.thoughtStructure = undefined;
    mockContext.options.topology = undefined;

    await AgenticLoopService.runAgenticLoop(mockContext);

    expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS);
    expect(mockContext.options.topology).toBe(TOPOLOGIES.PEER_TO_PEER);
    expect(mockContext.options.harness).toBe(HARNESS_IDS.STANDARD);
    expect(runGraphOfThoughts).toHaveBeenCalled();
  });

  it("should prefer explicit options over SettingsService defaults for both thoughtStructure and topology", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      harness: HARNESS_IDS.STANDARD,
      thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
      topology: TOPOLOGIES.HIERARCHICAL,
    });

    mockContext.options.harness = HARNESS_IDS.STANDARD;
    mockContext.options.thoughtStructure = THOUGHT_STRUCTURES.TREE_OF_THOUGHTS;
    mockContext.options.topology = TOPOLOGIES.SEQUENTIAL;

    await AgenticLoopService.runAgenticLoop(mockContext);

    expect(mockContext.options.thoughtStructure).toBe(THOUGHT_STRUCTURES.TREE_OF_THOUGHTS);
    expect(mockContext.options.topology).toBe(TOPOLOGIES.SEQUENTIAL);
    expect(runTreeOfThoughts).toHaveBeenCalled();
  });
});
