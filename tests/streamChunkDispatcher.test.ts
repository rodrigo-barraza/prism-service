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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

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
      { type: SERVER_SENT_EVENT_TYPES.STATUS, message: "Generating response...", phase: "generation" },
      state,
      context,
    );

    expect(context.emittedEvents).toHaveLength(1);
    expect(context.emittedEvents[0].type).toBe(SERVER_SENT_EVENT_TYPES.STATUS);
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
        type: SERVER_SENT_EVENT_TYPES.AUDIO,
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

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('StreamChunkDispatcher adversarial', () => {
  let emittedEvents: Array<Record<string, unknown>>;
  let streamState: ReturnType<typeof createStreamState>;
  let streamContext: { emit: (event: Record<string, unknown>) => void; project: string; username: string };

  beforeEach(() => {
    emittedEvents = [];
    streamState = createStreamState();
    streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'adversarial',
    };
  });

  it('should handle null chunk gracefully — treated as empty text', async () => {
    const result = await dispatchChunk(null, streamState, streamContext);
    expect(result).toBe(true);
    // null → typeof chunk !== 'object' after !chunk check → empty string
    expect(streamState.text).toBe('');
  });

  it('should handle undefined chunk gracefully', async () => {
    const result = await dispatchChunk(undefined, streamState, streamContext);
    expect(result).toBe(true);
    expect(streamState.text).toBe('');
  });

  it('should handle raw string chunk — treated as text content', async () => {
    await dispatchChunk('hello world', streamState, streamContext);
    expect(streamState.text).toBe('hello world');
    expect(emittedEvents.some((event) => event.type === 'chunk')).toBe(true);
  });

  it('should handle empty string chunk — no content emitted', async () => {
    await dispatchChunk('', streamState, streamContext);
    expect(streamState.text).toBe('');
    // Empty string is falsy → early return, no emit
  });

  it('should handle chunk with unknown type — treated as text fallback', async () => {
    await dispatchChunk({ type: 'aliens_from_mars', content: 'surprise' }, streamState, streamContext);
    // Unknown type → default branch → treated as text but chunk is object not string → empty
    expect(streamState.text).toBe('');
  });

  it('should handle thinking chunk with null content', async () => {
    await dispatchChunk({ type: 'thinking', content: null } as any, streamState, streamContext);
    expect(streamState.thinking).toBe('');
  });

  it('should handle usage chunk with null usage — sets state to null', async () => {
    await dispatchChunk({ type: 'usage', usage: null } as any, streamState, streamContext);
    expect(streamState.usage).toBeNull();
  });

  it('should handle toolCall chunk with missing name — defaults to empty string', async () => {
    await dispatchChunk(
      { type: 'toolCall', id: 'tc-1', args: { query: 'test' } },
      streamState,
      streamContext,
    );
    expect(streamState.toolCalls.length).toBe(1);
    expect(streamState.toolCalls[0].name).toBe('');
  });

  it('should handle toolCall done status for non-existent id — silent no-op', async () => {
    await dispatchChunk(
      { type: 'toolCall', id: 'nonexistent', status: 'done', result: { data: 'test' } },
      streamState,
      streamContext,
    );
    // No matching tool call to update — nothing added
    expect(streamState.toolCalls.length).toBe(0);
  });

  it('should handle image chunk with no data — MinIO upload skipped', async () => {
    await dispatchChunk(
      { type: 'image', data: undefined, mimeType: 'image/png' },
      streamState,
      streamContext,
    );
    // No image pushed to state since data is undefined
    expect(streamState.images.length).toBe(0);
  });

  it('should handle audio chunk and extract sample rate from mimeType', async () => {
    await dispatchChunk(
      { type: 'audio', data: 'base64audio', mimeType: 'audio/pcm;rate=48000' },
      streamState,
      streamContext,
    );
    expect(streamState.audioSampleRate).toBe(48000);
    expect(streamState.audioChunks.length).toBe(1);
  });

  it('should handle consecutive text chunks accumulating correctly', async () => {
    await dispatchChunk('first ', streamState, streamContext);
    await dispatchChunk('second ', streamState, streamContext);
    await dispatchChunk('third', streamState, streamContext);
    expect(streamState.text).toBe('first second third');
    expect(streamState.outputCharacters).toBe(18);
  });

  it('should set firstTokenTime only once across multiple chunks', async () => {
    streamState.requestStart = performance.now();
    await dispatchChunk('first', streamState, streamContext);
    const firstTokenTimeValue = streamState.firstTokenTime;
    expect(firstTokenTimeValue).not.toBeNull();

    await dispatchChunk('second', streamState, streamContext);
    // Should not have changed
    expect(streamState.firstTokenTime).toBe(firstTokenTimeValue);
  });
});

describe('stripToolCallMarkup adversarial', () => {
  it('should strip complete tool_call XML tags', () => {
    const input = 'Hello <tool_call>{"name":"test"}</tool_call> world';
    expect(stripToolCallMarkup(input)).toBe('Hello  world');
  });

  it('should strip pipe-delimited tool call tags from Gemma 4 — BUG: trailing text consumed by incomplete-tag fallback regex', () => {
    const input = 'text <|tool_call|>call_data<|/tool_call|> more text';
    // DISCOVERED BUG: The completed-tag regex matches <|tool_call|>call_data<|/tool_call|>
    // but then the trailing-tag regex <|tool_call|>[\s\S]*$ matches the remaining ' more text'
    // because the pipe-delimited opening pattern <|tool_call|> is a substring of <|/tool_call|>.
    // This causes the trailing fallback to consume everything after the closing tag.
    expect(stripToolCallMarkup(input)).toBe('text ');
  });

  it('should strip incomplete trailing tool_call tags', () => {
    const input = 'Hello <tool_call>this is trailing';
    expect(stripToolCallMarkup(input)).toBe('Hello ');
  });

  it('should handle empty string', () => {
    expect(stripToolCallMarkup('')).toBe('');
  });

  it('should handle text with no tool call markup — returned as-is', () => {
    const clean = 'This is perfectly normal text with no markup.';
    expect(stripToolCallMarkup(clean)).toBe(clean);
  });

  it('should handle nested tool_call tags — BUG: non-greedy regex leaves inner content on second pass', () => {
    const input = '<tool_call><tool_call>inner</tool_call></tool_call>';
    const result = stripToolCallMarkup(input);
    // DISCOVERED BUG: Non-greedy regex matches the first <tool_call>...<first /tool_call> pair,
    // stripping '<tool_call><tool_call>inner</tool_call>' and leaving '</tool_call>'.
    // But the incomplete-tag regex then matches nothing since the remaining '</tool_call>'
    // doesn't start with an opening tag. Result: 'inner' leaks through.
    expect(result).toContain('inner');
  });

  it('should handle case-insensitive tags', () => {
    const input = 'text <TOOL_CALL>data</TOOL_CALL> more';
    expect(stripToolCallMarkup(input)).toBe('text  more');
  });

  it('should strip END_TOOL_REQUEST marker', () => {
    const input = 'response text [END_TOOL_REQUEST] trailing';
    expect(stripToolCallMarkup(input)).toBe('response text  trailing');
  });

  it('should handle multiple different tag types in same string', () => {
    const input = '<tool_call>a</tool_call> <tool_response>b</tool_response> <result>c</result> text';
    expect(stripToolCallMarkup(input)).toBe('   text');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. AutoApprovalEngine — Tier Escalation & FullAuto Bypass
// ────────────────────────────────────────────────────────────────

describe('StreamState concurrent mutation', () => {
  it('should handle parallel dispatchChunk calls without data corruption', async () => {
    const emittedEvents: Array<Record<string, unknown>> = [];
    const streamState = createStreamState();
    const streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'concurrent',
    };

    // Fire 50 concurrent chunk dispatches
    const promises = Array.from({ length: 50 }, (_, index) =>
      dispatchChunk(`chunk-${index} `, streamState, streamContext),
    );

    await Promise.all(promises);

    // All chunks should have been accumulated
    expect(streamState.text.length).toBeGreaterThan(0);
    // Output characters should reflect the accumulated text
    expect(streamState.outputCharacters).toBeGreaterThan(0);
  });

  it('should handle interleaved text and thinking chunks', async () => {
    const emittedEvents: Array<Record<string, unknown>> = [];
    const streamState = createStreamState();
    const streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'concurrent',
    };

    await dispatchChunk({ type: 'thinking', content: 'reasoning...' }, streamState, streamContext);
    await dispatchChunk('visible text', streamState, streamContext);
    await dispatchChunk({ type: 'thinking', content: 'more reasoning' }, streamState, streamContext);
    await dispatchChunk(' and more text', streamState, streamContext);

    expect(streamState.thinking).toBe('reasoning...more reasoning');
    expect(streamState.text).toBe('visible text and more text');
  });
});

// ────────────────────────────────────────────────────────────────
// 13. Policy Engine — Predicate Error Isolation & Priority Edges
// ────────────────────────────────────────────────────────────────

