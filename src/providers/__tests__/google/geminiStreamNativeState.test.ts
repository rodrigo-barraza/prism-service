/**
 * What the Gemini stream hands the harness to store on the assistant
 * message: the response's parts in order with their thought signatures
 * (`geminiParts`), and Google Search grounding as a citations chunk.
 * Chunk shapes are the ones gemini-3.8-flash streamed live on 2026-09-22.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: streamMock, generateContent: vi.fn() };
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

import googleProvider from "#src/providers/google";

function streamOf(chunks: unknown[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}
const partsChunk = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts }, ...extra }],
});

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const ofType = (chunks: unknown[], type: string) =>
  chunks.filter((chunk) => (chunk as { type?: string })?.type === type) as Array<Record<string, unknown>>;

beforeEach(() => streamMock.mockReset());

describe("Gemini stream — geminiParts", () => {
  it("records text, calls and the trailing signature part in the order streamed", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        partsChunk([{ text: "Rome, the Eternal City" }]),
        partsChunk([{ text: "." }]),
        partsChunk([
          { functionCall: { name: "get_weather", args: { city: "Rome" } }, thoughtSignature: "sig-fc" },
          { functionCall: { name: "get_weather", args: { city: "Milan" } } },
        ]),
        partsChunk([{ text: "", thoughtSignature: "sig-trailing" }], { finishReason: "STOP" }),
      ]),
    );
    const chunks = await collect(
      googleProvider.generateTextStream([{ role: "user", content: "go" }], "gemini-3.8-flash", {}),
    );
    const state = ofType(chunks, "providerState").find((chunk) => chunk.geminiParts);
    expect(state?.geminiParts).toEqual([
      { text: "Rome, the Eternal City." },
      { functionCall: 0, thoughtSignature: "sig-fc" },
      { functionCall: 1 },
      { text: "", thoughtSignature: "sig-trailing" },
    ]);
  });

  it("keeps a thought part only when it carries a signature", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        partsChunk([{ text: "summary without sig", thought: true }]),
        partsChunk([{ text: "signed thought", thought: true, thoughtSignature: "sig-th" }]),
        partsChunk([{ text: "The answer.", thoughtSignature: "sig-text" }]),
      ]),
    );
    const chunks = await collect(
      googleProvider.generateTextStream([{ role: "user", content: "go" }], "gemini-3.8-flash", {}),
    );
    expect(ofType(chunks, "providerState").find((chunk) => chunk.geminiParts)?.geminiParts).toEqual([
      { thought: true, text: "signed thought", thoughtSignature: "sig-th" },
      { text: "The answer.", thoughtSignature: "sig-text" },
    ]);
  });

  it("sends no sampling parameters to gemini-3.8-flash", async () => {
    streamMock.mockResolvedValue(streamOf([partsChunk([{ text: "hi" }])]));
    await collect(
      googleProvider.generateTextStream([{ role: "user", content: "go" }], "gemini-3.8-flash", {
        temperature: 0.1,
        topP: 0.2,
        topK: 3,
      }),
    );
    const config = streamMock.mock.calls[0][0].config;
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });
});

describe("Gemini stream — Google Search grounding", () => {
  it("turns groundingMetadata into a citations chunk", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        partsChunk([{ text: "Antonelli won the Spanish Grand Prix." }]),
        partsChunk([{ text: "", thoughtSignature: "sig" }], {
          finishReason: "STOP",
          groundingMetadata: {
            searchEntryPoint: { renderedContent: "<style>…</style>" },
            webSearchQueries: ["most recent Formula 1 race 2026 result"],
            groundingChunks: [
              { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/A", title: "formula1.com" } },
              { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/B", title: "usatoday.com" } },
            ],
            groundingSupports: [
              {
                segment: { endIndex: 37, text: "Antonelli won the Spanish Grand Prix" },
                groundingChunkIndices: [0, 1],
              },
            ],
          },
        }),
      ]),
    );
    const chunks = await collect(
      googleProvider.generateTextStream([{ role: "user", content: "F1?" }], "gemini-3.8-flash", {
        webSearch: true,
      }),
    );
    expect(ofType(chunks, "citations")).toEqual([
      {
        type: "citations",
        sources: [
          { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/A", title: "formula1.com" },
          { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/B", title: "usatoday.com" },
        ],
        queries: ["most recent Formula 1 race 2026 result"],
        supports: [{ text: "Antonelli won the Spanish Grand Prix", sources: [0, 1] }],
      },
    ]);
  });

  it("yields no citations chunk without grounding", async () => {
    streamMock.mockResolvedValue(streamOf([partsChunk([{ text: "hi" }])]));
    const chunks = await collect(
      googleProvider.generateTextStream([{ role: "user", content: "go" }], "gemini-3.8-flash", {}),
    );
    expect(ofType(chunks, "citations")).toEqual([]);
  });
});
