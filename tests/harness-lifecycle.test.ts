/**
 * Tests for harness lifecycle modules.
 *
 * Each lifecycle module is tested in isolation with mocked dependencies
 * to verify behavior without requiring a running service.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── PostExecutionEmitter ─────────────────────────────────────
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../src/services/harnesses/lifecycle/PostExecutionEmitter.ts";

// ─── Missing Lifecycle Imports ─────────────────────────────────
import { runExhaustionRecoveryPass } from "../src/services/harnesses/lifecycle/ExhaustionRecovery.ts";
import { executeToolBatch, executeToolSingle } from "../src/services/harnesses/lifecycle/ToolExecutor.ts";
import { reloadIfCustomToolsMutated } from "../src/services/harnesses/lifecycle/ToolHotReloader.ts";
import { createStandardHooks } from "../src/services/harnesses/lifecycle/HookInitializer.ts";

import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import SessionGenerationTracker from "../src/services/SessionGenerationTracker.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import AgentHooks from "../src/services/AgentHooks.ts";
import AutoApprovalEngine from "../src/services/AutoApprovalEngine.ts";
import SystemPromptAssembler from "../src/services/system-prompt/index.ts";

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    executeCustomTool: vi.fn(),
    executeToolStreaming: vi.fn(),
    executeTool: vi.fn(),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getWorkspaceRoot: vi.fn().mockReturnValue("/home/rodrigo/development"),
  },
}));

vi.mock("../src/services/SessionGenerationTracker.ts", () => ({
  default: {
    complete: vi.fn(),
    register: vi.fn(),
  },
}));

describe("PostExecutionEmitter", () => {
  describe("emitPostExecutionStatus", () => {
    let mockEmit: any;

    beforeEach(() => {
      mockEmit = vi.fn();
    });

    it("should emit tasks_updated when a task tool was called", () => {
      const executedToolCalls = [
        { name: "create_task", id: "1", args: {} },
        { name: "read_file", id: "2", args: {} },
      ];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "tasks_updated",
      });
    });

    it("should emit sub_agents_updated when create_team was called", () => {
      const executedToolCalls = [{ name: "create_team", id: "1", args: {} }];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "sub_agents_updated",
      });
    });

    it("should emit sub_agents_updated when stop_agent was called", () => {
      const executedToolCalls = [{ name: "stop_agent", id: "1", args: {} }];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "sub_agents_updated",
      });
    });

    it("should emit memories_updated when upsert_memory was called", () => {
      const executedToolCalls = [
        { name: "upsert_memory", id: "1", args: {} },
      ];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "memories_updated",
      });
    });

    it("should not emit anything for non-matching tool names", () => {
      const executedToolCalls = [
        { name: "read_file", id: "1", args: {} },
        { name: "write_file", id: "2", args: {} },
      ];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).not.toHaveBeenCalled();
    });

    it("should emit multiple statuses when multiple matching tools are called", () => {
      const executedToolCalls = [
        { name: "update_task", id: "1", args: {} },
        { name: "upsert_memory", id: "2", args: {} },
      ];

      emitPostExecutionStatus(executedToolCalls, mockEmit);

      expect(mockEmit).toHaveBeenCalledTimes(2);
      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "tasks_updated",
      });
      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "memories_updated",
      });
    });
  });

  describe("processToolResultMedia", () => {
    let mockEmit: any;
    let state: any;
    let pass: any;

    beforeEach(() => {
      mockEmit = vi.fn();
      state = { streamedImages: [] };
      pass = { streamedImages: [] };
    });

    it("should emit tool_execution with done status for successful results", async () => {
      const toolCalls = [{ name: "read_file", id: "toolCall-1", args: { path: "/a" } }];
      const results = [{ name: "read_file", id: "toolCall-1", result: { content: "hello" } }];

      await processToolResultMedia(toolCalls, results, state, pass, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tool_execution",
          status: "done",
          tool: expect.objectContaining({ name: "read_file", id: "toolCall-1" }),
        }),
      );
    });

    it("should emit tool_execution with error status for failed results", async () => {
      const toolCalls = [{ name: "write_file", id: "toolCall-2", args: {} }];
      const results = [
        {
          name: "write_file",
          id: "toolCall-2",
          result: { error: "Permission denied" },
        },
      ];

      await processToolResultMedia(toolCalls, results, state, pass, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tool_execution",
          status: "error",
        }),
      );
    });

    it("should track screenshot references in state and pass", async () => {
      const toolCalls = [{ name: "browser_screenshot", id: "toolCall-3", args: {} }];
      const results = [
        {
          name: "browser_screenshot",
          id: "toolCall-3",
          result: { screenshotRef: "minio://screenshots/abc.png" },
        },
      ];

      await processToolResultMedia(toolCalls, results, state, pass, mockEmit);

      expect(state.streamedImages).toContain("minio://screenshots/abc.png");
      expect(pass.streamedImages).toContain("minio://screenshots/abc.png");
    });

    it("should emit image event and track image data in state", async () => {
      const toolCalls = [{ name: "generate_image", id: "toolCall-4", args: {} }];
      const results = [
        {
          name: "generate_image",
          id: "toolCall-4",
          result: {
            image: {
              data: "base64data",
              mimeType: "image/png",
              minioRef: "minio://images/gen.png",
            },
          },
        },
      ];

      await processToolResultMedia(toolCalls, results, state, pass, mockEmit);

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "image",
          data: "base64data",
          mimeType: "image/png",
          minioRef: "minio://images/gen.png",
        }),
      );
      expect(state.streamedImages).toContain("minio://images/gen.png");
    });

    it("should upload raw audio results to MinIO and set audioRef in resultObj", async () => {
      const toolCalls = [{ name: "generate_audio", id: "toolCall-5", args: {} }];
      const results = [
        {
          name: "generate_audio",
          id: "toolCall-5",
          result: {
            audio: {
              data: "base64audiodata",
              mimeType: "audio/wav",
            },
            duration: 10,
          },
        },
      ];

      await processToolResultMedia(toolCalls, results, state, pass, mockEmit);

      const updatedResult = results[0].result as any;
      expect(updatedResult.audioRef).toBeDefined();
      expect(updatedResult.audio).toBeUndefined();
    });
  });

  describe("trackToolErrors", () => {
    let mockEmit: any;
    let state: any;

    beforeEach(() => {
      mockEmit = vi.fn();
      state = { toolErrorCounts: new Map() };
    });

    it("should increment error count on failure", () => {
      const toolCalls = [{ name: "write_file", id: "toolCall-1", args: {} }] as any;
      const results = [
        { name: "write_file", id: "toolCall-1", result: { error: "failed" } },
      ];

      trackToolErrors(toolCalls, results, state, 3, mockEmit);

      expect(state.toolErrorCounts.get("write_file")).toBe(1);
    });

    it("should clear error count on success", () => {
      state.toolErrorCounts.set("write_file", 2);
      const toolCalls = [{ name: "write_file", id: "toolCall-1", args: {} }] as any;
      const results = [
        { name: "write_file", id: "toolCall-1", result: { content: "ok" } },
      ];

      trackToolErrors(toolCalls, results, state, 3, mockEmit);

      expect(state.toolErrorCounts.has("write_file")).toBe(false);
    });

    it("should emit status when error limit is reached", () => {
      state.toolErrorCounts.set("write_file", 2);
      const toolCalls = [{ name: "write_file", id: "toolCall-1", args: {} }] as any;
      const results = [
        { name: "write_file", id: "toolCall-1", result: { error: "failed again" } },
      ];

      trackToolErrors(toolCalls, results, state, 3, mockEmit);

      expect(state.toolErrorCounts.get("write_file")).toBe(3);
      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          message: expect.stringContaining("failed 3 times"),
        }),
      );
    });
  });
});

// ─── PlanModeController ────────────────────────────────────────
import {
  blockUnauthorizedToolCalls,
  checkForPlanModeEntry,
} from "../src/services/harnesses/lifecycle/PlanModeController.ts";

describe("PlanModeController", () => {
  describe("blockUnauthorizedToolCalls", () => {
    it("should not block exit_plan_mode", () => {
      const pendingToolCalls = [
        { name: "exit_plan_mode", id: "toolCall-1", args: {} },
      ];
      const currentMessages: any[] = [];
      const pass = { streamedText: "", streamedThinking: "" };

      const { allBlocked } = blockUnauthorizedToolCalls(
        pendingToolCalls,
        currentMessages,
        pass as any,
        {} as any,
      );

      expect(allBlocked).toBe(false);
      expect(pendingToolCalls).toHaveLength(1);
    });

    it("should block non-exit tool calls and add system message", () => {
      const pendingToolCalls = [
        { name: "write_file", id: "toolCall-1", args: {} },
        { name: "read_file", id: "toolCall-2", args: {} },
      ];
      const currentMessages: any[] = [];
      const pass = { streamedText: "some text", streamedThinking: "" };

      const { allBlocked } = blockUnauthorizedToolCalls(
        pendingToolCalls,
        currentMessages,
        pass as any,
        {} as any,
      );

      expect(allBlocked).toBe(true);
      expect(pendingToolCalls).toHaveLength(0);
      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[1].content).toContain("PLANNING MODE");
    });

    it("should allow exit_plan_mode while blocking others", () => {
      const pendingToolCalls = [
        { name: "write_file", id: "toolCall-1", args: {} },
        { name: "exit_plan_mode", id: "toolCall-2", args: {} },
      ];
      const currentMessages: any[] = [];
      const pass = { streamedText: "" };

      const { allBlocked } = blockUnauthorizedToolCalls(
        pendingToolCalls,
        currentMessages,
        pass as any,
        {} as any,
      );

      expect(allBlocked).toBe(false);
      expect(pendingToolCalls).toHaveLength(1);
      expect(pendingToolCalls[0].name).toBe("exit_plan_mode");
    });
  });

  describe("checkForPlanModeEntry", () => {
    it("should activate plan mode when enter_plan_mode is in tool calls", () => {
      const mockEmit = vi.fn();
      const state = { planModeActive: false, planModeText: "" };
      const currentMessages: any[] = [];

      checkForPlanModeEntry(
        [{ name: "enter_plan_mode", id: "toolCall-1", args: {} }],
        currentMessages,
        state as any,
        mockEmit,
      );

      expect(state.planModeActive).toBe(true);
      expect(state.planModeText).toBe("");
      expect(mockEmit).toHaveBeenCalledWith({
        type: "status",
        message: "plan_mode_entered",
      });
    });

    it("should not activate plan mode for unrelated tool calls", () => {
      const mockEmit = vi.fn();
      const state = { planModeActive: false, planModeText: "" };
      const currentMessages: any[] = [];

      checkForPlanModeEntry(
        [{ name: "read_file", id: "toolCall-1", args: {} }],
        currentMessages,
        state as any,
        mockEmit,
      );

      expect(state.planModeActive).toBe(false);
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});

// ─── ApprovalGate ──────────────────────────────────────────────
import { checkAndWaitForApproval } from "../src/services/harnesses/lifecycle/ApprovalGate.ts";

describe("ApprovalGate", () => {
  it("should auto-approve when no tools need approval", async () => {
    const toolCalls = [{ name: "read_file", id: "toolCall-1", args: {} }];
    const context = {
      agentSessionId: "sess-1",
      emit: vi.fn(),
      options: {},
    };
    const approvalEngine = {
      checkBatch: vi.fn().mockReturnValue({ needsApproval: [] }),
    };

    const result = await checkAndWaitForApproval(
      toolCalls,
      context as any,
      approvalEngine as any,
    );

    expect(result.approved).toBe(true);
  });

  it("should auto-approve when options.autoApprove is true", async () => {
    const toolCalls = [{ name: "write_file", id: "toolCall-1", args: {} }];
    const context = {
      agentSessionId: "sess-1",
      emit: vi.fn(),
      options: { autoApprove: true },
    };
    const approvalEngine = {
      checkBatch: vi.fn().mockReturnValue({
        needsApproval: [
          {
            name: "write_file",
            id: "toolCall-1",
            args: {},
            _approval: { tier: 2, tierLabel: "Write" },
          },
        ],
      }),
    };

    const result = await checkAndWaitForApproval(
      toolCalls,
      context as any,
      approvalEngine as any,
    );

    expect(result.approved).toBe(true);
  });
});

// ─── Finalizer (getCollectionOpts) ─────────────────────────────
import { getCollectionOpts } from "../src/services/harnesses/lifecycle/Finalizer.ts";

// We need to mock AgentPersonaRegistry for this test
vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    isAgentProject: vi.fn((project: string) =>
      project.startsWith("agent_"),
    ),
  },
}));

describe("Finalizer", () => {
  describe("getCollectionOpts", () => {
    it("should return agent_sessions collection for agent projects", () => {
      const result = getCollectionOpts("agent_coding");
      expect(result).toEqual({ collection: "agent_conversations" });
    });

    it("should return undefined for non-agent projects", () => {
      const result = getCollectionOpts("my-project");
      expect(result).toBeUndefined();
    });
  });
});

describe("ExhaustionRecovery", () => {
  it("should run exhaustion recovery pass successfully", async () => {
    const mockProvider = {
      generateTextStream: vi.fn().mockReturnValue("mock-stream"),
    };
    const mockContext: any = {
      emit: vi.fn(),
      signal: new AbortController().signal,
      options: { tools: [] },
      resolvedModel: "test-model",
      modelDef: {},
      provider: mockProvider,
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
      requestId: "req-123",
    };
    const mockHarness: any = {
      enforceContextWindow: vi.fn().mockImplementation((messages) => messages),
      registerTrackerRequest: vi.fn(),
      createPassState: vi.fn().mockReturnValue({}),
      consumeStream: vi.fn().mockResolvedValue(undefined),
      emitGenerationProgress: vi.fn(),
    };
    const mockState: any = {};
    const currentMessages: any[] = [];

    await runExhaustionRecoveryPass(mockHarness, mockContext, mockState, currentMessages);

    expect(mockContext.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        message: "iteration_limit_reached",
      })
    );
    expect(currentMessages).toHaveLength(1);
    expect(currentMessages[0].role).toBe("user");
    expect(currentMessages[0].content).toContain("maximum number of tool-call iterations");
    expect(mockHarness.consumeStream).toHaveBeenCalled();
    expect(mockHarness.emitGenerationProgress).toHaveBeenCalled();
    expect(SessionGenerationTracker.complete).toHaveBeenCalledWith("req-123-exhaustion");
  });

  it("should call generateTextStreamLive when liveAPI is true", async () => {
    const mockProvider = {
      generateTextStreamLive: vi.fn().mockReturnValue("mock-live-stream"),
    };
    const mockContext: any = {
      emit: vi.fn(),
      signal: new AbortController().signal,
      options: {},
      resolvedModel: "test-model",
      modelDef: { liveAPI: true },
      provider: mockProvider,
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
    };
    const mockHarness: any = {
      enforceContextWindow: vi.fn().mockImplementation((messages) => messages),
      registerTrackerRequest: vi.fn(),
      createPassState: vi.fn().mockReturnValue({}),
      consumeStream: vi.fn().mockResolvedValue(undefined),
      emitGenerationProgress: vi.fn(),
    };
    const mockState: any = {};
    const currentMessages: any[] = [];

    await runExhaustionRecoveryPass(mockHarness, mockContext, mockState, currentMessages);

    expect(mockProvider.generateTextStreamLive).toHaveBeenCalled();
    expect(mockHarness.consumeStream).toHaveBeenCalledWith("mock-live-stream", expect.any(Object), expect.any(Set));
  });
});

import type {
  AgenticContext,
  ResolvedTools,
  PassState,
  ToolSchema,
} from "../src/services/harnesses/types.ts";

import AgenticLoopState from "../src/services/AgenticLoopState.ts";

describe("ToolExecutor", () => {
  let mockContext: AgenticContext;
  let mockTools: ResolvedTools;
  let mockHooks: AgentHooks;
  let mockState: AgenticLoopState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
      conversationId: "conv-123",
      traceId: "trace-123",
      providerName: "test-provider",
      resolvedModel: "test-model",
      workspaceRoot: "/home/rodrigo/development",
      emit: vi.fn(),
      requestId: "req-123",
    } as unknown as AgenticContext;
    mockTools = {
      customToolMap: new Map(),
      finalTools: [{ name: "read_file" } as ToolSchema],
    } as unknown as ResolvedTools;
    mockHooks = {
      run: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentHooks;
    mockState = {
      iterations: 1,
    } as unknown as AgenticLoopState;
  });

  it("should run custom tools when found in customToolMap", async () => {
    const customToolDef = { name: "my_custom_tool" };
    mockTools.customToolMap.set("my_custom_tool", customToolDef);
    vi.mocked(ToolOrchestratorService.executeCustomTool).mockResolvedValue({ success: true, content: "custom result" });

    const toolCalls = [{ name: "my_custom_tool", id: "call-1", args: { x: 1 } }];
    const results = await executeToolBatch(toolCalls, mockContext, mockTools, mockHooks, mockState);

    expect(mockHooks.run).toHaveBeenNthCalledWith(1, "beforeToolCall", toolCalls[0], mockContext);
    expect(ToolOrchestratorService.executeCustomTool).toHaveBeenCalledWith(customToolDef, { x: 1 });
    expect(mockHooks.run).toHaveBeenNthCalledWith(2, "afterToolCall", toolCalls[0], { success: true, content: "custom result" }, mockContext);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: "my_custom_tool",
      id: "call-1",
      result: { success: true, content: "custom result" },
      durationMs: expect.any(Number),
    });
  });

  it("should run streaming tools when they are streamable", async () => {
    vi.mocked(ToolOrchestratorService.isStreamable).mockReturnValueOnce(true);
    vi.mocked(ToolOrchestratorService.executeToolStreaming).mockResolvedValue({ success: true, content: "streaming result" });

    const toolCalls = [{ name: "stream_tool", id: "call-2", args: { y: 2 } }];
    const results = await executeToolBatch(toolCalls, mockContext, mockTools, mockHooks, mockState);

    expect(ToolOrchestratorService.executeToolStreaming).toHaveBeenCalledWith(
      "stream_tool",
      { y: 2 },
      expect.any(Function),
      expect.objectContaining({
        project: "test-project",
        username: "test-user",
        agentSessionId: "session-123",
      })
    );
    expect(results[0].result).toEqual({ success: true, content: "streaming result" });
  });

  it("should run standard tools when not custom or streaming", async () => {
    vi.mocked(ToolOrchestratorService.isStreamable).mockReturnValueOnce(false);
    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({ success: true, content: "standard result" });

    const toolCalls = [{ name: "standard_tool", id: "call-3", args: { z: 3 } }];
    const results = await executeToolBatch(toolCalls, mockContext, mockTools, mockHooks, mockState);

    expect(ToolOrchestratorService.executeTool).toHaveBeenCalledWith(
      "standard_tool",
      { z: 3 },
      expect.objectContaining({
        project: "test-project",
        username: "test-user",
        agentSessionId: "session-123",
        enabledTools: ["read_file"],
      })
    );
    expect(results[0].result).toEqual({ success: true, content: "standard result" });
  });

  it("should execute a single tool call via executeToolSingle", async () => {
    vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({ success: true, content: "single result" });
    const toolCall = { name: "standard_tool", id: "call-4", args: {} };
    const result = await executeToolSingle(toolCall, mockContext, mockTools, mockHooks, mockState);

    expect(result.result).toEqual({ success: true, content: "single result" });
  });
});

describe("ToolHotReloader", () => {
  it("should return false early if no custom tool mutations are present", async () => {
    const toolCalls = [{ name: "read_file", id: "call-1", args: {} }];
    const tools: any = { customToolMap: new Map(), finalTools: [] };
    const result = await reloadIfCustomToolsMutated(toolCalls, tools, "proj", "user", vi.fn());

    expect(result).toBe(false);
  });

  it("should reload custom tools when a mutation occurs", async () => {
    const toolCalls = [{ name: "create_custom_tool", id: "call-1", args: {} }];
    const tools: any = {
      customToolMap: new Map([["old_tool", { name: "old_tool" }]]),
      finalTools: [
        { name: "read_file", _isCustom: false },
        { name: "old_tool", _isCustom: true },
      ],
    };

    const mockToArray = vi.fn().mockResolvedValue([
      {
        name: "new_tool",
        description: "A fresh tool",
        parameters: [
          { name: "param1", type: "string", required: true, description: "p1" },
          { name: "param2", type: "number", required: false, enum: [1, 2] },
        ],
      },
    ]);
    const mockFind = vi.fn().mockReturnValue({ toArray: mockToArray });
    const mockCollection = vi.fn().mockReturnValue({ find: mockFind });
    const mockDb = { collection: mockCollection };

    (MongoWrapper.getDb as any).mockReturnValue(mockDb as any);

    const emit = vi.fn();
    const result = await reloadIfCustomToolsMutated(toolCalls, tools, "proj", "user", emit);

    expect(result).toBe(true);
    expect(MongoWrapper.getDb).toHaveBeenCalled();
    expect(mockCollection).toHaveBeenCalledWith("custom_tools");
    expect(mockFind).toHaveBeenCalledWith({ project: "proj", username: "user", enabled: true });

    expect(tools.customToolMap.has("old_tool")).toBe(false);
    expect(tools.customToolMap.has("new_tool")).toBe(true);

    expect(tools.finalTools).toHaveLength(2);
    expect(tools.finalTools[0].name).toBe("read_file");
    expect(tools.finalTools[1].name).toBe("new_tool");
    expect(tools.finalTools[1].parameters.properties.param1).toEqual({ type: "string", description: "p1" });
    expect(tools.finalTools[1].parameters.properties.param2).toEqual({ type: "number", description: "", enum: [1, 2] });
    expect(tools.finalTools[1].parameters.required).toEqual(["param1"]);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        message: "custom_tools_updated",
      })
    );
  });

  it("should handle MongoDB error by returning false", async () => {
    const toolCalls = [{ name: "create_custom_tool", id: "call-1", args: {} }];
    const tools: any = { customToolMap: new Map(), finalTools: [] };

    (MongoWrapper.getDb as any).mockImplementationOnce(() => {
      throw new Error("DB Down");
    });

    const result = await reloadIfCustomToolsMutated(toolCalls, tools, "proj", "user", vi.fn());
    expect(result).toBe(false);
  });
});

describe("HookInitializer", () => {
  it("should initialize standard hooks with default options", () => {
    const { hooks, approvalEngine, assembler } = createStandardHooks();

    expect(hooks).toBeInstanceOf(AgentHooks);
    expect(approvalEngine).toBeInstanceOf(AutoApprovalEngine);
    expect(assembler).toBeInstanceOf(SystemPromptAssembler);

    const internalHooks = (hooks as any)._hooks;
    expect(internalHooks.get("beforePrompt")).toBeDefined();
    expect(internalHooks.get("beforePrompt")).toHaveLength(1);
    expect(internalHooks.get("beforePrompt")[0].name).toBe("SystemPromptAssembler");

    expect(internalHooks.get("beforeToolCall")).toBeDefined();
    expect(internalHooks.get("beforeToolCall")).toHaveLength(1);
    expect(internalHooks.get("beforeToolCall")[0].name).toBe("AutoApprovalEngine");

    expect(internalHooks.get("afterResponse")).toBeDefined();
    expect(internalHooks.get("afterResponse")).toHaveLength(1);
    expect(internalHooks.get("afterResponse")[0].name).toBe("MemoryExtractor");
  });

  it("should register CriticGate when enableCriticGate is true", () => {
    const { hooks } = createStandardHooks({
      enableCriticGate: true,
      criticModel: "my-critic-model",
    });

    const internalHooks = (hooks as any)._hooks;
    expect(internalHooks.get("beforeToolCall")).toHaveLength(2);
    expect(internalHooks.get("beforeToolCall")[0].name).toBe("CriticGate");
    expect(internalHooks.get("beforeToolCall")[1].name).toBe("AutoApprovalEngine");
  });
});
