/**
 * POST /text-to-sound-effect — validation, the provider call, the two
 * response formats, and the per-second cost it logs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const generateSoundEffect = vi.hoisted(() => vi.fn());
const logRequest = vi.hoisted(() => vi.fn());

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ELEVENLABS_API_KEY: "test-key" };
});

vi.mock("#src/providers/index", () => ({
  getProvider: (name: string) =>
    name === "elevenlabs" ? { name, generateSoundEffect } : { name },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { log: logRequest },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
    provider: vi.fn(),
  },
}));

import soundEffectRouter from "#src/routes/SoundEffectRoutes";
import { errorHandler } from "#src/utils/errors";
import { ProviderError } from "#src/utils/errors";

const app = express();
app.use(express.json());
app.use("/text-to-sound-effect", soundEffectRouter);
app.use(errorHandler);
const agent = supertest(app);

/** Two seconds of 128 kbit/s MP3. */
const TWO_SECONDS_OF_MP3 = Buffer.alloc(32_000, 1);

describe("POST /text-to-sound-effect", () => {
  beforeEach(() => {
    generateSoundEffect.mockReset();
    logRequest.mockReset();
    generateSoundEffect.mockResolvedValue({
      audio: TWO_SECONDS_OF_MP3,
      contentType: "audio/mpeg",
    });
  });

  it("returns the clip as binary audio and passes the options through", async () => {
    const response = await agent
      .post("/text-to-sound-effect")
      .send({ prompt: "  wolf howl at the moon  ", durationSeconds: 4, loop: false })
      .expect(200);

    expect(response.headers["content-type"]).toContain("audio/mpeg");
    expect(response.body.length).toBe(TWO_SECONDS_OF_MP3.length);
    expect(generateSoundEffect).toHaveBeenCalledWith("wolf howl at the moon", {
      model: undefined,
      durationSeconds: 4,
      loop: false,
      promptInfluence: undefined,
    });
    // Billed per generated second: 4 s at $0.12/min.
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "text-to-sound-effect",
        provider: "elevenlabs",
        model: "eleven_text_to_sound_v2",
        success: true,
        estimatedCost: 0.008,
      }),
    );
  });

  it("returns a data URL, timing the clip from its size when the model chose the length", async () => {
    const response = await agent
      .post("/text-to-sound-effect?format=dataUrl")
      .send({ prompt: "door slams in an empty hall" })
      .expect(200);

    expect(response.body.audioDataUrl).toMatch(/^data:audio\/mpeg;base64,/);
    expect(response.body.contentType).toBe("audio/mpeg");
    expect(response.body.durationSeconds).toBe(2);
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCost: 0.004 }),
    );
  });

  it("refuses a missing prompt", async () => {
    const response = await agent
      .post("/text-to-sound-effect")
      .send({ durationSeconds: 3 })
      .expect(400);

    expect(response.body.message).toContain("Missing required field: prompt");
    expect(generateSoundEffect).not.toHaveBeenCalled();
  });

  it("refuses a duration ElevenLabs cannot render", async () => {
    await agent
      .post("/text-to-sound-effect")
      .send({ prompt: "thunder", durationSeconds: 45 })
      .expect(400);
    await agent
      .post("/text-to-sound-effect")
      .send({ prompt: "thunder", durationSeconds: "4" })
      .expect(400);

    expect(generateSoundEffect).not.toHaveBeenCalled();
  });

  it("refuses a provider without sound effects", async () => {
    const response = await agent
      .post("/text-to-sound-effect")
      .send({ prompt: "thunder", provider: "openai" })
      .expect(400);

    expect(response.body.message).toContain("does not support sound effects");
  });

  it("passes the provider's status through and logs the failure", async () => {
    generateSoundEffect.mockRejectedValue(
      new ProviderError("elevenlabs", "ElevenLabs sound effect error: 401 quota_exceeded", 401),
    );

    await agent
      .post("/text-to-sound-effect")
      .send({ prompt: "explosion" })
      .expect(401);

    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, endpoint: "text-to-sound-effect" }),
    );
  });
});
