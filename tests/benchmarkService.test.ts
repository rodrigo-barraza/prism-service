import { describe, it, expect, beforeEach, vi } from "vitest";
import BenchmarkService from "../src/services/BenchmarkService.ts";
import { handleConversation, handleAgent } from "../src/routes/ChatRoutes.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";

vi.mock("../src/routes/ChatRoutes.ts", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn(),
  },
}));

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockReturnValue({
    generateTextStream: vi.fn(),
  }),
}));

vi.mock("../src/providers/instance-registry.ts", () => ({
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
      async (parameters: any, emitCallback: any, options: any) => {
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
        provider: "openai",
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

  it("should route non-agent LLMs to handleAgent if tools are enabled", async () => {
    (handleAgent as any).mockImplementation(
      async (parameters: any, emitCallback: any, options: any) => {
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
        provider: "openai",
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
      async (parameters: any, emitCallback: any, options: any) => {
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
        provider: "openai",
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
});
