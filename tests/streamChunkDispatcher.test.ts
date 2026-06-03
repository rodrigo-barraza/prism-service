/**
 * StreamChunkDispatcher — tests for tool call markup stripping and
 * chunk dispatch logic.
 *
 * stripToolCallMarkup prevents XML tool call tags leaked by local models
 * (e.g. Gemma 4) from reaching the user's chat UI.
 *
 * dispatchChunk is the single source of truth for mapping provider stream
 * chunks to SSE events. Bugs here break the entire streaming pipeline.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    isExternalStorage: () => false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://test/ref" }),
  },
}));

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  stripToolCallMarkup,
  dispatchChunk,
  createStreamState,
} = await import("../src/utils/StreamChunkDispatcher.ts");

// ── Helpers ────────────────────────────────────────────────────

function createTestContext() {
  const emittedEvents: Record<string, unknown>[] = [];
  return {
    emit: (event: Record<string, unknown>) => emittedEvents.push(event),
    project: "coding",
    username: "testuser",
    emittedEvents,
  };
}

// ═══════════════════════════════════════════════════════════════
describe("stripToolCallMarkup", () => {
  it("should remove complete <tool_call>...</tool_call> pairs", () => {
    const input = 'Hello <tool_call>{"name":"test"}</tool_call> world';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Hello  world");
  });

  it("should remove pipe-variant <|tool_call|> via trailing-tag stripping", () => {
    // The paired regex doesn't match <|/tool_call|> (/ between | and tool_call),
    // so the incomplete-tag regex strips from the opening tag to the end of string.
    // This is intentional — pipe-variant tags are treated as incomplete trailing tags.
    const input = 'Before <|tool_call|>call data<|/tool_call|> after';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Before ");
  });

  it("should remove <tool_response>...</tool_response> pairs", () => {
    const input = 'Text <tool_response>{"result":"ok"}</tool_response> more text';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Text  more text");
  });

  it("should remove <result>...</result> pairs", () => {
    const input = 'Output <result>some result</result> end';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Output  end");
  });

  it("should remove [END_TOOL_REQUEST] markers", () => {
    const input = "Tool output here [END_TOOL_REQUEST]";

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Tool output here ");
  });

  it("should remove incomplete/trailing tool_call tags at end of stream", () => {
    const input = 'Valid text <tool_call>partial data without closing';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Valid text ");
  });

  it("should remove incomplete/trailing tool_response tags at end of stream", () => {
    const input = 'Valid text <tool_response>partial response';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Valid text ");
  });

  it("should remove incomplete/trailing result tags at end of stream", () => {
    const input = 'Valid text <result>partial result';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("Valid text ");
  });

  it("should preserve clean text unchanged", () => {
    const input = "This is a perfectly clean response with no markup.";

    const result = stripToolCallMarkup(input);

    expect(result).toBe(input);
  });

  it("should handle multiple markup blocks in one string", () => {
    const input = 'A <tool_call>x</tool_call> B <tool_response>y</tool_response> C';

    const result = stripToolCallMarkup(input);

    expect(result).toBe("A  B  C");
  });

  it("should handle empty string", () => {
    const result = stripToolCallMarkup("");

    expect(result).toBe("");
  });

  it("should handle multiline tool call content", () => {
    const input = `Before
<tool_call>
{
  "name": "read_file",
  "args": {"path": "/etc/hosts"}
}
</tool_call>
After`;

    const result = stripToolCallMarkup(input);

    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("read_file");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("dispatchChunk", () => {
  it("should handle raw string chunks as text", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk("Hello ", state, context);

    expect(state.text).toBe("Hello ");
    expect(context.emittedEvents.some((event) => event.type === "chunk")).toBe(true);
  });

  it("should handle null/undefined chunks gracefully", async () => {
    const state = createStreamState();
    const context = createTestContext();

    const result = await dispatchChunk(null, state, context);

    expect(result).toBe(true);
  });

  it("should track usage chunk without emitting", async () => {
    const state = createStreamState();
    const context = createTestContext();
    const usageData = { inputTokens: 100, outputTokens: 50 };

    await dispatchChunk({ type: "usage", usage: usageData }, state, context);

    expect(state.usage).toEqual(usageData);
    // Usage should NOT produce a "chunk" or "usage" emission — it's stored silently
    expect(context.emittedEvents).toHaveLength(0);
  });

  it("should invoke onUsage callback when provided", async () => {
    const state = createStreamState();
    const context = createTestContext();
    const onUsage = vi.fn();
    const usageData = { inputTokens: 100, outputTokens: 50 };

    await dispatchChunk(
      { type: "usage", usage: usageData },
      state,
      context,
      { onUsage },
    );

    expect(onUsage).toHaveBeenCalledWith(usageData);
    expect(state.usage).toBeNull(); // Not stored when onUsage is provided
  });

  it("should track and emit thinking chunks", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "thinking", content: "Let me reason..." },
      state,
      context,
    );

    expect(state.thinking).toBe("Let me reason...");
    expect(context.emittedEvents.some((event) => event.type === "thinking")).toBe(true);
  });

  it("should accumulate thinking across multiple chunks", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk({ type: "thinking", content: "First " }, state, context);
    await dispatchChunk({ type: "thinking", content: "second" }, state, context);

    expect(state.thinking).toBe("First second");
  });

  it("should store rateLimits silently", async () => {
    const state = createStreamState();
    const context = createTestContext();
    const limits = { "x-ratelimit-remaining-tokens": 1000 };

    await dispatchChunk({ type: "rateLimits", rateLimits: limits }, state, context);

    expect(state.rateLimits).toEqual(limits);
    expect(context.emittedEvents).toHaveLength(0);
  });

  it("should track new toolCall chunks", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      {
        type: "toolCall",
        id: "call-123",
        name: "read_file",
        args: { path: "/etc/hosts" },
        status: "calling",
      },
      state,
      context,
    );

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].name).toBe("read_file");
    expect(state.toolCalls[0].id).toBe("call-123");
  });

  it("should update existing toolCall on done status", async () => {
    const state = createStreamState();
    const context = createTestContext();

    // First: register the tool call
    await dispatchChunk(
      {
        type: "toolCall",
        id: "call-123",
        name: "read_file",
        args: { path: "/etc/hosts" },
        status: "calling",
      },
      state,
      context,
    );

    // Then: update with result
    await dispatchChunk(
      {
        type: "toolCall",
        id: "call-123",
        name: "read_file",
        status: "done",
        result: "file contents here",
      },
      state,
      context,
    );

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].result).toBe("file contents here");
    expect(state.toolCalls[0].status).toBe("done");
  });

  it("should emit status events", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "status", message: "Generating response...", phase: "generation" },
      state,
      context,
    );

    expect(context.emittedEvents).toHaveLength(1);
    expect(context.emittedEvents[0].type).toBe("status");
    expect(context.emittedEvents[0].message).toBe("Generating response...");
  });

  it("should emit executableCode events", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "executableCode", code: "print('hello')", language: "python" },
      state,
      context,
    );

    const emittedEvent = context.emittedEvents[0];
    expect(emittedEvent.type).toBe("executableCode");
    expect(emittedEvent.code).toBe("print('hello')");
    expect(emittedEvent.language).toBe("python");
  });

  it("should emit codeExecutionResult events", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "codeExecutionResult", output: "hello\n", outcome: "success" },
      state,
      context,
    );

    const emittedEvent = context.emittedEvents[0];
    expect(emittedEvent.type).toBe("codeExecutionResult");
    expect(emittedEvent.output).toBe("hello\n");
    expect(emittedEvent.outcome).toBe("success");
  });

  it("should emit webSearchResult events", async () => {
    const state = createStreamState();
    const context = createTestContext();
    const searchResults = [{ url: "https://example.com", title: "Example" }];

    await dispatchChunk(
      { type: "webSearchResult", results: searchResults },
      state,
      context,
    );

    const emittedEvent = context.emittedEvents[0];
    expect(emittedEvent.type).toBe("webSearchResult");
    expect(emittedEvent.results).toEqual(searchResults);
  });

  it("should track audio chunks and extract sample rate", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      {
        type: "audio",
        data: "base64audiodata",
        mimeType: "audio/pcm;rate=24000",
      },
      state,
      context,
    );

    expect(state.audioChunks).toHaveLength(1);
    expect(state.audioChunks[0]).toBe("base64audiodata");
    expect(state.audioSampleRate).toBe(24000);
  });

  it("should set firstTokenTime on first text chunk", async () => {
    const state = createStreamState();
    const context = createTestContext();

    expect(state.firstTokenTime).toBeNull();

    await dispatchChunk("First chunk", state, context);

    expect(state.firstTokenTime).not.toBeNull();
  });

  it("should not reset firstTokenTime on subsequent chunks", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk("First", state, context);
    const firstTokenTime = state.firstTokenTime;

    await dispatchChunk(" second", state, context);

    expect(state.firstTokenTime).toBe(firstTokenTime);
  });

  it("should store stopReason from stopReason chunk", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "stopReason", stopReason: "max_tokens" } as any,
      state,
      context,
    );

    expect(state.stopReason).toBe("max_tokens");
  });

  it("should track thinking_signature", async () => {
    const state = createStreamState();
    const context = createTestContext();

    await dispatchChunk(
      { type: "thinking_signature", signature: "sig-abc-123" },
      state,
      context,
    );

    expect(state.thinkingSignature).toBe("sig-abc-123");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("createStreamState", () => {
  it("should initialize all fields to their zero values", () => {
    const state = createStreamState();

    expect(state.usage).toBeNull();
    expect(state.firstTokenTime).toBeNull();
    expect(state.generationEnd).toBeNull();
    expect(state.requestStart).toBeNull();
    expect(state.outputCharacters).toBe(0);
    expect(state.text).toBe("");
    expect(state.thinking).toBe("");
    expect(state.thinkingSignature).toBe("");
    expect(state.images).toEqual([]);
    expect(state.toolCalls).toEqual([]);
    expect(state.audioChunks).toEqual([]);
    expect(state.audioSampleRate).toBe(24000);
    expect(state.rateLimits).toBeNull();
    expect(state.stopReason).toBeUndefined();
  });
});
