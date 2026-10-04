/**
 * A text reply Google blocks reports WHY, as the typed refusal the agent
 * loop already ends a turn on. Gemini 3.x streams its thoughts first and a
 * prompt block arrives last — `promptFeedback.blockReason`, no candidate,
 * no finishReason, at most a few words of text before the cut. Prism
 * dropped the block and read the reply as a pass that only reasoned: the
 * agent loop nudged it five times, then showed the model's last words,
 * "Sorry, I cannot fulfill your request.", as the answer (conversation
 * 9cf6ebdd, 2026-10-04; nine live replays, every one `blockReason: OTHER`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateMock = vi.hoisted(() => vi.fn());
const streamMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: streamMock, generateContent: generateMock };
    live = { connect: vi.fn() };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  MediaResolution: { LOW: "LOW", HIGH: "HIGH" },
  ServiceTier: { AUTO: "AUTO", STANDARD: "STANDARD" },
}));

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, GOOGLE_CLOUD_GEMINI_API_KEY: "test-key" };
});

import googleProvider, { textRefusalOf } from "#src/providers/google";

const MODEL = "gemini-3.8-flash";
const request = [{ role: "user", content: "Can we fix this from that?" }];
const thought = (text: string) => ({ candidates: [{ content: { parts: [{ text, thought: true }] } }] });
const words = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

function streamOf(chunks: unknown[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const refusalsIn = (chunks: unknown[]) =>
  chunks.filter((chunk) => (chunk as { type?: string })?.type === "refusal");

beforeEach(() => {
  generateMock.mockReset();
  streamMock.mockReset();
});

describe("textRefusalOf", () => {
  it("names a prompt block by its reason, with Google's message when it gives one", () => {
    expect(textRefusalOf({ blockReason: "OTHER" })).toEqual({ category: "OTHER", explanation: null });
    expect(
      textRefusalOf({ blockReason: "PROHIBITED_CONTENT", blockReasonMessage: " Blocked by policy. " }),
    ).toEqual({ category: "PROHIBITED_CONTENT", explanation: "Blocked by policy." });
  });

  it("names a candidate stopped for its content", () => {
    for (const finishReason of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE"]) {
      expect(textRefusalOf({ finishReason })?.category).toBe(finishReason);
    }
    expect(textRefusalOf({ finishReason: "SAFETY", finishMessage: "Unsafe." })?.explanation).toBe("Unsafe.");
  });

  it("is null for a reply that finished, ran out of tokens or fumbled a tool call", () => {
    for (const finishReason of [
      "STOP",
      "MAX_TOKENS",
      "MALFORMED_FUNCTION_CALL",
      "UNEXPECTED_TOOL_CALL",
      "OTHER",
      "FINISH_REASON_UNSPECIFIED",
    ]) {
      expect(textRefusalOf({ finishReason })).toBeNull();
    }
    expect(textRefusalOf({ blockReason: "BLOCKED_REASON_UNSPECIFIED", finishReason: "STOP" })).toBeNull();
    expect(textRefusalOf({})).toBeNull();
  });

  it("prefers the prompt's block reason", () => {
    expect(textRefusalOf({ blockReason: "OTHER", finishReason: "SAFETY" })?.category).toBe("OTHER");
  });
});

describe("Gemini generateTextStream — a blocked text reply", () => {
  it("yields a refusal when the stream ends on a prompt block after thoughts (no finishReason)", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        thought("**Analyzing Download Method**"),
        thought("**Analyzing Circumvention Potential**"),
        { promptFeedback: { blockReason: "OTHER" }, usageMetadata: { promptTokenCount: 10255, thoughtsTokenCount: 615 } },
      ]),
    );

    const chunks = await collect(googleProvider.generateTextStream(request, MODEL, {}));

    expect(chunks.filter((chunk) => (chunk as { type?: string }).type === "thinking")).toHaveLength(2);
    expect(refusalsIn(chunks)).toEqual([{ type: "refusal", category: "OTHER", explanation: null }]);
  });

  it("yields a refusal when the block cuts the answer after its first words", async () => {
    streamMock.mockResolvedValue(
      streamOf([thought("Weighing it."), words("Sorry, I cannot fulfill"), { promptFeedback: { blockReason: "OTHER" } }]),
    );

    const chunks = await collect(googleProvider.generateTextStream(request, MODEL, {}));

    expect(chunks).toContain("Sorry, I cannot fulfill");
    expect(refusalsIn(chunks)).toEqual([{ type: "refusal", category: "OTHER", explanation: null }]);
  });

  it("yields a refusal for a candidate stopped SAFETY, with its finish message", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        words("Here is"),
        { candidates: [{ content: { parts: [] }, finishReason: "SAFETY", finishMessage: "Unsafe content." }] },
      ]),
    );

    const chunks = await collect(googleProvider.generateTextStream(request, MODEL, {}));

    expect(refusalsIn(chunks)).toEqual([{ type: "refusal", category: "SAFETY", explanation: "Unsafe content." }]);
  });

  it("yields no refusal for a reply that finished", async () => {
    streamMock.mockResolvedValue(
      streamOf([thought("Easy."), { candidates: [{ content: { parts: [{ text: "The page has two columns." }] }, finishReason: "STOP" }] }]),
    );

    const chunks = await collect(googleProvider.generateTextStream(request, MODEL, {}));

    expect(refusalsIn(chunks)).toEqual([]);
    expect(chunks).toContain("The page has two columns.");
  });

  it("yields a refusal for a thrown safety block on a text request", async () => {
    streamMock.mockRejectedValue(new Error("[400] Response was blocked due to PROHIBITED_CONTENT"));

    const chunks = await collect(googleProvider.generateTextStream(request, MODEL, {}));

    expect(refusalsIn(chunks)).toHaveLength(1);
    expect((refusalsIn(chunks)[0] as { category: string }).category).toBe("PROHIBITED_CONTENT");
  });

  it("says nothing when the caller stopped the stream", async () => {
    const controller = new AbortController();
    controller.abort();
    streamMock.mockResolvedValue(streamOf([{ promptFeedback: { blockReason: "OTHER" } }]));

    const chunks = await collect(
      googleProvider.generateTextStream(request, MODEL, { signal: controller.signal }),
    );

    expect(refusalsIn(chunks)).toEqual([]);
  });
});

describe("Gemini generateText — a blocked text reply", () => {
  it("reports a prompt block as a refusal, and no answer", async () => {
    generateMock.mockResolvedValue({
      promptFeedback: { blockReason: "OTHER" },
      candidates: [{ content: { parts: [{ text: "Sorry, I cannot fulfill" }] } }],
    });

    const result = await googleProvider.generateText(request, MODEL, {});

    expect(result.refusal).toEqual({ category: "OTHER", explanation: null });
    expect(result.text).toBe("");
  });

  it("leaves a finished answer alone", async () => {
    generateMock.mockResolvedValue({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Two columns." }] } }],
    });

    const result = await googleProvider.generateText(request, MODEL, {});

    expect(result.refusal).toBeUndefined();
    expect(result.text).toBe("Two columns.");
  });

  it("names the category of a thrown safety block", async () => {
    generateMock.mockRejectedValue(new Error("[400] Response was blocked due to SAFETY"));

    const result = await googleProvider.generateText(request, MODEL, {});

    expect(result.safetyBlock).toBe(true);
    expect(result.refusal?.category).toBe("SAFETY");
  });
});
