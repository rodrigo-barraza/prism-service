import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import {
  app,
  MOCK_GENERATE_TEXT_STREAM,
} from "./setup.ts";

describe("POST /chat (text-to-text)", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT_STREAM.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello ";
      yield "from mock";
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    });
  });

  // ── Required parameters ───────────────────────────────────────────

  it("returns error when provider is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/provider/i);
  });

  it("returns error when messages is missing", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({ provider: "openai" })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/messages/i);
  });

  it("returns error when messages is not an array", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({ provider: "openai", messages: "not an array" })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/messages/i);
  });

  // ── Successful request ────────────────────────────────────────────

  it("returns 200 with correct response shape (minimal params)", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "Hello" }],
      })
      .expect(200);

    expect(res.body).toHaveProperty("text", "Hello from mock");
    expect(res.body).toHaveProperty("provider", "openai");
    expect(res.body).toHaveProperty("usage");
    expect(res.body.usage).toHaveProperty("inputTokens", 10);
    expect(res.body.usage).toHaveProperty("outputTokens", 5);
    expect(res.body).toHaveProperty("estimatedCost");
  });

  // ── Optional: model ───────────────────────────────────────────────

  it("uses the default model when model is omitted", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    // First arg is messages, second is model
    const calledModel = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][1];
    expect(typeof calledModel).toBe("string");
    expect(calledModel.length).toBeGreaterThan(0);
  });

  it("uses custom model when provided", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        model: "gpt-5.2",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    const calledModel = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][1];
    expect(calledModel).toBe("gpt-5.2");
  });

  // ── Optional: options ─────────────────────────────────────────────

  it("passes options through to the provider", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
        maxTokens: 100,
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    const calledOptions = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][2];
    expect(calledOptions).toMatchObject({ temperature: 0.5, maxTokens: 100 });
  });

  it("synchronizes thinkingLevel to reasoningEffort and vice-versa", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        thinkingLevel: "medium",
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    const calledOptions = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][2];
    expect(calledOptions).toMatchObject({
      thinkingLevel: "medium",
      reasoningEffort: "medium",
    });
  });

  it("defaults options to empty object when omitted", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    const calledOptions = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][2];
    expect(calledOptions).toMatchObject({});
  });

  // ── Multiple messages ─────────────────────────────────────────────

  it("handles multiple messages in the array", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "How are you?" },
        ],
      })
      .expect(200);

    const calledMessages = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][0];
    expect(calledMessages).toHaveLength(4);
  });

  // ── Different providers ───────────────────────────────────────────

  it("works with anthropic provider", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "anthropic",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    expect(res.body).toHaveProperty("provider", "anthropic");
  });

  it("works with google provider", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "google",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    expect(res.body).toHaveProperty("provider", "google");
  });

  it("works with openai-compatible provider", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai-compatible",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(200);

    expect(res.body).toHaveProperty("provider", "openai-compatible");
  });

  // ── Error handling ────────────────────────────────────────────────

  it("returns 500 when provider throws an error", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementationOnce(async function* () {
      yield { type: "error" };
      throw new Error("API down");
    });

    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/API down/);
  });

  it("returns error for unsupported provider that does not support text generation", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "elevenlabs",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
    expect(res.body.message).toMatch(/text generation/i);
  });

  it("returns error for unknown provider", async () => {
    const res = await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "nonexistent",
        messages: [{ role: "user", content: "hi" }],
      })
      .expect(500);

    expect(res.body).toHaveProperty("error", true);
  });

  it("injects tools into the system prompt when functionCallingEnabled is true", async () => {
    await request(app)
      .post("/chat?stream=false")
      .send({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        functionCallingEnabled: true,
        enabledTools: ["get_weather"],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalledTimes(1);
    const calledMessages = MOCK_GENERATE_TEXT_STREAM.mock.calls[0][0];
    const systemMessage = calledMessages.find((m: any) => m.role === "system");
    expect(systemMessage).toBeDefined();
    expect(systemMessage.content).toMatch(/Available Tools/i);
    expect(systemMessage.content).toMatch(/get_weather/i);
  });
});
