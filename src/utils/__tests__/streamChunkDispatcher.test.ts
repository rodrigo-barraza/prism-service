import { describe, it, expect } from "vitest";
import {
  dispatchChunk,
  type StreamState,
  type StreamContext,
} from "#src/utils/StreamChunkDispatcher";

function makeState(): StreamState {
  return {
    usage: null,
    firstTokenTime: null,
    generationEnd: null,
    requestStart: null,
    outputCharacters: 0,
    text: "",
    thinking: "",
    thinkingSignature: "",
    images: [],
    toolCalls: [],
    audioChunks: [],
    audioSampleRate: 0,
    rateLimits: null,
  };
}

function makeContext(events: Array<Record<string, unknown>>): StreamContext {
  return {
    emit: (event) => events.push(event as Record<string, unknown>),
    project: "test",
    username: "test",
  };
}

const textOf = (events: Array<Record<string, unknown>>) =>
  events
    .filter((event) => event.type === "chunk")
    .map((event) => event.content)
    .join("");

describe("StreamChunkDispatcher — text slice cursor", () => {
  it("emits complete text when raw string chunks stream alone", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = makeState();
    const context = makeContext(events);
    await dispatchChunk('{"pass": true, ', state, context);
    await dispatchChunk('"score": 10}', state, context);
    expect(textOf(events)).toBe('{"pass": true, "score": 10}');
    expect(state.text).toBe('{"pass": true, "score": 10}');
  });

  it("does NOT chop the text prefix when thinking precedes text", async () => {
    // Regression: thinking chars used to advance the same counter that
    // sliced the text accumulator, truncating the start of the response
    // (observed with Gemini adaptive thinking on LLM-judge verdicts).
    const events: Array<Record<string, unknown>> = [];
    const state = makeState();
    const context = makeContext(events);
    await dispatchChunk(
      { type: "thinking", content: "Let me evaluate the haiku carefully." },
      state,
      context,
    );
    await dispatchChunk('{"pass": true, "score": 1', state, context);
    await dispatchChunk('0, "reasoning": "Perfect."}', state, context);
    expect(textOf(events)).toBe('{"pass": true, "score": 10, "reasoning": "Perfect."}');
  });

  it("does NOT chop text after tool call deltas advanced the throughput counter", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = makeState();
    const context = makeContext(events);
    await dispatchChunk(
      { type: "toolCallDelta", characters: 400 },
      state,
      context,
    );
    await dispatchChunk("The result is 42.", state, context);
    expect(textOf(events)).toBe("The result is 42.");
  });

  it("keeps outputCharacters monotonic across thinking + text", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = makeState();
    const context = makeContext(events);
    await dispatchChunk({ type: "thinking", content: "12345" }, state, context);
    expect(state.outputCharacters).toBe(5);
    await dispatchChunk("abc", state, context);
    expect(state.outputCharacters).toBe(8);
  });

  it("still strips leaked tool-call markup from text", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = makeState();
    const context = makeContext(events);
    await dispatchChunk(
      "Answer: 4 <|tool_call|>junk</|tool_call|>",
      state,
      context,
    );
    expect(textOf(events)).toBe("Answer: 4 ");
  });
});
