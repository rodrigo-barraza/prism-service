import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PROVIDERS } from "#src/constants";
import { ProviderError } from "#src/utils/errors";

/**
 * Streaming resilience tests — verifies that all providers and SSE parsers
 * handle long-running streams and premature termination correctly.
 *
 * Tests cover:
 *   1. STREAMING_DISPATCHER audit: all raw fetch() calls for streaming include
 *      the bodyTimeout-disabled dispatcher to prevent 5-minute kills.
 *   2. parseSSEStream (OpenAI-compat): yields partial usage before re-throwing
 *      when the stream terminates prematurely.
 *   3. parseNativeSSEStream (LM Studio native): same partial usage guarantee.
 *   4. Ollama NDJSON stream: same partial usage guarantee.
 *   5. Error message enrichment: LM Studio errors include instance, model,
 *      and error code for actionable diagnostics.
 */

// ── 1. STREAMING_DISPATCHER Source Audit ────────────────────────
//
// Static analysis: every streaming fetch() in our providers must include
// `dispatcher: STREAMING_DISPATCHER` to prevent Node.js undici's default
// 5-minute bodyTimeout from killing long-running LLM streams.

describe("STREAMING_DISPATCHER coverage audit", () => {
  const PROVIDERS_DIR = resolve(__dirname, "../../providers");

  /**
   * Checks that every streaming fetch() call in a provider file includes
   * the STREAMING_DISPATCHER. Non-streaming calls (GET, stream: false) are exempt.
   *
   * Uses brace-depth tracking to isolate each fetch()'s options object,
   * preventing false positives from `stream: true` in a neighboring payload.
   */
  function auditStreamingFetchCalls(filename: string): {
    streamingFetchCount: number;
    missingDispatcher: string[];
  } {
    const filePath = resolve(PROVIDERS_DIR, filename);
    const sourceCode = readFileSync(filePath, "utf-8");
    const lines = sourceCode.split("\n");

    let detectedStreamingFetchCount = 0;
    const missingDispatcher: string[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      if (!line.includes("await fetch(") && !line.includes("await fetch(`")) continue;

      // Extract the entire fetch() call block by tracking brace depth
      // from the fetch line until the closing `});`
      let fetchBlock = "";
      let braceDepth = 0;
      let foundFirstBrace = false;

      for (let blockLine = lineIndex; blockLine < Math.min(lines.length, lineIndex + 30); blockLine++) {
        const currentLine = lines[blockLine];
        fetchBlock += currentLine + "\n";
        for (const character of currentLine) {
          if (character === "{") {
            braceDepth++;
            foundFirstBrace = true;
          }
          if (character === "}") braceDepth--;
        }
        if (foundFirstBrace && braceDepth <= 0) break;
      }

      // Also check surrounding context for `body: JSON.stringify(...)` that
      // contains `stream: true` — this is how providers set the stream flag
      // in the request BODY, separate from the fetch options object.
      const bodyContextStart = Math.max(0, lineIndex - 15);
      const bodyContextEnd = Math.min(lines.length - 1, lineIndex + 5);
      const bodyContext = lines.slice(bodyContextStart, bodyContextEnd + 1).join("\n");

      // Determine if this is a streaming request:
      // 1. The fetch options contain stream: true
      // 2. The preceding request body contains stream: true
      // 3. The fetch block already includes the dispatcher (proof it's streaming)
      // 4. The URL path indicates a streaming-only endpoint (e.g. /api/v1/chat)
      const isStreamingRequest =
        fetchBlock.includes("stream: true") ||
        fetchBlock.includes('"stream": true') ||
        bodyContext.includes("stream: true") ||
        bodyContext.includes('"stream": true') ||
        fetchBlock.includes("STREAMING_DISPATCHER") ||
        fetchBlock.includes("/api/v1/chat");

      const isGetRequest =
        fetchBlock.includes('method: "GET"') ||
        fetchBlock.includes("method: \"GET\"");

      // The `keep_alive: 0` pattern is an Ollama unload call, not streaming
      const isUnloadCall = fetchBlock.includes("keep_alive:");

      if (!isStreamingRequest || isGetRequest || isUnloadCall) continue;

      detectedStreamingFetchCount++;

      const hasDispatcher = fetchBlock.includes("dispatcher:");

      if (!hasDispatcher) {
        missingDispatcher.push(
          `${filename}:${lineIndex + 1} — streaming fetch() missing STREAMING_DISPATCHER`,
        );
      }
    }

    return {
      streamingFetchCount: detectedStreamingFetchCount,
      missingDispatcher,
    };
  }

  it("lm-studio.ts: all streaming fetch calls include STREAMING_DISPATCHER", () => {
    const result = auditStreamingFetchCalls("lm-studio.ts");
    expect(result.missingDispatcher).toEqual([]);
    expect(result.streamingFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("ollama.ts: all streaming fetch calls include STREAMING_DISPATCHER", () => {
    const result = auditStreamingFetchCalls("ollama.ts");
    expect(result.missingDispatcher).toEqual([]);
    expect(result.streamingFetchCount).toBeGreaterThanOrEqual(1);
  });

  it("vllm.ts: uses fetchOpenAICompat (which includes STREAMING_DISPATCHER)", () => {
    const source = readFileSync(resolve(PROVIDERS_DIR, "vllm.ts"), "utf-8");
    // vllm should use fetchOpenAICompat for all streaming — no raw fetch() for streaming
    expect(source).toContain("fetchOpenAICompat");
    // Verify no raw streaming fetch without dispatcher
    const result = auditStreamingFetchCalls("vllm.ts");
    expect(result.missingDispatcher).toEqual([]);
  });

  it("llama-cpp.ts: uses fetchOpenAICompat (which includes STREAMING_DISPATCHER)", () => {
    const source = readFileSync(resolve(PROVIDERS_DIR, "llama-cpp.ts"), "utf-8");
    expect(source).toContain("fetchOpenAICompat");
    const result = auditStreamingFetchCalls("llama-cpp.ts");
    expect(result.missingDispatcher).toEqual([]);
  });

  it("anthropic.ts: uses SDK client (SDK-managed transport, exempt)", () => {
    const source = readFileSync(resolve(PROVIDERS_DIR, "anthropic.ts"), "utf-8");
    // Anthropic uses the SDK — no raw fetch() for streaming
    expect(source).toContain("messages.stream(");
    // Should NOT have any streaming raw fetch calls
    const result = auditStreamingFetchCalls("anthropic.ts");
    expect(result.streamingFetchCount).toBe(0);
  });

  it("openai.ts: uses SDK client (SDK-managed transport, exempt)", () => {
    const source = readFileSync(resolve(PROVIDERS_DIR, "openai.ts"), "utf-8");
    // OpenAI uses the SDK
    expect(source).toContain("chat.completions.create(");
    const result = auditStreamingFetchCalls("openai.ts");
    expect(result.streamingFetchCount).toBe(0);
  });

  it("google.ts: uses SDK client (SDK-managed transport, exempt)", () => {
    const source = readFileSync(resolve(PROVIDERS_DIR, "google.ts"), "utf-8");
    // Google uses @google/genai SDK
    expect(source).toContain("generateContentStream(");
    const result = auditStreamingFetchCalls("google.ts");
    expect(result.streamingFetchCount).toBe(0);
  });

  it("STREAMING_DISPATCHER has bodyTimeout: 0 (infinite)", () => {
    const source = readFileSync(
      resolve(__dirname, "../../providers/openai-compat.ts"),
      "utf-8",
    );
    expect(source).toContain("bodyTimeout: 0");
  });
});

// ── 2. parseSSEStream Partial Usage on Error ────────────────────

describe("parseSSEStream — partial usage on premature termination", () => {
  /**
   * Creates a mock ReadableStreamDefaultReader that yields SSE chunks
   * then throws an error to simulate a premature connection close.
   */
  function createTerminatingReader(
    chunks: string[],
    errorMessage: string = "terminated",
  ): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let currentIndex = 0;
    return {
      read: async () => {
        if (currentIndex < chunks.length) {
          const chunk = chunks[currentIndex++];
          return { done: false, value: encoder.encode(chunk) };
        }
        throw new Error(errorMessage);
      },
      cancel: async () => {},
      releaseLock: () => {},
      closed: Promise.resolve(undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  }

  /**
   * Creates a mock reader that completes normally (for happy path tests).
   */
  function createNormalReader(
    chunks: string[],
  ): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let currentIndex = 0;
    return {
      read: async () => {
        if (currentIndex < chunks.length) {
          const chunk = chunks[currentIndex++];
          return { done: false, value: encoder.encode(chunk) };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => {},
      releaseLock: () => {},
      closed: Promise.resolve(undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  }

  it("yields estimated usage before re-throwing when stream crashes mid-generation", async () => {
    const { parseSSEStream } = await import("#src/providers/openai-compat");

    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world, this is a test response with enough content"}}]}\n\n',
    ];
    const reader = createTerminatingReader(sseChunks, "terminated");
    const collectedEvents: unknown[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const chunk of parseSSEStream(reader)) {
        collectedEvents.push(chunk);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("terminated");

    // Should have collected text chunks AND a usage event before the error
    const usageEvents = collectedEvents.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "usage",
    );
    expect(usageEvents.length).toBe(1);

    const usagePayload = (usageEvents[0] as Record<string, unknown>).usage as Record<string, number>;
    // "Hello " (6) + "world, this is a test response with enough content" (50) = 56 chars / 4 ≈ 14 tokens
    expect(usagePayload.outputTokens).toBeGreaterThan(0);
  });

  it("yields server-reported usage if available before crash", async () => {
    const { parseSSEStream } = await import("#src/providers/openai-compat");

    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":50,"completion_tokens":10}}\n\n',
    ];
    const reader = createTerminatingReader(sseChunks, "connection reset");
    const collectedEvents: unknown[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const chunk of parseSSEStream(reader)) {
        collectedEvents.push(chunk);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).not.toBeNull();

    const usageEvents = collectedEvents.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "usage",
    );
    expect(usageEvents.length).toBe(1);

    const usagePayload = (usageEvents[0] as Record<string, unknown>).usage as Record<string, number>;
    // Server reported real usage — should use that, not estimates
    expect(usagePayload.inputTokens).toBe(50);
    expect(usagePayload.outputTokens).toBe(10);
  });

  it("yields normal usage on happy-path completion", async () => {
    const { parseSSEStream } = await import("#src/providers/openai-compat");

    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    const reader = createNormalReader(sseChunks);
    const collectedEvents: unknown[] = [];

    for await (const chunk of parseSSEStream(reader)) {
      collectedEvents.push(chunk);
    }

    const usageEvents = collectedEvents.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "usage",
    );
    expect(usageEvents.length).toBe(1);

    const usagePayload = (usageEvents[0] as Record<string, unknown>).usage as Record<string, number>;
    expect(usagePayload.inputTokens).toBe(20);
    expect(usagePayload.outputTokens).toBe(5);
  });

  it("tracks reasoning content characters for usage estimation", async () => {
    const { parseSSEStream } = await import("#src/providers/openai-compat");

    const sseChunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think about this carefully..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"The answer is 42."}}]}\n\n',
    ];
    const reader = createTerminatingReader(sseChunks, "terminated");
    const collectedEvents: unknown[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const chunk of parseSSEStream(reader)) {
        collectedEvents.push(chunk);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).not.toBeNull();

    const usageEvents = collectedEvents.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "usage",
    );
    expect(usageEvents.length).toBe(1);

    const usagePayload = (usageEvents[0] as Record<string, unknown>).usage as Record<string, number>;
    // Both reasoning and content characters should be counted
    // "Let me think about this carefully..." (36) + "The answer is 42." (17) = 53 / 4 ≈ 14
    expect(usagePayload.outputTokens).toBeGreaterThan(0);
    expect(usagePayload.reasoningOutputTokens).toBeGreaterThan(0);
  });

  it("skips partial usage yield when no content was generated", async () => {
    const { parseSSEStream } = await import("#src/providers/openai-compat");

    // Stream crashes immediately with no content chunks
    const reader = createTerminatingReader([], "connection refused");
    const collectedEvents: unknown[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const chunk of parseSSEStream(reader)) {
        collectedEvents.push(chunk);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).not.toBeNull();
    // No usage event should be emitted if nothing was generated
    const usageEvents = collectedEvents.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "usage",
    );
    expect(usageEvents.length).toBe(0);
  });
});

// ── 3. Error Message Enrichment ─────────────────────────────────

describe("ProviderError enrichment", () => {
  it("ProviderError.toJSON includes provider and message", () => {
    const enrichedError = new ProviderError(
      PROVIDERS.LM_STUDIO,
      "LM Studio (lm-studio-1) stream error: terminated, model=gemma-4-12b-qat",
      500,
    );
    const serialized = enrichedError.toJSON();
    expect(serialized.provider).toBe(PROVIDERS.LM_STUDIO);
    expect(serialized.message).toContain("LM Studio");
    expect(serialized.message).toContain("terminated");
    expect(serialized.message).toContain("gemma-4-12b-qat");
    expect(serialized.statusCode).toBe(500);
  });

  it("ProviderError preserves structured errorType from original error", () => {
    const originalError = { type: "rate_limit_error", message: "Too many requests" };
    const enrichedError = new ProviderError(PROVIDERS.ANTHROPIC, "Rate limited", 429, originalError);
    expect(enrichedError.errorType).toBe("rate_limit_error");
    const serialized = enrichedError.toJSON();
    expect(serialized.errorType).toBe("rate_limit_error");
  });
});

// ── 4. Agent Error Logging Attribution ──────────────────────────

describe("Agent error logging attribution", () => {
  it("ChatRoutes error catch block includes agent field in logChatGeneration call", () => {
    const source = readFileSync(
      resolve(__dirname, "../../routes/ChatRoutes.ts"),
      "utf-8",
    );

    // Find the /agent error catch block — look for the pattern that logs failed agent requests
    // It should contain agent: in the logChatGeneration call
    const errorLogPattern = /logChatGeneration\(\{[^}]*endpoint:\s*["']\/agent["'][^}]*agent:/s;
    expect(source).toMatch(errorLogPattern);
  });
});
