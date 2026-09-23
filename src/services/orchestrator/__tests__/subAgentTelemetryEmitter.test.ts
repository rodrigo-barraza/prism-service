import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubAgentTelemetryEmitter } from "#src/services/orchestrator/SubAgentTelemetryEmitter";
import { LiveTurnBuffer, withDirectViewerBroadcast } from "#src/utils/DirectViewerBroadcast";

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    getConversationStats: vi.fn().mockReturnValue({
      totalOutputTokens: 100,
      totalInputTokens: 200,
      totalTokens: 300,
      activeRequests: 1,
      tokPerSec: 25,
      avgTtft: 500,
    }),
  },
}));

describe("SubAgentTelemetryEmitter", () => {
  let parentEmitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    parentEmitMock = vi.fn();
  });

  function createEmitter(overrides?: Partial<{
    subAgentId: string;
    subAgentDescription: string;
    parentEmit: typeof parentEmitMock;
    parentConversationId: string | null;
    recursionDepth: number;
  }>) {
    return new SubAgentTelemetryEmitter({
      subAgentId: overrides?.subAgentId ?? "sub-agent-test-1",
      subAgentDescription: overrides?.subAgentDescription ?? "Test sub-agent",
      subAgentConversationId: "sub-conv-test-1",
      parentEmit: (overrides?.parentEmit ?? parentEmitMock) as any,
      parentConversationId: overrides?.parentConversationId ?? "parent-conv-1",
      recursionDepth: overrides?.recursionDepth ?? 0,
    });
  }

  describe("chunk event handling", () => {
    it("should accumulate output text from chunk events", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Hello " });
      emitFunction({ type: "chunk", content: "world!" });

      expect(emitter.output).toBe("Hello world!");
    });

    it("should emit phase=generating on first chunk event", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Hello" });

      const phaseEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "phase" && (call[0] as Record<string, unknown>).phase === "generating",
      );
      expect(phaseEvent).toBeDefined();
    });

    it("should emit generation_progress on chunk events", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Some text content" });

      const progressEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "generation_progress",
      );
      expect(progressEvent).toBeDefined();
      expect(progressEvent![0].type).toBe("sub_agent_status");
      expect(progressEvent![0].subAgentId).toBe("sub-agent-test-1");
    });

    it("should handle non-string content in chunk events gracefully", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: null });
      emitFunction({ type: "chunk" });

      expect(emitter.output).toBe("");
    });
  });

  describe("thinking event handling", () => {
    it("should emit phase=thinking on first thinking event", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "thinking", content: "Let me analyze this..." });

      const phaseEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "phase" && (call[0] as Record<string, unknown>).phase === "thinking",
      );
      expect(phaseEvent).toBeDefined();
    });

    it("should reset burst counters on phase transition from generating to thinking", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Generated text " });
      emitFunction({ type: "chunk", content: "more text " });

      const progressCallsBeforeTransition = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "generation_progress",
      ).length;

      emitFunction({ type: "thinking", content: "Now thinking..." });

      const allProgressCalls = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "generation_progress",
      );
      expect(allProgressCalls.length).toBeGreaterThan(progressCallsBeforeTransition);
    });

    it("should reset burst counters on phase transition from thinking to generating", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "thinking", content: "Thinking first..." });
      emitFunction({ type: "chunk", content: "Now generating..." });

      const phaseEvents = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "phase",
      );

      const phases = phaseEvents.map((call: unknown[]) => (call[0] as Record<string, unknown>).phase);
      expect(phases).toContain("thinking");
      expect(phases).toContain("generating");
    });
  });

  describe("tool_execution event handling", () => {
    it("should track tool calls from tool_execution events with 'calling' status", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "call-1", name: "read_file", args: { path: "test.ts" } },
      });

      expect(emitter.toolCalls).toHaveLength(1);
      expect(emitter.toolCalls[0].name).toBe("read_file");
      expect(emitter.toolCalls[0].args).toEqual({ path: "test.ts" });
    });

    it("should not track tool calls with non-calling status", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_execution",
        status: "complete",
        tool: { name: "read_file", args: {} },
      });

      expect(emitter.toolCalls).toHaveLength(0);
    });

    it("should forward tool_execution events to parent as sub_agent_tool_execution", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "call-1", name: "write_file", args: { path: "out.ts" } },
      });

      const toolExecEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "sub_agent_tool_execution",
      );
      expect(toolExecEvent).toBeDefined();
      expect(toolExecEvent![0].subAgentId).toBe("sub-agent-test-1");
      expect(toolExecEvent![0].subAgentDescription).toBe("Test sub-agent");
    });

    it("should flush generation progress before tool execution when in generating phase", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Some generated output" });

      const progressCallsBefore = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "generation_progress",
      ).length;

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { name: "run_command", args: {} },
      });

      const progressCallsAfter = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "generation_progress",
      ).length;

      expect(progressCallsAfter).toBeGreaterThanOrEqual(progressCallsBefore);
    });

    it("should reset burst phase to null after tool execution", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "text" });

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { name: "read_file", args: {} },
      });

      // After tool_execution, the next chunk should re-emit phase=generating
      emitFunction({ type: "chunk", content: "more text" });

      const phaseEvents = parentEmitMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).message === "phase" && (call[0] as Record<string, unknown>).phase === "generating",
      );
      expect(phaseEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tool_output event handling", () => {
    it("should forward tool_output events to parent as sub_agent_tool_output", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_output",
        toolCallId: "call-1",
        name: "read_file",
        event: "output",
        data: "file contents here",
      });

      const toolOutputEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "sub_agent_tool_output",
      );
      expect(toolOutputEvent).toBeDefined();
      expect(toolOutputEvent![0].subAgentId).toBe("sub-agent-test-1");
      expect(toolOutputEvent![0].name).toBe("read_file");
    });
  });

  describe("status event handling", () => {
    it("should forward iteration_progress to parent as sub_agent_status", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "status",
        message: "iteration_progress",
        iteration: 3,
        maxIterations: 15,
      });

      const statusEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).message === "iteration_progress",
      );
      expect(statusEvent).toBeDefined();
      expect(statusEvent![0].iteration).toBe(3);
      expect(emitter.iterations).toBe(3);
    });

    it("should forward generation_started with timeToFirstToken", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "status",
        message: "generation_started",
        timeToFirstToken: 250,
      });

      const startedEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).message === "generation_started",
      );
      expect(startedEvent).toBeDefined();
      expect(startedEvent![0].timeToFirstToken).toBe(250);
    });

    it("should forward phase status events with progress", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "status",
        message: "processing_tools",
        phase: "tool_execution",
        progress: 0.5,
      });

      const phaseStatusEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).phase === "tool_execution",
      );
      expect(phaseStatusEvent).toBeDefined();
      expect(phaseStatusEvent![0].progress).toBe(0.5);
    });
  });

  describe("done event handling", () => {
    it("should capture cost and usage from done events", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "done",
        estimatedCost: 0.045,
        usage: { inputTokens: 500, outputTokens: 200 },
        tokensPerSec: 30,
      });

      expect(emitter.totalCost).toBe(0.045);
      expect(emitter.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
    });

    it("should emit final generation_progress with usage data on done", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Some output" });
      emitFunction({
        type: "done",
        estimatedCost: 0.03,
        usage: { inputTokens: 400, outputTokens: 150 },
        tokensPerSec: 25,
      });

      const finalProgressEvents = parentEmitMock.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).message === "generation_progress",
      );
      expect(finalProgressEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle done events without usage gracefully", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "done",
        estimatedCost: null,
        usage: null,
      });

      expect(emitter.totalCost).toBeNull();
      expect(emitter.usage).toBeNull();
    });
  });

  describe("approval events", () => {
    const card = {
      type: "approval_required",
      toolCallId: "call-1",
      batchId: "batch-1",
      batchSize: 1,
      toolCall: { name: "write_file", args: { path: "a.txt" }, id: "call-1" },
      tier: 2,
      tierLabel: "write",
    };

    it("forwards the sub-agent's card to the parent, tagged with the conversation its decision goes to", () => {
      const emitFunction = createEmitter().createEmitFunction();

      // A copy: the sub-agent's own broadcast stamps its seq on the event.
      emitFunction({ ...card });

      expect(parentEmitMock).toHaveBeenCalledWith({
        ...card,
        subAgentId: "sub-agent-test-1",
        subAgentDescription: "Test sub-agent",
        approvalConversationId: "sub-conv-test-1",
      });
    });

    it("forwards the decision too, so the parent's card closes", () => {
      const emitFunction = createEmitter().createEmitFunction();

      emitFunction({ type: "approval_decided", toolCallId: "call-1", batchId: "batch-1", decision: "deny", source: "timeout" });

      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "approval_decided", toolCallId: "call-1", approvalConversationId: "sub-conv-test-1" }),
      );
    });

    it("keeps a grandchild's tags when forwarding its card up", () => {
      const emitFunction = createEmitter().createEmitFunction();

      emitFunction({
        ...card,
        subAgentId: "grandchild-1",
        subAgentDescription: "Grandchild",
        approvalConversationId: "grandchild-conv",
      });

      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ subAgentId: "grandchild-1", approvalConversationId: "grandchild-conv" }),
      );
    });
  });

  describe("sequence ids on the parent stream", () => {
    // Every event this emitter sees is stamped with the SUB-AGENT
    // conversation's seq (broadcastToDirectViewers → LiveTurnBuffer.record)
    // before some are forwarded up. The parent stream numbers its own
    // events; a forwarded event must take the parent's next seq, or it runs
    // backwards whenever the parent has emitted more than the sub-agent —
    // and a client cursor (afterSeq, liveTurnCursor) drops it as seen.
    beforeEach(() => {
      LiveTurnBuffer.clearAll();
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("gives a forwarded card, decision, usage update and grandchild event the parent's next seq", () => {
      vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
      const parentStream: Array<Record<string, unknown>> = [];
      const parentEmit = withDirectViewerBroadcast("parent-conv-1", (event: Record<string, unknown>) => {
        parentStream.push({ ...event });
      });
      const emitFunction = createEmitter({ parentEmit: parentEmit as typeof parentEmitMock }).createEmitFunction();

      emitFunction({ type: "chunk", content: "Reading the config" });
      // The parent keeps streaming its own reply meanwhile (non-blocking
      // dispatch), so its counter runs ahead of the sub-agent's.
      for (let index = 0; index < 20; index++) parentEmit({ type: "chunk", content: `parent ${index}` });

      emitFunction({
        type: "approval_required",
        toolCallId: "call-1",
        batchId: "batch-1",
        batchSize: 1,
        toolCall: { name: "write_file", args: { path: "a.txt" }, id: "call-1" },
      });
      emitFunction({ type: "approval_decided", toolCallId: "call-1", batchId: "batch-1", decision: "allow", scope: "call", source: "user" });
      emitFunction({ type: "usage_update", usage: { inputTokens: 10, outputTokens: 2 } });
      emitFunction({ type: "sub_agent_status", subAgentId: "grandchild-1", message: "phase", phase: "thinking" });

      const seqs = parentStream.map((event) => event.seq as number);
      for (let index = 1; index < seqs.length; index++) {
        expect(seqs[index], `parent event ${index} (${String(parentStream[index].type)})`).toBe(seqs[index - 1] + 1);
      }
      expect(LiveTurnBuffer.lastSeq("parent-conv-1")).toBe(seqs[seqs.length - 1]);
    });

    it("leaves the sub-agent's own numbering to viewers of its conversation", () => {
      vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
      const parentEmit = withDirectViewerBroadcast("parent-conv-1", () => {});
      const emitFunction = createEmitter({ parentEmit: parentEmit as typeof parentEmitMock }).createEmitFunction();

      emitFunction({ type: "chunk", content: "Reading" });
      for (let index = 0; index < 20; index++) parentEmit({ type: "chunk", content: `parent ${index}` });
      emitFunction({ type: "usage_update", usage: { inputTokens: 10, outputTokens: 2 } });

      const subAgentTurn = LiveTurnBuffer.replay("sub-conv-test-1");
      expect(subAgentTurn.map((event) => event.type)).toEqual(["chunk", "usage_update"]);
      expect(subAgentTurn[1].seq).toBe(subAgentTurn[0].seq! + 1);
    });
  });

  describe("recursive sub-agent event forwarding", () => {
    it("should forward sub_agent_status events from grandchildren directly to parent", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      const grandchildEvent = {
        type: "sub_agent_status",
        subAgentId: "grandchild-1",
        message: "generation_progress",
        outputTokens: 50,
      };

      // A copy: the sub-agent's own broadcast stamps its seq on the event,
      // which the parent stream must not receive.
      emitFunction({ ...grandchildEvent });

      const forwardedEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).subAgentId === "grandchild-1",
      );
      expect(forwardedEvent).toBeDefined();
      expect(forwardedEvent![0]).toEqual(grandchildEvent);
    });

    it("should forward sub_agent_tool_execution events from grandchildren", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      const grandchildToolEvent = {
        type: "sub_agent_tool_execution",
        subAgentId: "grandchild-2",
        subAgentDescription: "Grandchild worker",
        tool: { name: "write_file", args: { path: "test.ts" } },
        status: "calling",
      };

      emitFunction(grandchildToolEvent);

      const forwardedEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "sub_agent_tool_execution" && (call[0] as Record<string, unknown>).subAgentId === "grandchild-2",
      );
      expect(forwardedEvent).toBeDefined();
    });

    it("should forward sub_agent_tool_output events from grandchildren", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      const grandchildOutputEvent = {
        type: "sub_agent_tool_output",
        subAgentId: "grandchild-3",
        toolCallId: "gc-call-1",
        name: "read_file",
        event: "output",
        data: "grandchild file content",
      };

      emitFunction(grandchildOutputEvent);

      const forwardedEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "sub_agent_tool_output" && (call[0] as Record<string, unknown>).subAgentId === "grandchild-3",
      );
      expect(forwardedEvent).toBeDefined();
    });
  });

  describe("usage_update event handling", () => {
    // On the parent stream a `usage_update` without `operation` is the PARENT
    // turn's running total (docs/protocol.md). Forwarded as-is, a sub-agent's
    // totals read as the parent's: prism-client filed them as the turn's
    // intermediate usage, and the ACP server's cost went backwards. The
    // sub-agent's spend reaches the parent on `sub_agent_status` (progress,
    // `complete` with usage and estimatedCost).
    it("keeps a sub-agent's running totals off the parent stream", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "usage_update", usage: { inputTokens: 1000, outputTokens: 500 }, estimatedCost: 0.02 });

      const forwarded = parentEmitMock.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "usage_update",
      );
      expect(forwarded).toBeUndefined();
    });
  });

  describe("emitCompletion", () => {
    it("should emit completion event with duration, tool count, usage, and cost", () => {
      const emitter = createEmitter();
      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "tc-1", name: "read_file", args: {} },
      });
      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "tc-2", name: "write_file", args: {} },
      });

      emitter.emitCompletion(
        5000,
        { inputTokens: 800, outputTokens: 300 },
        0.065,
      );

      const completionEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).message === "complete",
      );
      expect(completionEvent).toBeDefined();
      expect(completionEvent![0].durationMilliseconds).toBe(5000);
      expect(completionEvent![0].toolCount).toBe(2);
      expect(completionEvent![0].usage).toEqual({ inputTokens: 800, outputTokens: 300 });
      expect(completionEvent![0].estimatedCost).toBe(0.065);
    });

    it("should handle null usage and cost in completion", () => {
      const emitter = createEmitter();
      emitter.emitCompletion(1000, null, null);

      const completionEvent = parentEmitMock.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).type === "sub_agent_status" &&
          (call[0] as Record<string, unknown>).message === "complete",
      );
      expect(completionEvent).toBeDefined();
      expect(completionEvent![0].usage).toBeNull();
      expect(completionEvent![0].estimatedCost).toBeNull();
    });
  });

  describe("no-op when parentEmit is null", () => {
    it("should not throw when parentEmit is null and events are emitted", () => {
      const emitter = createEmitter({ parentEmit: null as any });
      const emitFunction = emitter.createEmitFunction();

      expect(() => {
        emitFunction({ type: "chunk", content: "test" });
        emitFunction({ type: "thinking", content: "thinking" });
        emitFunction({
          type: "tool_execution",
          status: "calling",
          tool: { name: "read_file", args: {} },
        });
        emitFunction({ type: "done", usage: { inputTokens: 100, outputTokens: 50 } });
      }).not.toThrow();

      expect(emitter.output).toBe("test");
      expect(emitter.toolCalls).toHaveLength(1);
    });

    it("should not emit completion when parentEmit is null", () => {
      const emitter = createEmitter({ parentEmit: null as any });
      emitter.emitCompletion(1000, null, null);
      // No throw = success
    });
  });

  describe("no-op when parentConversationId is null", () => {
    it("should still accumulate output and tool calls even without parentConversationId", () => {
      const emitter = createEmitter({ parentConversationId: null });
      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "output text" });
      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "tc-1", name: "search_files", args: {} },
      });

      expect(emitter.output).toBe("output text");
      expect(emitter.toolCalls).toHaveLength(1);
    });
  });
});
