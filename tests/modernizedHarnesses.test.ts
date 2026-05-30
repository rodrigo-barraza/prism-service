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
  },
}));

import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import { validateAfterToolExecution } from "../src/services/harnesses/lifecycle/ValidationInterceptor.ts";
import CriticGate from "../src/services/harnesses/lifecycle/CriticGate.ts";
import { executeWithSandbox } from "../src/services/harnesses/lifecycle/SandboxExecutor.ts";
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
      toolName: "execute_shell",
      filePath: "test.ts",
      validatorType: "typescript",
      errors: ["error TS2322: Type 'string' is not assignable to type 'number'."],
      rawOutput: "error TS2322: Type 'string' is not assignable to type 'number'.",
    });

    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith(
      "execute_shell",
      expect.objectContaining({
        command: expect.stringContaining("npx tsc --noEmit"),
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
      "execute_shell",
      expect.objectContaining({
        command: expect.stringContaining("npx tsc --noEmit"),
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

  it("should auto-approve any tool calls that are not in the DANGER tier", async () => {
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

describe("SandboxExecutor", () => {
  let mockContext: AgenticContext;
  let mockState: AgenticLoopState;
  let mockHooks: AgentHooks;
  let mockTools: any;

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
    mockState = {
      overallUsage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, requests: 0 },
    } as any;
    mockHooks = {
      run: vi.fn(),
    } as any;
    mockTools = {
      resolvedEnabledTools: [],
      finalTools: [],
      customToolMap: new Map(),
    };
  });

  it("should skip sandboxing entirely if no destructive tools are called", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "read_file", args: { path: "test.ts" } },
    ];

    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({ success: true });

    const { results, rolledBack } = await executeWithSandbox(
      toolCalls,
      mockContext,
      mockTools,
      mockHooks,
      mockState,
    );

    expect(rolledBack).toBe(false);
    expect(results).toBeDefined();
    
    // Verify it was called for read_file but NOT for any git sandbox operations
    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledTimes(1);
    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith("read_file", expect.any(Object), expect.any(Object));
  });

  it("should create git checkpoint, run execution, and commit changes if validation succeeds", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "write_file", args: { path: "test.ts" } },
    ];

    // Mock git add -A, git stash create, tool execution, and validation command successfully
    vi.mocked(ToolOrchestratorService.executeTool)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // git add -A
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abcdef1234567890\n" }) // git stash create
      .mockResolvedValueOnce({ success: true }) // actual tool execution (write_file)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // validation command (exit code 0 means no error)

    const { results, rolledBack } = await executeWithSandbox(
      toolCalls,
      mockContext,
      mockTools,
      mockHooks,
      mockState,
    );

    expect(rolledBack).toBe(false);
    expect(results).toHaveLength(1);
    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledTimes(4);
    expect(ToolOrchestratorService.executeTool).toHaveBeenNthCalledWith(
      1,
      "execute_shell",
      expect.objectContaining({ command: expect.stringContaining("git add -A") }),
      expect.any(Object),
    );
    expect(ToolOrchestratorService.executeTool).toHaveBeenNthCalledWith(
      2,
      "execute_shell",
      expect.objectContaining({ command: expect.stringContaining("git stash create") }),
      expect.any(Object),
    );
  });

  it("should rollback the changes and annotate the tool results if validation fails", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "write_file", args: { path: "test.ts" } },
    ];

    // Mock git commands, the write_file tool execution itself, failing validation, and rollback
    vi.mocked(ToolOrchestratorService.executeTool)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // git add -A
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abcdef1234567890\n" }) // git stash create
      .mockResolvedValueOnce({ success: true }) // actual tool execution (write_file)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "error TS2322: Invalid assignment.", stderr: "" }) // validation fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // git stash apply rollback

    const { results, rolledBack } = await executeWithSandbox(
      toolCalls,
      mockContext,
      mockTools,
      mockHooks,
      mockState,
    );

    expect(rolledBack).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].result).toEqual(
      expect.objectContaining({
        _rolledBack: true,
        _validationErrors: ["test.ts: error TS2322: Invalid assignment."],
      }),
    );

    // Verify git stash apply rollback command was executed
    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith(
      "execute_shell",
      expect.objectContaining({
        command: expect.stringContaining("git stash apply abcdef1234567890"),
      }),
      expect.any(Object),
    );
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
