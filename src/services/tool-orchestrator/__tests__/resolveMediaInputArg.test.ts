import { describe, it, expect } from "vitest";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

const CDN_URL = "https://cdn.discordapp.com/attachments/1/2/cow.png?ex=abc";
const AVATAR_URL = "https://cdn.discordapp.com/avatars/3/4.png";
const AUDIO_URL = "https://cdn.discordapp.com/attachments/1/2/voice.ogg";
const VIDEO_URL = "https://cdn.discordapp.com/attachments/1/2/clip.mp4";

const messagesWithImage = [
  { role: "system" },
  { role: "user", images: [AVATAR_URL] },
  { role: "assistant" },
  { role: "user", images: [CDN_URL] },
];

describe("resolveMediaInputArg", () => {
  it("fills a missing input from the last user message's image", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { operations: [{ type: "rotate", angle: 45 }] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("resolves the 'attached' sentinel (case-insensitive, trimmed)", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: " Attached ", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("replaces a model-typed base64 data URI when a conversation image exists", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: "data:image/png;base64,AAAA", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("respects a model-provided http URL (no clobbering)", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: "https://example.com/other.png", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe("https://example.com/other.png");
  });

  it("respects an imageId from a previous call (chaining)", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: "img_9f2c1a", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe("img_9f2c1a");
  });

  it("uses the LAST user message with media, not an earlier one", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "scan_barcode",
      {},
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("maps the arg name per tool (detect_objects/remove_background use 'image')", () => {
    for (const tool of ["detect_objects", "remove_background"]) {
      const args = ToolOrchestratorService.resolveMediaInputArg(
        tool,
        { image: "attached" },
        messagesWithImage,
      );
      expect(args.image).toBe(CDN_URL);
    }
  });

  it("resolves remix_audio from the audio field, not images", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "remix_audio",
      { input: "attached", operations: [] },
      [{ role: "user", images: [CDN_URL], audio: [AUDIO_URL] }],
    );
    expect(args.input).toBe(AUDIO_URL);
  });

  it("does NOT feed an image to remix_audio when no audio exists", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "remix_audio",
      { input: "attached", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe("attached");
  });

  it("resolves transcribe_audio's audioUrl arg", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "transcribe_audio",
      {},
      [{ role: "user", audio: [AUDIO_URL] }],
    );
    expect(args.audioUrl).toBe(AUDIO_URL);
  });

  it("resolves trim_video from video first, then images (Discord clients attach videos via images[])", () => {
    const viaVideoField = ToolOrchestratorService.resolveMediaInputArg(
      "trim_video",
      { url: "attached" },
      [{ role: "user", video: [VIDEO_URL], images: [CDN_URL] }],
    );
    expect(viaVideoField.url).toBe(VIDEO_URL);

    const viaImagesFallback = ToolOrchestratorService.resolveMediaInputArg(
      "trim_video",
      { url: "attached" },
      [{ role: "user", images: [VIDEO_URL] }],
    );
    expect(viaImagesFallback.url).toBe(VIDEO_URL);
  });

  it("resolves generate_audio's sampleSource only on the explicit sentinel", () => {
    const resolved = ToolOrchestratorService.resolveMediaInputArg(
      "generate_audio",
      { action: "add_channel", channelId: "vox", sampleSource: "attached" },
      [{ role: "user", audio: [AUDIO_URL] }],
    );
    expect(resolved.sampleSource).toBe(AUDIO_URL);
  });

  it("does NOT inject audio into generate_audio calls that omit sampleSource", () => {
    for (const args of [
      { action: "init", tempo: 120 },
      { action: "add_channel", channelId: "bass", instrument: "synth_bass" },
      { action: "render", sessionId: "abc" },
    ]) {
      const resolved = ToolOrchestratorService.resolveMediaInputArg(
        "generate_audio",
        args,
        [{ role: "user", audio: [AUDIO_URL] }],
      );
      expect(resolved.sampleSource).toBeUndefined();
    }
  });

  it("resolves read_pdf from the pdf field first, then documents", () => {
    const PDF_URL = "https://cdn.example.com/files/report.pdf";
    const DOC_URL = "https://cdn.example.com/files/report.docx";

    const viaPdfField = ToolOrchestratorService.resolveMediaInputArg(
      "read_pdf",
      { url: "attached" },
      [{ role: "user", pdf: [PDF_URL], documents: [DOC_URL] }],
    );
    expect(viaPdfField.url).toBe(PDF_URL);

    const viaDocumentsFallback = ToolOrchestratorService.resolveMediaInputArg(
      "read_pdf",
      { url: "attached" },
      [{ role: "user", documents: [PDF_URL] }],
    );
    expect(viaDocumentsFallback.url).toBe(PDF_URL);
  });

  it("resolves read_docx and read_spreadsheet from the documents field", () => {
    const DOC_URL = "https://cdn.example.com/files/notes.docx";
    for (const tool of ["read_docx", "read_spreadsheet"]) {
      const args = ToolOrchestratorService.resolveMediaInputArg(
        tool,
        {},
        [{ role: "user", documents: [DOC_URL] }],
      );
      expect(args.url).toBe(DOC_URL);
    }
  });

  it("resolves read_csv's source arg from the documents field", () => {
    const CSV_URL = "https://cdn.example.com/files/data.csv";
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "read_csv",
      { source: "attached" },
      [{ role: "user", documents: [CSV_URL] }],
    );
    expect(args.source).toBe(CSV_URL);
  });

  it("does NOT feed images to document readers", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "read_csv",
      { source: "attached" },
      messagesWithImage,
    );
    expect(args.source).toBe("attached");
  });

  it("leaves non-media tools untouched", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "search_web",
      { query: "attached" },
      messagesWithImage,
    );
    expect(args.query).toBe("attached");
  });

  it("keeps a model-typed data URI when no conversation media exists", () => {
    const dataUri = "data:image/png;base64,BBBB";
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: dataUri, operations: [] },
      [{ role: "user" }],
    );
    expect(args.input).toBe(dataUri);
  });

  it("leaves args unchanged when unresolvable and no media exists", () => {
    const args = ToolOrchestratorService.resolveMediaInputArg(
      "manipulate_image",
      { input: "attached", operations: [] },
      [{ role: "user" }],
    );
    expect(args.input).toBe("attached");
  });

  it("skips non-string entries and picks the first usable image in the message", () => {
    const messages = [
      {
        role: "user",
        images: [undefined as unknown as string, "minio://bucket/key", CDN_URL],
      },
    ];
    expect(
      ToolOrchestratorService.findLastUserMedia(messages, ["images"]),
    ).toBe(CDN_URL);
  });

  it("stops at the most recent user message carrying the field (stale media ignored)", () => {
    const messages = [
      { role: "user", audio: [AUDIO_URL] },
      { role: "user", audio: ["minio://old/unusable"] },
    ];
    // The newest audio-bearing message has no usable entry — do not fall
    // back to older messages.
    expect(
      ToolOrchestratorService.findLastUserMedia(messages, ["audio"]),
    ).toBeNull();
  });
});
