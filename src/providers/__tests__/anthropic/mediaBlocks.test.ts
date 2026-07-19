/**
 * Unit tests for Anthropic media handling in `prepareMessages`.
 *
 * Silent media loss is forbidden: audio becomes a visible placeholder,
 * video expands into cached frames (placeholder when extraction fails),
 * the dedicated pdf field becomes document blocks, documents become
 * reader-tool pointers, and unresolved refs become placeholders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/utils/media", () => ({
  compressImageForSizeLimit: vi.fn(async (data: string, mediaType: string) => ({
    data,
    mediaType,
  })),
  extractVideoFramesCached: vi.fn(),
  getMaxImageDimensionForModel: vi.fn(() => 2000),
  normalizeImageFormatForProvider: vi.fn(
    async (data: string, mediaType: string) => ({
      data,
      mediaType,
      converted: false,
    }),
  ),
}));

import { prepareMessages } from "#src/providers/anthropic";
import {
  extractVideoFramesCached,
  compressImageForSizeLimit,
  getMaxImageDimensionForModel,
  normalizeImageFormatForProvider,
} from "#src/utils/media";
import {
  clearDocumentContextCache,
  primeDocumentContext,
} from "#src/utils/documentContext";
import type { ChatMessage } from "#src/types/ProviderTypes";

interface Block {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
}

function blocksOf(result: { messages: Array<{ content?: unknown }> }): Block[] {
  return result.messages[0].content as Block[];
}

describe("prepareMessages — media handling", () => {
  beforeEach(() => {
    clearDocumentContextCache();
    vi.mocked(extractVideoFramesCached).mockReset();
    vi.mocked(getMaxImageDimensionForModel).mockReturnValue(2000);
    vi.mocked(normalizeImageFormatForProvider).mockImplementation(
      async (data: string, mediaType: string) => ({
        data,
        mediaType,
        converted: false,
      }),
    );
  });

  it("inserts a text placeholder for audio attachments instead of dropping them", async () => {
    const result = await prepareMessages([
      {
        role: "user",
        content: "what does this say?",
        audio: ["data:audio/mpeg;base64,AAAA"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const placeholder = blocks.find(
      (block) =>
        block.type === "text" && block.text?.includes("cannot hear audio"),
    );
    expect(placeholder?.text).toContain("audio/mpeg");
    expect(placeholder?.text).toContain('"attached"');
  });

  it("expands video attachments into an explanatory text block plus frame image blocks", async () => {
    vi.mocked(extractVideoFramesCached).mockResolvedValue([
      "data:image/jpeg;base64,FRAME1",
      "data:image/jpeg;base64,FRAME2",
    ]);
    const result = await prepareMessages([
      {
        role: "user",
        content: "summarize the clip",
        video: ["data:video/mp4;base64,VIDEODATA"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const note = blocks.find(
      (block) => block.type === "text" && block.text?.includes("sampled frame"),
    );
    expect(note?.text).toContain("2 sampled frames at 1fps");
    const frames = blocks.filter((block) => block.type === "image");
    expect(frames).toHaveLength(2);
    expect(frames[0].source?.data).toBe("FRAME1");
    expect(frames[1].source?.data).toBe("FRAME2");
  });

  it("falls back to a text placeholder when frame extraction fails (no ffmpeg)", async () => {
    vi.mocked(extractVideoFramesCached).mockRejectedValue(
      new Error("ffmpeg is not installed"),
    );
    const result = await prepareMessages([
      {
        role: "user",
        content: "watch this",
        video: ["data:video/webm;base64,VIDEODATA"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const placeholder = blocks.find(
      (block) =>
        block.type === "text" &&
        block.text?.includes("cannot watch video directly"),
    );
    expect(placeholder?.text).toContain("video/webm");
    expect(placeholder?.text).toContain('"attached"');
  });

  it("converts the dedicated pdf field into document blocks", async () => {
    const result = await prepareMessages([
      {
        role: "user",
        content: "read this",
        pdf: ["data:application/pdf;base64,JVBERi0="],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const documentBlock = blocks.find((block) => block.type === "document");
    expect(documentBlock?.source?.media_type).toBe("application/pdf");
    expect(documentBlock?.source?.data).toBe("JVBERi0=");
  });

  it("emits reader-tool pointers for unprimed document attachments", async () => {
    const result = await prepareMessages([
      {
        role: "user",
        content: "analyze the data",
        documents: ["https://minio.example.com/bucket/uploads/data.csv"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const pointer = blocks.find(
      (block) => block.type === "text" && block.text?.includes("read_csv"),
    );
    expect(pointer?.text).toContain(
      "https://minio.example.com/bucket/uploads/data.csv",
    );
  });

  it("emits url-source image blocks for http image refs and placeholders for unresolved refs", async () => {
    const result = await prepareMessages([
      {
        role: "user",
        content: "look",
        images: [
          "https://example.com/photo.png",
          "minio://bucket/lost-key.png",
        ],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const urlImage = blocks.find(
      (block) => block.type === "image" && block.source?.type === "url",
    );
    expect(urlImage?.source?.url).toBe("https://example.com/photo.png");
    const placeholder = blocks.find(
      (block) =>
        block.type === "text" && block.text?.includes("unresolved reference"),
    );
    expect(placeholder?.text).toContain("minio://bucket/lost-key.png");
  });

  it("routes normalized HEIC/SVG payloads into image blocks with the converted media type", async () => {
    vi.mocked(normalizeImageFormatForProvider).mockResolvedValueOnce({
      data: "RASTERPNG",
      mediaType: "image/png",
      converted: true,
    });
    const result = await prepareMessages([
      {
        role: "user",
        content: "diagram",
        images: ["data:image/svg+xml;base64,PHN2Zy8+"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const image = blocks.find((block) => block.type === "image");
    expect(image?.source?.media_type).toBe("image/png");
    expect(image?.source?.data).toBe("RASTERPNG");
  });

  it("emits a visible text block when normalization falls back to text/plain", async () => {
    const fallback = "[Attached SVG image — rasterization failed; SVG source follows]\n<svg/>";
    vi.mocked(normalizeImageFormatForProvider).mockResolvedValueOnce({
      data: Buffer.from(fallback, "utf-8").toString("base64"),
      mediaType: "text/plain",
      converted: true,
    });
    const result = await prepareMessages([
      {
        role: "user",
        content: "diagram",
        images: ["data:image/svg+xml;base64,broken"],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    expect(blocks.some((block) => block.type === "image")).toBe(false);
    const text = blocks.find(
      (block) => block.type === "text" && block.text?.includes("rasterization failed"),
    );
    expect(text?.text).toContain("<svg/>");
  });

  it("inlines primed small text documents instead of the reader-tool pointer", async () => {
    const reference = `data:text/csv;base64,${Buffer.from("a,b\n1,2").toString("base64")}`;
    await primeDocumentContext(reference);
    const result = await prepareMessages([
      {
        role: "user",
        content: "analyze",
        documents: [reference],
      } as ChatMessage,
    ]);
    const blocks = blocksOf(result);
    const inline = blocks.find(
      (block) => block.type === "text" && block.text?.includes("Attached file"),
    );
    expect(inline?.text).toContain("text/csv");
    expect(inline?.text).toContain("a,b\n1,2");
    expect(blocks.some((block) => block.text?.includes("read_csv"))).toBe(false);
  });

  it("passes the model-appropriate dimension cap to image compression", async () => {
    vi.mocked(getMaxImageDimensionForModel).mockReturnValue(2576);
    await prepareMessages(
      [
        {
          role: "user",
          content: "hi-res",
          images: ["data:image/png;base64,iVBORDATA"],
        } as ChatMessage,
      ],
      "claude-fable-5",
    );
    expect(getMaxImageDimensionForModel).toHaveBeenCalledWith("claude-fable-5");
    expect(compressImageForSizeLimit).toHaveBeenCalledWith(
      "iVBORDATA",
      "image/png",
      undefined,
      2576,
    );
  });
});
