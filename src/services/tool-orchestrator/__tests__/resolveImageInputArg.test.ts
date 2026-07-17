import { describe, it, expect } from "vitest";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

const CDN_URL = "https://cdn.discordapp.com/attachments/1/2/cow.png?ex=abc";
const AVATAR_URL = "https://cdn.discordapp.com/avatars/3/4.png";

const messagesWithImage = [
  { role: "system" },
  { role: "user", images: [AVATAR_URL] },
  { role: "assistant" },
  { role: "user", images: [CDN_URL] },
];

describe("resolveImageInputArg", () => {
  it("fills a missing input from the last user message's image", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { operations: [{ type: "rotate", angle: 45 }] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("resolves the 'attached' sentinel (case-insensitive, trimmed)", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { input: " Attached ", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("replaces a model-typed base64 data URI when a conversation image exists", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { input: "data:image/png;base64,AAAA", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("respects a model-provided http URL (no clobbering)", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { input: "https://example.com/other.png", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe("https://example.com/other.png");
  });

  it("respects an imageId from a previous call (chaining)", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { input: "img_9f2c1a", operations: [] },
      messagesWithImage,
    );
    expect(args.input).toBe("img_9f2c1a");
  });

  it("uses the LAST user message with images, not an earlier one", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "scan_barcode",
      {},
      messagesWithImage,
    );
    expect(args.input).toBe(CDN_URL);
  });

  it("maps the arg name per tool (detect_objects/remove_background use 'image')", () => {
    for (const tool of ["detect_objects", "remove_background"]) {
      const args = ToolOrchestratorService.resolveImageInputArg(
        tool,
        { image: "attached" },
        messagesWithImage,
      );
      expect(args.image).toBe(CDN_URL);
    }
  });

  it("leaves non-image tools untouched", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
      "search_web",
      { query: "attached" },
      messagesWithImage,
    );
    expect(args.query).toBe("attached");
  });

  it("keeps a model-typed data URI when no conversation image exists", () => {
    const dataUri = "data:image/png;base64,BBBB";
    const args = ToolOrchestratorService.resolveImageInputArg(
      "manipulate_image",
      { input: dataUri, operations: [] },
      [{ role: "user" }],
    );
    expect(args.input).toBe(dataUri);
  });

  it("leaves args unchanged when unresolvable and no image exists", () => {
    const args = ToolOrchestratorService.resolveImageInputArg(
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
    expect(ToolOrchestratorService.findLastUserImage(messages)).toBe(CDN_URL);
  });
});
