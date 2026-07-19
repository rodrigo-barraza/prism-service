import { describe, it, expect, vi, beforeEach } from "vitest";
import { processToolResultMedia } from "#src/services/harnesses/lifecycle/PostExecutionEmitter";
import FileService from "#src/services/FileService";

vi.mock("#src/services/FileService", () => ({
  default: {
    uploadFile: vi.fn(),
    getPublicUrl: vi.fn(),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolEmoji: vi.fn().mockReturnValue("🔊"),
    getToolLabel: vi.fn().mockReturnValue("audio"),
  },
}));

function makeState() {
  return {
    streamedImages: [],
    streamedAudioChunks: [],
    toolErrorCounts: new Map(),
  } as never;
}

describe("processToolResultMedia — audio upload ref stamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(FileService.uploadFile).mockResolvedValue({
      ref: "minio://generations/a.wav",
      size: 4,
      contentType: "audio/wav",
    });
  });

  it("stamps audioRef and display with the PUBLIC url, never the minio:// ref", async () => {
    vi.mocked(FileService.getPublicUrl).mockReturnValue(
      "https://storage.example.dev/prism/generations/a.wav",
    );
    const result = {
      id: "t1",
      name: "generate_audio",
      result: {
        success: true,
        audio: { data: "AAAA", mimeType: "audio/wav" },
      } as Record<string, unknown>,
    };

    await processToolResultMedia(
      [{ id: "t1", name: "generate_audio", args: {} }] as never,
      [result] as never,
      makeState(),
      { streamedImages: [] } as never,
      vi.fn(),
    );

    expect(result.result.audioRef).toBe(
      "https://storage.example.dev/prism/generations/a.wav",
    );
    expect(result.result.audio).toBeUndefined();
    expect(result.result.display).toMatchObject({
      kind: "audio",
      url: "https://storage.example.dev/prism/generations/a.wav",
    });
  });

  it("falls back to the raw ref only when no public URL is resolvable", async () => {
    vi.mocked(FileService.getPublicUrl).mockReturnValue(null);
    const result = {
      id: "t1",
      name: "synthesize_speech",
      result: {
        audio: { data: "AAAA", mimeType: "audio/mpeg" },
      } as Record<string, unknown>,
    };

    await processToolResultMedia(
      [{ id: "t1", name: "synthesize_speech", args: {} }] as never,
      [result] as never,
      makeState(),
      { streamedImages: [] } as never,
      vi.fn(),
    );

    expect(result.result.audioRef).toBe("minio://generations/a.wav");
  });

  it("preserves a display already set by the tool (tools-service public URL wins)", async () => {
    vi.mocked(FileService.getPublicUrl).mockReturnValue(
      "https://storage.example.dev/prism/generations/a.wav",
    );
    const toolDisplay = {
      kind: "audio",
      url: "https://storage.rod.dev/artifacts/tool-assets/tts.mp3",
      title: "Text-to-speech",
    };
    const result = {
      id: "t1",
      name: "synthesize_speech",
      result: {
        audio: { data: "AAAA", mimeType: "audio/mpeg" },
        display: { ...toolDisplay },
      } as Record<string, unknown>,
    };

    await processToolResultMedia(
      [{ id: "t1", name: "synthesize_speech", args: {} }] as never,
      [result] as never,
      makeState(),
      { streamedImages: [] } as never,
      vi.fn(),
    );

    expect(result.result.display).toEqual(toolDisplay);
  });
});
