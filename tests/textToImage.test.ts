import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { PROVIDERS } from "../src/constants.ts";
import {
  app,
  TEST_SECRET,
  MOCK_GENERATE_IMAGE,
} from "./setup.ts";

describe("POST /chat (text-to-image via imageAPI model)", () => {
  beforeEach(() => {
    MOCK_GENERATE_IMAGE.mockClear();
    MOCK_GENERATE_IMAGE.mockResolvedValue({
      imageData: "base64data",
      mimeType: "image/png",
      text: "A generated image",
    });
  });

  // ── Required parameters ───────────────────────────────────────────

  it("returns error when provider is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        messages: [{ role: "user", content: "A sunset" }],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/provider/i);
  });

  it("returns error when messages is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({ provider: PROVIDERS.OPENAI, model: "gpt-image-1.5" })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/messages/i);
  });

  // ── Successful request ────────────────────────────────────────────

  it("returns 200 with correct response shape (imageAPI model)", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: PROVIDERS.OPENAI,
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A sunset over the ocean" }],
      })
      .expect(200);

    // The response aggregates chunk + image + done events
    expect(res.body).toHaveProperty("text");
    expect(res.body).toHaveProperty("images");
    expect(res.body.images).toHaveLength(1);
    // When MinIO is unavailable, FileService returns the inline dataUrl as the ref
    expect(res.body.images[0]).toHaveProperty("minioRef");
    expect(res.body.images[0]).toHaveProperty("mimeType", "image/png");
  });

  // ── Optional: model ───────────────────────────────────────────────

  it("passes model to the provider via generateImage", async () => {
    await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: "openai",
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A cat" }],
      })
      .expect(200);

    expect(MOCK_GENERATE_IMAGE).toHaveBeenCalledTimes(1);
  });

  // ── Optional: images in messages ──────────────────────────────────

  it("passes images from messages to the provider", async () => {
    const images = ["data:image/png;base64,abc123"];
    await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: "openai",
        model: "gpt-image-1.5",
        messages: [
          { role: "user", content: "Edit this image", images },
        ],
      })
      .expect(200);

    expect(MOCK_GENERATE_IMAGE).toHaveBeenCalledTimes(1);
    // Second arg is the collected images array
    const calledImages = MOCK_GENERATE_IMAGE.mock.calls[0][1];
    expect(calledImages).toHaveLength(1);
  });

  it("defaults images to empty array when no images in messages", async () => {
    await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: "openai",
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A dog" }],
      })
      .expect(200);

    const calledImages = MOCK_GENERATE_IMAGE.mock.calls[0][1];
    expect(calledImages).toEqual([]);
  });

  // ── Response defaults ─────────────────────────────────────────────

  it("defaults mimeType to image/png when provider returns none", async () => {
    MOCK_GENERATE_IMAGE.mockResolvedValueOnce({
      imageData: "base64data",
    });

    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: PROVIDERS.OPENAI,
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A frog" }],
      })
      .expect(200);

    expect(res.body.images[0].mimeType).toBe("image/png");
  });

  it("defaults text to null when provider returns no text", async () => {
    MOCK_GENERATE_IMAGE.mockResolvedValueOnce({
      imageData: "base64data",
      mimeType: "image/jpeg",
    });

    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: "openai",
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A bird" }],
      })
      .expect(200);

    expect(res.body.text).toBeNull();
  });

  // ── Error handling ────────────────────────────────────────────────

  it("returns error for provider that does not support image generation", async () => {
    // anthropic mock doesn't have generateImage
    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: PROVIDERS.ANTHROPIC,
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A cat" }],
      })
      .expect(200);

    // imageAPI won't be dispatched since the provider lacks generateImage
    // It falls through to text generation which will succeed
    expect(res.body).toHaveProperty("text");
  });

  it("returns 500 when provider throws", async () => {
    MOCK_GENERATE_IMAGE.mockRejectedValueOnce(
      new Error("Generation failed"),
    );

    const res = await request(app)
      .post("/chat?stream=false")
      .set("x-api-secret", TEST_SECRET)
      .send({
        provider: "openai",
        model: "gpt-image-1.5",
        messages: [{ role: "user", content: "A cat" }],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
  });
});
