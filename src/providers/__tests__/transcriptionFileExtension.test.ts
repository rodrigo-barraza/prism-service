import { describe, it, expect } from "vitest";
import { transcriptionFileExtension } from "../transcriptionFileExtension.ts";

// OpenAI reads the upload's format from its file name. Every Discord voice
// message (audio/ogg) and every MP3 (audio/mpeg, the route's default) used
// to go up as "audio.wav" and came back "400 This model does not support
// the format" — all 39 Lupos transcriptions in the 60 days to 2026-09-22.
describe("transcriptionFileExtension", () => {
  it("names a Discord voice message (Ogg Opus) .ogg", () => {
    expect(transcriptionFileExtension("audio/ogg")).toBe("ogg");
    expect(transcriptionFileExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(transcriptionFileExtension("audio/opus")).toBe("ogg");
  });

  it("names MP3 uploads .mp3, including the route's audio/mpeg default", () => {
    expect(transcriptionFileExtension("audio/mpeg")).toBe("mp3");
    expect(transcriptionFileExtension("audio/mp3")).toBe("mp3");
  });

  it("maps the other containers OpenAI accepts", () => {
    expect(transcriptionFileExtension("audio/mp4")).toBe("m4a");
    expect(transcriptionFileExtension("audio/x-m4a")).toBe("m4a");
    expect(transcriptionFileExtension("video/mp4")).toBe("mp4");
    expect(transcriptionFileExtension("audio/webm")).toBe("webm");
    expect(transcriptionFileExtension("audio/x-wav")).toBe("wav");
    expect(transcriptionFileExtension("audio/flac")).toBe("flac");
  });

  it("ignores case and keeps the wav default for unknown types", () => {
    expect(transcriptionFileExtension("Audio/OGG")).toBe("ogg");
    expect(transcriptionFileExtension("application/octet-stream")).toBe("wav");
    expect(transcriptionFileExtension("")).toBe("wav");
  });
});
