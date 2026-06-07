import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies that might be transitively imported
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

vi.mock("../config.ts", () => ({
  PRISM_SERVICE_PORT: 0,
  GATEWAY_SECRET: "test-secret",
  OPENAI_API_KEY: "fake",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_API_KEY: "fake",
  ELEVENLABS_API_KEY: "fake",
  INWORLD_BASIC: "fake",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:9999",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_URI: "mongodb://test:test@localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
    getMemoryModelConfig: vi.fn().mockResolvedValue({
      provider: "google",
      model: "gemini-embedding-2-preview",
    }),
    invalidateCache: vi.fn(),
    getDefaults: vi.fn(),
  },
}));

vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    appendMessages: vi.fn().mockResolvedValue(undefined),
    setGenerating: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn(),
  },
}));

// Mock ToolOrchestratorService to isolate our execution
vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    executeTool: vi.fn(),
    getWorkspaceRoot: vi.fn().mockReturnValue("/home/rodrigo/development"),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));

import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import { validateAfterToolExecution } from "../src/services/harnesses/lifecycle/ValidationInterceptor.ts";
import CriticGate from "../src/services/harnesses/lifecycle/CriticGate.ts";
import HarnessRegistry from "../src/services/harnesses/HarnessRegistry.ts";

import type { ToolCall, ToolResult, AgenticContext } from "../src/services/harnesses/types.ts";
import type AgentHooks from "../src/services/AgentHooks.ts";
import type AgenticLoopState from "../src/services/AgenticLoopState.ts";

describe("ValidationInterceptor", () => {
  let mockContext: AgenticContext;
  let mockState: AgenticLoopState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
      workspaceRoot: "/home/rodrigo/development",
      provider: {} as any,
      providerName: "test-provider",
      resolvedModel: "test-model",
      messages: [],
      emit: vi.fn(),
      options: {},
    };
    mockState = {} as any;
  });

  it("should skip validation if there are no tool calls", async () => {
    const feedbackList = await validateAfterToolExecution([], [], mockContext, mockState);
    expect(feedbackList).toEqual([]);
    expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
  });

  it("should skip validation for non-file-mutating tools", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "read_file", args: { path: "test.ts" } },
    ];
    const results: ToolResult[] = [
      { id: "call-1", name: "read_file", result: { content: "console.log('hello');" } },
    ];

    const feedbackList = await validateAfterToolExecution(toolCalls, results, mockContext, mockState);
    expect(feedbackList).toEqual([]);
    expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
  });

  it("should skip validation if the tool itself failed", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "write_file", args: { path: "test.ts" } },
    ];
    const results: ToolResult[] = [
      { id: "call-1", name: "write_file", result: { error: "Failed to write file" } },
    ];

    const feedbackList = await validateAfterToolExecution(toolCalls, results, mockContext, mockState);
    expect(feedbackList).toEqual([]);
    expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
  });

  it("should call the shell validator for TS files and return feedback if validation fails", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "write_file", args: { path: "test.ts" } },
    ];
    const results: ToolResult[] = [
      { id: "call-1", name: "write_file", result: { success: true } },
    ];

    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
      exitCode: 1,
      stdout: "error TS2322: Type 'string' is not assignable to type 'number'.",
      stderr: "",
    });

    const feedbackList = await validateAfterToolExecution(toolCalls, results, mockContext, mockState);

    expect(feedbackList).toHaveLength(1);
    expect(feedbackList[0]).toEqual({
      toolName: "execute_command",
      filePath: "test.ts",
      validatorType: "typescript",
      errors: ["error TS2322: Type 'string' is not assignable to type 'number'."],
      rawOutput: "error TS2322: Type 'string' is not assignable to type 'number'.",
    });

    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith(
      "execute_command",
      expect.objectContaining({
        command: "npx tsc --noEmit --pretty",
        cwd: "/home/rodrigo/development",
        timeout: 15000,
      }),
      expect.any(Object),
    );
  });

  it("should extract paths from other parameter names like filePath, file, or newPath", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "patch_file", args: { filePath: "src/index.tsx" } },
    ];
    const results: ToolResult[] = [
      { id: "call-1", name: "patch_file", result: { success: true } },
    ];

    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const feedbackList = await validateAfterToolExecution(toolCalls, results, mockContext, mockState);
    expect(feedbackList).toEqual([]);
    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith(
      "execute_command",
      expect.objectContaining({
        command: "npx tsc --noEmit --pretty",
        cwd: "/home/rodrigo/development",
        timeout: 15000,
      }),
      expect.any(Object),
    );
  });

  it("should run successfully without errors when validator exit code is 0", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "write_file", args: { path: "test.js" } },
    ];
    const results: ToolResult[] = [
      { id: "call-1", name: "write_file", result: { success: true } },
    ];

    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const feedbackList = await validateAfterToolExecution(toolCalls, results, mockContext, mockState);
    expect(feedbackList).toEqual([]);
  });
});

describe("CriticGate", () => {
  let mockContext: AgenticContext;
  let mockProvider: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      generateTextStream: vi.fn(),
    };
    mockContext = {
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
      workspaceRoot: "/home/rodrigo/development",
      provider: mockProvider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      messages: [],
      emit: vi.fn(),
      options: {},
    };
  });

  it("should auto-approve any tool calls that are not in the DANGER tier and fallback to context.resolvedModel if criticModel is unconfigured", async () => {
    const criticGate = new CriticGate();
    const toolCall: ToolCall = {
      id: "call-1",
      name: "write_file",
      args: { path: "test.ts", content: "hello" },
      _approval: { tier: 2 } as any, // WRITE tier
    };

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(true);
    expect(reviewResult.reason).toBe("below_danger_tier");
    expect(reviewResult.criticModel).toBe("test-model"); // default to context.resolvedModel
    expect(mockProvider.generateTextStream).not.toHaveBeenCalled();
  });

  it("should skip critic safety review if skipCritic options is true", async () => {
    const criticGate = new CriticGate();
    const toolCall: ToolCall = {
      id: "call-1",
      name: "execute_shell",
      args: { command: "rm -rf /" },
      _approval: { tier: 3 } as any, // DANGER tier
    };
    mockContext.options = { skipCritic: true };

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(true);
    expect(reviewResult.reason).toBe("critic_skipped");
    expect(mockProvider.generateTextStream).not.toHaveBeenCalled();
  });

  it("should return approved when the critic model responds with APPROVE", async () => {
    const criticGate = new CriticGate({ model: "fast-critic-model" });
    const toolCall: ToolCall = {
      id: "call-1",
      name: "execute_shell",
      args: { command: "npm run build" },
      _approval: { tier: 3 } as any,
    };

    const mockStream = (async function* () {
      yield "APPROVE\nThe command is safe and standard.";
    })();
    mockProvider.generateTextStream.mockReturnValue(mockStream);

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(true);
    expect(reviewResult.reason).toBe("critic_approved");
    expect(reviewResult.criticModel).toBe("fast-critic-model");

    expect(mockProvider.generateTextStream).toHaveBeenCalledWith(
      expect.any(Array),
      "fast-critic-model",
      expect.any(Object),
    );
  });

  it("should deny tool execution and provide a reason when the critic model responds with DENY", async () => {
    const criticGate = new CriticGate();
    const toolCall: ToolCall = {
      id: "call-1",
      name: "execute_shell",
      args: { command: "rm -rf /usr/bin" },
      _approval: { tier: 3 } as any,
    };

    const mockStream = (async function* () {
      yield "DENY\nContains destructive rm -rf command targeting critical directories.";
    })();
    mockProvider.generateTextStream.mockReturnValue(mockStream);

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(false);
    expect(reviewResult.reason).toBe("Contains destructive rm -rf command targeting critical directories.");
  });

  it("should fail-open and approve with a fallback reason if the response is ambiguous", async () => {
    const criticGate = new CriticGate();
    const toolCall: ToolCall = {
      id: "call-1",
      name: "execute_shell",
      args: { command: "ls -la" },
      _approval: { tier: 3 } as any,
    };

    const mockStream = (async function* () {
      yield "Maybe this is ok? I am not entirely sure.";
    })();
    mockProvider.generateTextStream.mockReturnValue(mockStream);

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(true);
    expect(reviewResult.reason).toBe("critic_parse_fallback");
  });

  it("should fail-open and approve if the critic model call throws an error", async () => {
    const criticGate = new CriticGate();
    const toolCall: ToolCall = {
      id: "call-1",
      name: "execute_shell",
      args: { command: "chmod 777 script.sh" },
      _approval: { tier: 3 } as any,
    };

    mockProvider.generateTextStream.mockImplementation(() => {
      throw new Error("Model rate limit reached");
    });

    const reviewResult = await criticGate.review(toolCall, mockContext);
    expect(reviewResult.approved).toBe(true);
    expect(reviewResult.reason).toBe("critic_error_fallback");
  });
});

describe("HarnessRegistry & TreeOfThoughtHarness", () => {
  it("should have TreeOfThoughtHarness registered inside HarnessRegistry", () => {
    const harnessClass = HarnessRegistry.get("tree_of_thought");
    expect(harnessClass).toBeDefined();
    expect(harnessClass!.id).toBe("tree_of_thought");
    expect(harnessClass!.label).toBe("Tree of Thought");
    expect(harnessClass!.description).toContain("backtracking");
  });

  it("should include TreeOfThoughtHarness inside the list of available harnesses", () => {
    const harnessList = HarnessRegistry.list();
    const totHarnessEntry = harnessList.find((entry) => entry.id === "tree_of_thought");
    expect(totHarnessEntry).toBeDefined();
    expect(totHarnessEntry?.label).toBe("Tree of Thought");
  });
});
