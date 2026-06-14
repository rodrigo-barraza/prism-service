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
import { createStandardHooks } from "../src/services/harnesses/lifecycle/HookInitializer.ts";

import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import SessionGenerationTracker from "../src/services/SessionGenerationTracker.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";
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
    getClientToolSchemas: vi.fn().mockReturnValue([]),
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

    it("should emit memories_updated when save_memory was called", () => {
      const executedToolCalls = [
        { name: "save_memory", id: "1", args: {} },
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
        { name: "save_memory", id: "2", args: {} },
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

  describe("in-memory message appending", () => {
    it("appends the final assistant message to currentMessages at the end of finalize", async () => {
      const state = new AgenticLoopState({
        originalMessageCount: 1,
        planModeActive: false,
      });
      state.finalStreamedText = "Final synthesized answer!";
      state.streamedThinking = "Thinking process...";
      state.streamedImages = ["minio://img.png"];
      state.streamedToolCalls = [
        { id: "call-1", name: "read_file", args: { path: "a.txt" }, result: "hello" }
      ];

      const context: any = {
        project: "test-proj",
        username: "rodrigo",
        agentSessionId: "sess-1",
        conversationId: "conv-1",
        messages: [{ role: "user", content: "hello" }],
        emit: vi.fn(),
        requestStart: Date.now(),
        options: {},
      };

      class TestHarness extends BaseAgenticHarness {
        public async testFinalize(messages: any[], hooks: any) {
          await this.finalize(messages, hooks);
        }
      }

      const harness = new TestHarness(context, state, {
        finalTools: [],
        resolvedEnabledTools: [],
      } as any);

      const currentMessages: any[] = [
        { role: "user", content: "hello" }
      ];
      const hooks = new AgentHooks();

      await harness.testFinalize(currentMessages, hooks);

      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[1].role).toBe("assistant");
      expect(currentMessages[1].content).toBe("Final synthesized answer!");
      expect(currentMessages[1].thinking).toBe("Thinking process...");
      expect(currentMessages[1].images).toEqual(["minio://img.png"]);
      expect(currentMessages[1].toolCalls).toBeDefined();
      expect(currentMessages[1].toolCalls).toHaveLength(1);
      expect(currentMessages[1].toolCalls[0].name).toBe("read_file");
      expect(currentMessages[1].toolCalls[0].result).toBe("hello");
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
      modelDefinition: {},
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
    expect(currentMessages[0].role).toBe("system");
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
      modelDefinition: { liveAPI: true },
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
    expect(internalHooks.get("afterResponse")).toHaveLength(2);
    expect(internalHooks.get("afterResponse")[0].name).toBe("MemoryExtractor");
    expect(internalHooks.get("afterResponse")[1].name).toBe("ConversationEmbedding");
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
