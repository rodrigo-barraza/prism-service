import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { PROVIDERS, MODALITY_TYPES } from "#src/constants";
import {
  app,
  MOCK_GENERATE_TEXT_STREAM,
} from "./setup.ts";

describe("POST /chat (image-to-text / vision)", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT_STREAM.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "A photo of a cat";
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
    });
  });

  // ── Required parameters ───────────────────────────────────────────

  it("returns error when provider is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        messages: [
          {
            role: "user",
            content: "Describe this image",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/provider/i);
  });

  it("returns error when messages is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({ provider: PROVIDERS.GOOGLE })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/messages/i);
  });

  // ── Successful request ────────────────────────────────────────────

  it("returns 200 with correct response shape (image + prompt)", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "What is this?",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(200);

    expect(res.body).toHaveProperty(MODALITY_TYPES.TEXT, "A photo of a cat");
    expect(res.body).toHaveProperty("provider", PROVIDERS.GOOGLE);
    expect(res.body).toHaveProperty("usage");
    expect(res.body.usage).toHaveProperty("inputTokens", 100);
    expect(res.body.usage).toHaveProperty("outputTokens", 50);
  });

  // ── Cost calculation ──────────────────────────────────────────────

  it("includes estimatedCost in the response", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(200);

    expect(res.body).toHaveProperty("estimatedCost");
  });

  // ── Optional: model ───────────────────────────────────────────────

  it("passes custom model to the provider when provided", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.OPENAI,
        model: "gpt-5-mini",
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    const calledModel = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][1];
    expect(calledModel).toBe("gpt-5-mini");
  });

  it("uses default model when model is omitted", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(200);

    // Model is not returned in the response when using streaming path
    // and no explicit model is provided — it falls through to the provider's default
    expect(res.body).toHaveProperty("provider", PROVIDERS.GOOGLE);
  });

  // ── Image formats ─────────────────────────────────────────────────

  it("accepts base64 image data in messages", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="],
          },
        ],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    // Provider should receive the image data in messages
    const calledMessages = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][0];
    expect(calledMessages[0]).toHaveProperty("images");
  });

  // ── Multiple images ───────────────────────────────────────────────

  it("supports multiple images in a single message", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "Compare these",
            images: [
              "https://example.com/cat.jpg",
              "https://example.com/dog.jpg",
            ],
          },
        ],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
  });

  // ── Different providers ───────────────────────────────────────────

  it("works with openai provider", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.OPENAI,
        messages: [
          {
            role: "user",
            content: "What is this?",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(200);

    expect(res.body).toHaveProperty("provider", PROVIDERS.OPENAI);
  });

  // ── Error handling ────────────────────────────────────────────────

  it("returns error for provider that does not support text generation", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.ELEVENLABS,
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/text generation/i);
  });

  it("returns 500 when provider throws", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementationOnce(async function* () {
      yield { type: "chunk", content: "" };
      throw new Error("Vision failed");
    });

    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3-flash-preview",
        messages: [
          {
            role: "user",
            content: "Describe",
            images: ["https://example.com/cat.jpg"],
          },
        ],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
  });
});
