import { describe, it, expect, beforeEach, vi } from "vitest";
import BenchmarkService from "#src/services/BenchmarkService";
import { handleConversation, handleAgent } from "#src/routes/ChatRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { PROVIDERS } from "#src/constants";

vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(),
  },
}));

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockReturnValue({
    generateTextStream: vi.fn(),
  }),
}));

vi.mock("#src/providers/instance-registry", () => ({
  isInstance: vi.fn().mockReturnValue(false),
}));

describe("BenchmarkService", () => {
  let mockDatabase: any;
  let mockInsertOne: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertOne = vi.fn().mockResolvedValue({ acknowledged: true });
    mockDatabase = {
      collection: vi.fn().mockReturnValue({
        insertOne: mockInsertOne,
      }),
    };
    (MongoWrapper.getDb as any).mockReturnValue(mockDatabase);
  });

  it("should preserve the display_name from model targets as the label", async () => {
    (handleConversation as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({ type: "chunk", content: "Response text" });
        emitCallback({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } });
      }
    );

    const benchmark = {
      id: "benchmark-id-123",
      name: "Test Benchmark",
      prompt: "What is 2+2?",
      benchmarkMode: "model" as const,
    };

    const modelTargets = [
      {
        provider: PROVIDERS.OPENAI,
        model: "gpt-4o",
        display_name: "Custom Model Name",
        thinkingEnabled: false,
        toolsEnabled: false,
      },
    ];

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      "test-project",
      "test-user"
    );

    expect(result.models.length).toBe(1);
    expect(result.models[0].label).toBe("Custom Model Name");
    expect(handleConversation).toHaveBeenCalled();
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it("should route non-agent LLMilliseconds to handleAgent if tools are enabled", async () => {
    (handleAgent as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({ type: "chunk", content: "Agentic answer" });
        emitCallback({ type: "done", usage: { inputTokens: 20, outputTokens: 10 } });
      }
    );

    const benchmark = {
      id: "benchmark-id-123",
      name: "Test Benchmark with Tools",
      prompt: "Use calculator to find 2+2",
      benchmarkMode: "combined" as const,
    };

    const modelTargets = [
      {
        provider: PROVIDERS.OPENAI,
        model: "gpt-4o",
        display_name: "GPT-4o with Wrench",
        thinkingEnabled: false,
        toolsEnabled: true,
      },
    ];

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      "test-project",
      "test-user"
    );

    expect(result.models.length).toBe(1);
    expect(result.models[0].label).toBe("GPT-4o with Wrench");
    expect(handleAgent).toHaveBeenCalled();
    expect(handleConversation).not.toHaveBeenCalled();
  });

  it("should route to handleConversation if neither tools nor agent is specified", async () => {
    (handleConversation as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({ type: "chunk", content: "Normal answer" });
        emitCallback({ type: "done", usage: { inputTokens: 5, outputTokens: 2 } });
      }
    );

    const benchmark = {
      id: "benchmark-id-123",
      name: "Normal Benchmark",
      prompt: "Say hello",
      benchmarkMode: "model" as const,
    };

    const modelTargets = [
      {
        provider: PROVIDERS.OPENAI,
        model: "gpt-4o",
        display_name: "Normal GPT-4o",
        thinkingEnabled: false,
        toolsEnabled: false,
      },
    ];

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      "test-project",
      "test-user"
    );

    expect(result.models.length).toBe(1);
    expect(handleConversation).toHaveBeenCalled();
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it("evaluates text + tool assertions and records per-assertion results", async () => {
    (handleAgent as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({
          type: "tool_execution",
          status: "done",
          tool: {
            id: "t1",
            name: "evaluate_expression",
            args: { expression: "987654321*123456789" },
            result: "121932631112635269",
          },
        });
        emitCallback({ type: "chunk", content: "The result is 121932631112635269." });
        emitCallback({ type: "done", usage: { inputTokens: 30, outputTokens: 12 } });
      }
    );

    const benchmark = {
      id: "benchmark-tools",
      name: "Calculator Benchmark",
      prompt: "Multiply the two big numbers",
      assertions: [
        { expectedValue: "121932631112635269", matchMode: "numericEquals" as const },
      ],
      assertionOperator: "AND" as const,
      agentAssertions: [
        { type: "used_tool" as const, toolName: "evaluate_expression" },
        { type: "tool_calls_ok" as const },
      ],
      agentAssertionOperator: "AND" as const,
      enabledTools: ["evaluate_expression"],
    };

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      [
        {
          provider: PROVIDERS.OPENAI,
          model: "gpt-4o",
          display_name: "GPT-4o",
          toolsEnabled: true,
        },
      ],
      "test-project",
      "test-user"
    );

    const modelResult = result.models[0];
    expect(modelResult.passed).toBe(true);
    expect(modelResult.toolNames).toEqual(["evaluate_expression"]);
    expect(modelResult.assertionResults?.length).toBe(3);
    expect(
      modelResult.assertionResults?.every((assertion: any) => assertion.passed),
    ).toBe(true);
    // The benchmark's own tool set is forwarded to the agent handler
    const callParameters = (handleAgent as any).mock.calls[0][0];
    expect(callParameters.enabledTools).toEqual(["evaluate_expression"]);
    expect(result.summary.passed).toBe(1);
  });

  it("expands targets into repeated trials and tags each result", async () => {
    (handleConversation as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({ type: "chunk", content: "Paris" });
        emitCallback({ type: "done", usage: { inputTokens: 3, outputTokens: 1 } });
      }
    );

    const benchmark = {
      id: "benchmark-trials",
      name: "Trials Benchmark",
      prompt: "Capital of France?",
      expectedValue: "Paris",
      matchMode: "contains",
    };

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      [
        {
          provider: PROVIDERS.OPENAI,
          model: "gpt-4o",
          display_name: "GPT-4o",
        },
      ],
      "test-project",
      "test-user",
      { trials: 3 }
    );

    expect(result.models.length).toBe(3);
    expect(result.trials).toBe(3);
    expect(result.models.map((model: any) => model.trial)).toEqual([1, 2, 3]);
    expect(result.models.every((model: any) => model.trialCount === 3)).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.passed).toBe(3);
  });

  it("captures timing metrics (ttft + tokens/sec fallback)", async () => {
    (handleConversation as any).mockImplementation(
      async (parameters: any, emitCallback: any, _options: any) => {
        emitCallback({ type: "chunk", content: "Paris" });
        emitCallback({
          type: "done",
          usage: { inputTokens: 3, outputTokens: 50 },
        });
      }
    );

    const benchmark = {
      id: "benchmark-timing",
      name: "Timing Benchmark",
      prompt: "Capital of France?",
      expectedValue: "Paris",
    };

    const result = await BenchmarkService.runBenchmark(
      benchmark,
      [{ provider: PROVIDERS.OPENAI, model: "gpt-4o" }],
      "test-project",
      "test-user"
    );

    const modelResult = result.models[0];
    expect(modelResult.ttftMs).toBeGreaterThanOrEqual(0);
    expect(modelResult.tokensPerSecond).toBeGreaterThan(0);
  });
});
