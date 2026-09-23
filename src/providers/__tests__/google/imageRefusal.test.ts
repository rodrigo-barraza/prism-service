/**
 * A forced image generation that comes back without an image reports WHY,
 * as the typed refusal /chat already carries. A Gemini image model that
 * declines rarely throws: it ends the candidate with IMAGE_SAFETY /
 * PROHIBITED_CONTENT / NO_IMAGE or blocks the prompt, and returns no image
 * part. generate_image saw only "no image", told the agent to try a more
 * specific prompt, and the same refused subject was redrawn up to five
 * times (18% of Lupos's image calls, 2026-08-23 → 09-22).
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

import googleProvider, { imageRefusalOf } from "#src/providers/google";

const IMAGE_MODEL = "gemini-3-pro-image";
const forced = { forceImageGeneration: true };
const drawRequest = [{ role: "user", content: "draw it" }];
const imagePart = { inlineData: { data: "aW1n", mimeType: "image/png" } };

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

describe("imageRefusalOf", () => {
  it("is null when no image was forced, or one came back", () => {
    expect(imageRefusalOf({ imageCount: 0, finishReason: "IMAGE_SAFETY" })).toBeNull();
    expect(
      imageRefusalOf({ forceImageGeneration: true, imageCount: 1, finishReason: "IMAGE_SAFETY" }),
    ).toBeNull();
  });

  it("leaves MAX_TOKENS to the truncation path", () => {
    expect(
      imageRefusalOf({ forceImageGeneration: true, imageCount: 0, finishReason: "MAX_TOKENS" }),
    ).toBeNull();
  });

  it("prefers the prompt's block reason, then the finish reason, then NO_IMAGE", () => {
    expect(
      imageRefusalOf({
        forceImageGeneration: true,
        imageCount: 0,
        finishReason: "OTHER",
        blockReason: "PROHIBITED_CONTENT",
      })?.category,
    ).toBe("PROHIBITED_CONTENT");
    expect(
      imageRefusalOf({ forceImageGeneration: true, imageCount: 0, finishReason: "IMAGE_SAFETY" })
        ?.category,
    ).toBe("IMAGE_SAFETY");
    expect(
      imageRefusalOf({ forceImageGeneration: true, imageCount: 0, finishReason: "STOP" })?.category,
    ).toBe("NO_IMAGE");
  });

  it("explains with the finish message, else the text the model wrote instead", () => {
    expect(
      imageRefusalOf({
        forceImageGeneration: true,
        imageCount: 0,
        finishReason: "IMAGE_SAFETY",
        finishMessage: " Unable to show that. ",
        text: "ignored",
      })?.explanation,
    ).toBe("Unable to show that.");
    expect(
      imageRefusalOf({
        forceImageGeneration: true,
        imageCount: 0,
        finishReason: "STOP",
        text: "I can't depict real people.",
      })?.explanation,
    ).toBe("I can't depict real people.");
  });
});

describe("Gemini generateText — forced image generation", () => {
  it("reports an IMAGE_SAFETY finish with no image as a refusal", async () => {
    generateMock.mockResolvedValue({
      candidates: [{ finishReason: "IMAGE_SAFETY", finishMessage: "Unable to show that.", content: { parts: [] } }],
    });

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, forced);

    expect(result.refusal).toEqual({ category: "IMAGE_SAFETY", explanation: "Unable to show that." });
    expect(result.images).toBeUndefined();
    expect(result.text).toBe("");
  });

  it("reports a blocked prompt (no candidates at all)", async () => {
    generateMock.mockResolvedValue({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, forced);

    expect(result.refusal?.category).toBe("PROHIBITED_CONTENT");
  });

  it("turns text instead of an image into NO_IMAGE, with the text as the explanation", async () => {
    generateMock.mockResolvedValue({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "I can't draw that person." }] } }],
    });

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, forced);

    expect(result.refusal).toEqual({ category: "NO_IMAGE", explanation: "I can't draw that person." });
    expect(result.text).toBe("");
  });

  it("returns the image and no refusal when one is drawn", async () => {
    generateMock.mockResolvedValue({
      candidates: [{ finishReason: "STOP", content: { parts: [imagePart] } }],
    });

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, forced);

    expect(result.refusal).toBeUndefined();
    expect(result.images).toHaveLength(1);
  });

  it("leaves a text answer alone when no image was forced", async () => {
    generateMock.mockResolvedValue({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "A cat is a mammal." }] } }],
    });

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, {});

    expect(result.refusal).toBeUndefined();
    expect(result.text).toBe("A cat is a mammal.");
  });

  it("names the category of a thrown safety block", async () => {
    generateMock.mockRejectedValue(new Error("[400] Response was blocked due to IMAGE_PROHIBITED_CONTENT"));

    const result = await googleProvider.generateText(drawRequest, IMAGE_MODEL, forced);

    expect(result.safetyBlock).toBe(true);
    expect(result.refusal?.category).toBe("IMAGE_PROHIBITED_CONTENT");
  });
});

describe("Gemini generateTextStream — forced image generation", () => {
  it("yields a refusal when the stream ends IMAGE_SAFETY without an image", async () => {
    streamMock.mockResolvedValue(
      streamOf([
        { candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY", finishMessage: "Unable to show that." }] },
      ]),
    );

    const chunks = await collect(googleProvider.generateTextStream(drawRequest, IMAGE_MODEL, forced));

    expect(refusalsIn(chunks)).toEqual([
      { type: "refusal", category: "IMAGE_SAFETY", explanation: "Unable to show that." },
    ]);
  });

  it("yields no refusal once an image streamed", async () => {
    streamMock.mockResolvedValue(
      streamOf([{ candidates: [{ content: { parts: [imagePart] }, finishReason: "STOP" }] }]),
    );

    const chunks = await collect(googleProvider.generateTextStream(drawRequest, IMAGE_MODEL, forced));

    expect(refusalsIn(chunks)).toEqual([]);
  });

  it("yields a refusal for a thrown safety block", async () => {
    streamMock.mockRejectedValue(new Error("Response was blocked: SAFETY"));

    const chunks = await collect(googleProvider.generateTextStream(drawRequest, IMAGE_MODEL, forced));

    expect(refusalsIn(chunks)).toHaveLength(1);
    expect((refusalsIn(chunks)[0] as { category: string }).category).toBe("SAFETY");
  });

  it("says nothing when the caller stopped the stream", async () => {
    const controller = new AbortController();
    controller.abort();
    streamMock.mockResolvedValue(
      streamOf([{ candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] }]),
    );

    const chunks = await collect(
      googleProvider.generateTextStream(drawRequest, IMAGE_MODEL, { ...forced, signal: controller.signal }),
    );

    expect(refusalsIn(chunks)).toEqual([]);
  });
});
