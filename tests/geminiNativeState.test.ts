/**
 * The harness side of Gemini's native state (prompt 25 Landing 2):
 *   - a `providerState` with `geminiParts` lands on the pass and the loop
 *     state, and a new pass's report replaces the last one's (citations too)
 *   - a `citations` chunk (Google Search grounding) is stored on the pass and
 *     the loop state, emitted as a `citations` event, and fed to the live
 *     sources panel as `webSearchResult`
 *   - the parts round-trip: a message carrying them expands for the provider
 *     with them intact
 */
import { describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";

import AgenticLoopState from "#src/services/AgenticLoopState";
import { createUsageAccumulator } from "#src/utils/CostCalculator";
import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import type {
  AgenticContext,
  PassState,
  ResolvedTools,
} from "#src/services/harnesses/types";
import type { ChatMessage } from "#src/types/admin";

function passState(): PassState {
  return {
    streamedText: "",
    finalStreamedText: "",
    streamedThinking: "",
    thinkingSignature: "",
    pendingToolCalls: [],
    streamedImages: [],
    start: performance.now(),
    firstTokenTime: null,
    generationEnd: null,
    outputCharacters: 0,
    usage: createUsageAccumulator(),
    options: {},
    requestId: "request-1",
    pendingRequestDocumentIdPromise: Promise.resolve(null),
  };
}

const citations = {
  sources: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/A", title: "formula1.com" }],
  queries: ["most recent Formula 1 race"],
  supports: [{ text: "Antonelli won", sources: [0] }],
};

describe("Gemini native state in the harness", () => {
  let BaseAgenticHarness: any;
  beforeEach(async () => {
    BaseAgenticHarness = (await import("#src/services/harnesses/BaseAgenticHarness")).default;
  });

  function harness() {
    const state = new AgenticLoopState();
    const events: Array<Record<string, unknown>> = [];
    const context = {
      emit: (event: Record<string, unknown>) => events.push(event),
      signal: null,
      resolvedModel: "gemini-3.8-flash",
      providerName: "google",
      project: "test",
      username: "tester",
      agentConversationId: "session-1",
      conversationId: "conv-1",
    } as unknown as AgenticContext;
    const tools: ResolvedTools = { finalTools: [], resolvedEnabledTools: [] };
    return { harness: new BaseAgenticHarness(context, state, tools), state, events };
  }

  it("stores a pass's parts and citations, emits the events, and a new pass replaces them", async () => {
    const { harness: loop, state, events } = harness();
    const first = passState();
    const parts = [{ text: "Antonelli won." }, { text: "", thoughtSignature: "sig" }];
    await loop.processStreamChunk({ type: "providerState", geminiParts: parts }, first, new Set());
    await loop.processStreamChunk({ type: "citations", ...citations }, first, new Set());

    expect(first.geminiParts).toEqual(parts);
    expect(first.citations).toEqual(citations);
    expect(state.geminiParts).toEqual(parts);
    expect(state.citations).toEqual(citations);
    expect(events).toContainEqual({
      type: "citations",
      sources: citations.sources,
      queries: citations.queries,
    });
    expect(events).toContainEqual({ type: "webSearchResult", results: citations.sources });

    // The next Gemini pass reports nothing to replay and no grounding.
    const second = passState();
    await loop.processStreamChunk({ type: "providerState", geminiParts: [] }, second, new Set());
    expect(second.geminiParts).toBeUndefined();
    expect(state.geminiParts).toBeUndefined();
    expect(state.citations).toBeUndefined();
  });

  it("expands a message's parts for the provider unchanged", () => {
    const parts = [
      { text: "Rome." },
      { functionCall: 0, thoughtSignature: "sig-fc" },
      { text: "", thoughtSignature: "sig-trailing" },
    ];
    const expanded = expandMessagesForFunctionCall([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Rome.",
        geminiParts: parts,
        toolCalls: [{ id: "call-1", name: "get_weather", args: { city: "Rome" }, result: "sun" }],
      },
    ] as unknown as ChatMessage[]);
    const assistant = expanded.find((message) => message.role === "assistant") as {
      geminiParts?: unknown;
    };
    expect(assistant.geminiParts).toEqual(parts);
  });
});
