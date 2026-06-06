/**
 * Tests for harness lifecycle modules.
 *
 * Each lifecycle module is tested in isolation with mocked dependencies
 * to verify behavior without requiring a running service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── PostExecutionEmitter ─────────────────────────────────────
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../src/services/harnesses/lifecycle/PostExecutionEmitter.ts";

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
      const toolCalls = [{ name: "write_file", id: "toolCall-1" }];
      const results = [
        { name: "write_file", id: "toolCall-1", result: { error: "failed" } },
      ];

      trackToolErrors(toolCalls, results, state, 3, mockEmit);

      expect(state.toolErrorCounts.get("write_file")).toBe(1);
    });

    it("should clear error count on success", () => {
      state.toolErrorCounts.set("write_file", 2);
      const toolCalls = [{ name: "write_file", id: "toolCall-1" }];
      const results = [
        { name: "write_file", id: "toolCall-1", result: { content: "ok" } },
      ];

      trackToolErrors(toolCalls, results, state, 3, mockEmit);

      expect(state.toolErrorCounts.has("write_file")).toBe(false);
    });

    it("should emit status when error limit is reached", () => {
      state.toolErrorCounts.set("write_file", 2);
      const toolCalls = [{ name: "write_file", id: "toolCall-1" }];
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
        pass,
        {},
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
        pass,
        {},
      );

      expect(allBlocked).toBe(true);
      expect(pendingToolCalls).toHaveLength(0);
      // Should have assistant message + system feedback
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
        pass,
        {},
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
        state,
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
        state,
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
      context,
      approvalEngine,
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
      context,
      approvalEngine,
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
