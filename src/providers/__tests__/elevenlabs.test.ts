/**
 * ElevenLabs provider — the request each call sends.
 *
 *   - the TTS model is the one the route passes as `model` (it used to read
 *     only `modelId`, so every configured model fell back to the default)
 *   - a catalog label ("Callum") becomes the voice ID the API takes; an
 *     unknown name falls back to the default voice instead of a 404
 *   - sound effects go to /v1/sound-generation with only the options asked
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ELEVENLABS_API_KEY: "test-key" };
});

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

import elevenlabsProvider, {
  resolveVoiceId,
  resolveSpeechModel,
  SOUND_EFFECT_MODEL,
} from "#src/providers/elevenlabs";
import { DEFAULT_VOICES } from "#src/config";

const CALLUM = "N2lVS1w4EtoT3dr4eOWO";
const fetchMock = vi.fn();

function audioResponse(bytes = "mp3-bytes") {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function sentBody(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveVoiceId", () => {
  it("maps a catalog label to its voice ID, in any case", () => {
    expect(resolveVoiceId("Callum")).toBe(CALLUM);
    expect(resolveVoiceId("callum")).toBe(CALLUM);
    expect(resolveVoiceId("Callum (husky, gravelly trickster, M)")).toBe(
      CALLUM,
    );
  });

  it("passes a voice ID through", () => {
    expect(resolveVoiceId("JBFqnCBsd6RMkjVDRZzb")).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  it("gives the default voice for a missing or retired name", () => {
    expect(resolveVoiceId(undefined)).toBe(DEFAULT_VOICES.elevenlabs);
    expect(resolveVoiceId("  ")).toBe(DEFAULT_VOICES.elevenlabs);
    expect(resolveVoiceId("Rachel")).toBe(DEFAULT_VOICES.elevenlabs);
  });

  it("defaults to Callum, Lupos's voice", () => {
    expect(DEFAULT_VOICES.elevenlabs).toBe(CALLUM);
  });
});

describe("resolveSpeechModel", () => {
  it("takes the model the route passes", () => {
    expect(resolveSpeechModel({ model: "eleven_v4" })).toBe("eleven_v4");
  });

  it("still honours the older modelId", () => {
    expect(resolveSpeechModel({ modelId: "eleven_v3" })).toBe("eleven_v3");
  });

  it("defaults to the catalog default, eleven_v4", () => {
    expect(resolveSpeechModel({})).toBe("eleven_v4");
  });
});

describe("generateSpeech", () => {
  it("sends the requested model and the voice ID behind a label", async () => {
    fetchMock.mockResolvedValue(audioResponse());

    await elevenlabsProvider.generateSpeech("[snarls] Get out.", "Callum", {
      model: "eleven_v4",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${CALLUM}/stream`,
    );
    expect(sentBody()).toEqual({
      text: "[snarls] Get out.",
      model_id: "eleven_v4",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });
  });

  it("keeps a stability of zero instead of replacing it", async () => {
    fetchMock.mockResolvedValue(audioResponse());

    await elevenlabsProvider.generateSpeech("Hi.", undefined, { stability: 0 });

    expect(sentBody().voice_settings.stability).toBe(0);
  });
});

describe("generateSoundEffect", () => {
  it("posts the prompt and the options asked for to sound-generation", async () => {
    fetchMock.mockResolvedValue(audioResponse("sfx-bytes"));

    const result = await elevenlabsProvider.generateSoundEffect(
      "lone wolf howling across a frozen valley",
      { durationSeconds: 4, loop: false },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(init.headers["xi-api-key"]).toBe("test-key");
    expect(sentBody()).toEqual({
      text: "lone wolf howling across a frozen valley",
      model_id: SOUND_EFFECT_MODEL,
      duration_seconds: 4,
      loop: false,
    });
    expect(result.audio.toString()).toBe("sfx-bytes");
    expect(result.contentType).toBe("audio/mpeg");
  });

  it("leaves the length to the model when none is asked", async () => {
    fetchMock.mockResolvedValue(audioResponse());

    await elevenlabsProvider.generateSoundEffect("door slams");

    expect(sentBody()).toEqual({
      text: "door slams",
      model_id: SOUND_EFFECT_MODEL,
    });
  });

  it("surfaces ElevenLabs' status code", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }),
    );

    await expect(
      elevenlabsProvider.generateSoundEffect("explosion"),
    ).rejects.toMatchObject({ provider: "elevenlabs", statusCode: 401 });
  });
});
