import { describe, it, expect, beforeEach, vi } from "vitest";
import AgenticLoopService from "../src/services/AgenticLoopService.ts";
import ContextWindowManager from "../src/utils/ContextWindowManager.ts";
import SettingsService from "../src/services/SettingsService.ts";
import { HARNESS_IDS, PROVIDERS } from "../src/constants.ts";
import { TYPES } from "../src/config.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", description: "Search the web" },
      { name: "read_file", description: "Read a file" },
      { name: "generate_image", description: "Generate image" },
      { name: "describe_image", description: "Describe image" },
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", domain: "knowledge", labels: ["safe"] },
      { name: "read_file", domain: "system", labels: ["safe"] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: "mocked" }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    getCollection: vi.fn().mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    }),
  },
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio-ref" }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/services/local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getNames: vi.fn().mockReturnValue(new Set()),
  },
}));

vi.mock("../src/utils/ContextWindowManager.ts", () => ({
  default: {
    enforce: vi.fn().mockImplementation((messages) => ({
      truncated: false,
      messages,
      strategy: "none",
      estimatedTokens: 10,
    })),
    estimateTokens: vi.fn().mockReturnValue(10),
  },
}));

vi.mock("../src/services/ConversationGenerationTracker.ts", () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    recordChunkTiming: vi.fn(),
    complete: vi.fn(),
    cleanup: vi.fn(),
    getSessionStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
    }),
    getConversationStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
    }),
  },
}));

vi.mock("../src/services/system-prompt/index.ts", () => ({
  default: class {
    constructor() {}
    createHook() {
      return async () => {};
    }
  },
}));

vi.mock("../src/services/SettingsService.ts", async () => {
  const { HARNESS_IDS } = await import("../src/constants.ts");
  return {
    default: {
      getCached: vi.fn(),
      get: vi.fn().mockResolvedValue({
        agents: {
          harness: HARNESS_IDS.STANDARD,
        },
      }),
      getSection: vi.fn().mockResolvedValue({
        harness: HARNESS_IDS.STANDARD,
      }),
    },
  };
});

vi.mock("../src/routes/ChatRoutes.ts", () => ({
  finalizeTextGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/MemoryExtractor.ts", () => ({
  default: {
    createHook: vi.fn().mockReturnValue(async () => {}),
  },
}));

vi.mock("../src/services/PlanningModeService.ts", () => ({
  default: {
    injectPlanningInstruction: vi.fn(),
    stripPlanningInstruction: vi.fn(),
    extractSteps: vi.fn().mockReturnValue([]),
  },
}));

describe("AgenticLoopService", () => {
  let mockProvider: any;
  let mockContext: any;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];
    (SettingsService.getCached as any).mockReturnValue({
      creative: {
        textToSpeechProvider: PROVIDERS.ELEVENLABS,
      },
    });
    
    mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "Hello";
        yield " World";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      }),
    };

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
      agentSessionId: "session-123",
      parentAgentSessionId: null,
      traceId: "trace-123",
      project: "test-project",
      username: "test-user",
      requestId: "req-123",
      requestStart: performance.now(),
      emit: vi.fn((event) => emittedEvents.push(event)),
      signal: new AbortController().signal,
    };
  });

  it("should execute a single loop and emit chunks", async () => {
    await AgenticLoopService.runAgenticLoop(mockContext);

    expect(mockContext.emit).toHaveBeenCalled();
    const chunks = emittedEvents.filter((e: any) => e.type === "chunk");
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toBe("Hello");
    expect(chunks[1].content).toBe(" World");
  });

  it("should filter out native search_web tool if options.webSearch is true", async () => {
    mockContext.options.webSearch = true;
    mockContext.options.enabledTools = ["search_web", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find((tool: any) => tool.name === "search_web")).toBeUndefined();
    expect(passTools.find((tool: any) => tool.name === "read_file")).toBeDefined();
  });

  it("should filter out generate_image if model natively outputs images", async () => {
    mockContext.modelDefinition.outputTypes = [TYPES.TEXT, TYPES.IMAGE];
    mockContext.options.enabledTools = ["generate_image", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find((tool: any) => tool.name === "generate_image")).toBeUndefined();
    expect(passTools.find((tool: any) => tool.name === "read_file")).toBeDefined();
  });

  it("should filter out describe_image if model natively inputs images", async () => {
    mockContext.modelDefinition.inputTypes = [TYPES.TEXT, TYPES.IMAGE];
    mockContext.options.enabledTools = ["describe_image", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find((tool: any) => tool.name === "describe_image")).toBeUndefined();
    expect(passTools.find((tool: any) => tool.name === "read_file")).toBeDefined();
  });

  it("should expand domain and label selectors for enabledTools", async () => {
    mockContext.options.enabledTools = ["domain:knowledge"];

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    // getClientToolSchemas returns search_web as domain:knowledge
    expect(passTools.length).toBeGreaterThan(0);
    expect(passTools.find((tool: any) => tool.name === "search_web")).toBeDefined();
  });

  it("should handle context truncation", async () => {
    (ContextWindowManager.enforce as any).mockReturnValueOnce({
      truncated: true,
      messages: [{ role: "user", content: "Truncated" }],
      strategy: "oldest",
      estimatedTokens: 5,
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][0];
    expect(callArgs[0].content).toBe("Truncated");
    
    const truncationEvents = emittedEvents.filter((e: any) => e.message === "context_truncated");
    expect(truncationEvents.length).toBe(1);
  });
  
  it("should properly support plan mode", async () => {
    mockContext.options.planFirst = true;

    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    // Should only have exit_plan_mode
    expect(passTools.every((tool: any) => tool.name === "exit_plan_mode")).toBe(true);
    
    const enterEvents = emittedEvents.filter((e: any) => e.message === "plan_mode_entered");
    expect(enterEvents.length).toBe(1);
  });

  it("should emit generation_started and generation_progress on thinking chunks", async () => {
    mockProvider.generateTextStream.mockImplementation(async function* () {
      yield { type: "thinking", content: "Thinking..." };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    const thinkingEvents = emittedEvents.filter((e: any) => e.type === "thinking");
    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect(thinkingEvents[0].content).toBe("Thinking...");

    const startedEvents = emittedEvents.filter((e: any) => e.message === "generation_started");
    expect(startedEvents.length).toBeGreaterThan(0);
  });

  it("should drop tool calls not in the allowed schema", async () => {
    mockContext.options.enabledTools = ["read_file"];
    mockProvider.generateTextStream.mockImplementation(async function* () {
      // Mock yielding a tool call that is not in the enabled schema
      yield { type: "toolCall", name: "dangerous_tool", args: {} };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    const toolExecutionEvents = emittedEvents.filter((e: any) => e.type === "tool_execution");
    // Should be 0 since dangerous_tool is not allowed and dropped
    expect(toolExecutionEvents.length).toBe(0);
  });

  it("should handle native MCP tool call streaming directly", async () => {
    mockProvider.generateTextStream.mockImplementation(async function* (messages: any, model: any, options: any) {
      if (options && !options.tools) {
        yield "Recovery summary text";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
        return;
      }
      yield { 
        type: "toolCall", 
        name: "mcp__server__tool", 
        args: { foo: "bar" }, 
        native: true, 
        status: "calling",
        id: "mcp-1"
      };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    const toolCallEvents = emittedEvents.filter((e: any) => e.type === "toolCall");
    expect(toolCallEvents.length).toBe(1);
    expect(toolCallEvents[0].name).toBe("mcp__server__tool");
    expect(toolCallEvents[0].args).toEqual({ foo: "bar" });
    
    // Ensure it didn't queue a standard tool_execution
    const toolExecutionEvents = emittedEvents.filter((e: any) => e.type === "tool_execution");
    expect(toolExecutionEvents.length).toBe(0);
  });

  it("should iterate multiple times when tools are executed and maxIterations > 1", async () => {
    mockContext.options.maxIterations = 3;
    mockContext.options.autoApprove = true;
    mockContext.options.enabledTools = ["read_file"];

    // First iteration: Model calls read_file
    mockProvider.generateTextStream.mockImplementationOnce(async function* () {
      yield { type: "toolCall", name: "read_file", args: { path: "test.txt" }, id: "toolCall-1" };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    // Second iteration: Model sees tool result and replies with text
    mockProvider.generateTextStream.mockImplementationOnce(async function* () {
      yield "File contents are: xyz";
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    // It should have called the provider twice
    expect(mockProvider.generateTextStream).toHaveBeenCalledTimes(2);

    // Verify it executed the tool
    const toolExecEvents = emittedEvents.filter((e: any) => e.type === "tool_execution");
    expect(toolExecEvents.length).toBe(2);
    expect(toolExecEvents[0].status).toBe("calling");
    expect(toolExecEvents[1].status).toBe("done");
    expect(toolExecEvents[0].tool.name).toBe("read_file");

    // Verify chunk from the second iteration
    const chunkEvents = emittedEvents.filter((e: any) => e.type === "chunk");
    expect(chunkEvents.length).toBe(1);
    expect(chunkEvents[0].content).toBe("File contents are: xyz");

    // Verify messages array grew with assistant + tool result
    // User msg (1) + Assistant tool call (1) + Tool result (1) + Assistant reply (0 inside the loop, the final reply isn't appended until next iter)
    // Wait, let's just check the provider calls
    const secondCallArgs = mockProvider.generateTextStream.mock.calls[1][0];
    expect(secondCallArgs.length).toBeGreaterThan(1);
    const lastMessageBeforeSecondIteration = secondCallArgs[secondCallArgs.length - 1];
    expect(lastMessageBeforeSecondIteration.role).toBe("tool");
  });

  it("should configure session tracking correctly for worker sub-agents", async () => {
    // Set up a worker context
    mockContext.parentAgentSessionId = "coordinator-123";
    mockContext.agentSessionId = "worker-456";
    mockContext.options.maxIterations = 1;

    await AgenticLoopService.runAgenticLoop(mockContext);

    // Should register generation against the parent/coordinator session
    const ConversationGenerationTracker = (await import("../src/services/ConversationGenerationTracker.ts")).default;
    
    // Verify register was called with the parent session ID and source: sub-agent
    expect(ConversationGenerationTracker.register).toHaveBeenCalledWith(
      "coordinator-123", 
      expect.any(String), 
      expect.objectContaining({
        source: "sub-agent",
        subAgentId: "worker-456"
      })
    );

    // Verify cleanup WAS called for workers to prevent memory leaks
    expect(ConversationGenerationTracker.cleanup).toHaveBeenCalledWith("worker-456");
  });

  it("should resolve disabledTools mode correctly", async () => {
    mockContext.options.enabledTools = null;
    mockContext.options.disabledTools = ["generate_image"];
    
    await AgenticLoopService.runAgenticLoop(mockContext);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    // Should contain search_web (as it's in the schemas), but NOT generate_image
    expect(passTools.find((tool: any) => tool.name === "search_web")).toBeDefined();
    expect(passTools.find((tool: any) => tool.name === "generate_image")).toBeUndefined();
  });

  it("should block unauthorized tools in plan mode by dropping them via schema enforcer", async () => {
    mockContext.options.maxIterations = 2;
    mockContext.options.planFirst = true;
    
    // Iteration 1: model tries to use read_file (not allowed in plan mode)
    mockProvider.generateTextStream.mockImplementationOnce(async function* () {
      yield { type: "toolCall", name: "read_file", args: {}, id: "toolCall-bad" };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockContext);

    // Because it's dropped by the schema enforcer, no tool execution occurs
    const toolExecEvents = emittedEvents.filter((e: any) => e.type === "tool_execution");
    expect(toolExecEvents.length).toBe(0);
    
    // And it shouldn't have iterated a second time because there were no pending tools
    expect(mockProvider.generateTextStream).toHaveBeenCalledTimes(1);
  });
});
