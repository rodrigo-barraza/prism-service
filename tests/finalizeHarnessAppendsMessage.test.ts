import { describe, it, expect, vi } from "vitest";
import "./setup.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import AgentHooks from "../src/services/AgentHooks.ts";

// Mock the finalizer to avoid database operations and network hits
vi.mock("../src/services/harnesses/lifecycle/Finalizer.ts", () => ({
  finalizeTextGeneration: vi.fn().mockResolvedValue(undefined),
  getCollectionOpts: vi.fn(),
}));

// Mock MongoWrapper and minio upload dependencies
vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn(),
  },
}));

describe("BaseAgenticHarness.finalize in-memory message appending", () => {
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

    const currentMessages = [
      { role: "user", content: "hello" }
    ];
    const hooks = new AgentHooks();

    await harness.testFinalize(currentMessages, hooks);

    // Verify currentMessages has the final assistant message appended to it
    expect(currentMessages).toHaveLength(2);
    expect(currentMessages[1].role).toBe("assistant");
    expect(currentMessages[1].content).toBe("Final synthesized answer!");
    expect(currentMessages[1].thinking).toBe("Thinking process...");
    expect(currentMessages[1].images).toEqual(["minio://img.png"]);
    expect(currentMessages[1].toolCalls).toBeDefined();
    expect(currentMessages[1].toolCalls).toHaveLength(1);
    expect(currentMessages[1].toolCalls![0].name).toBe("read_file");
    expect(currentMessages[1].toolCalls![0].result).toBe("hello");
  });
});
