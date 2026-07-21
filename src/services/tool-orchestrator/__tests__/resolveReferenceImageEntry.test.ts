/**
 * Unit tests for ToolOrchestratorService.resolveReferenceImageEntry —
 * normalizing generate_image reference entries for the tools-api.
 *
 * Regression: conversation storage holds `minio://` refs (uploads are
 * compacted in place by MediaResolutionService), and the generate_image
 * auto-inject used to accept only http(s)/data: — silently dropping every
 * conversation-attached reference, so "redraw this" produced an image with
 * no resemblance to the attachment.
 */
import { describe, it, expect, vi } from "vitest";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

vi.mock("#src/services/FileService", () => ({
  default: {
    extractKey: vi.fn((ref: string) => ref.replace("minio://", "")),
    getPublicUrl: vi.fn((ref: string) =>
      ref.includes("public")
        ? `https://minio.example.com/${ref.replace("minio://", "")}`
        : null,
    ),
    getFile: vi.fn(async (key: string) => {
      if (key.includes("missing")) return null;
      return {
        contentType: "image/png",
        stream: (async function* () {
          yield Buffer.from("fakepixels");
        })(),
      };
    }),
  },
}));

describe("resolveReferenceImageEntry", () => {
  it("passes http(s) URLs through unchanged", async () => {
    const url = "https://cdn.discordapp.com/attachments/1/2/tate.png?ex=abc";
    expect(
      await ToolOrchestratorService.resolveReferenceImageEntry(url),
    ).toBe(url);
  });

  it("passes data: URLs through unchanged", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    expect(
      await ToolOrchestratorService.resolveReferenceImageEntry(dataUrl),
    ).toBe(dataUrl);
  });

  it("resolves minio:// refs to their public bucket URL when available", async () => {
    const resolved = await ToolOrchestratorService.resolveReferenceImageEntry(
      "minio://projects/lupos/blitzosauruskek/uploads/public-abc123",
    );
    expect(resolved).toBe(
      "https://minio.example.com/projects/lupos/blitzosauruskek/uploads/public-abc123",
    );
  });

  it("falls back to inline base64 when no public URL is configured", async () => {
    const resolved = await ToolOrchestratorService.resolveReferenceImageEntry(
      "minio://projects/lupos/blitzosauruskek/uploads/abc123",
    );
    expect(resolved).toBe(
      `data:image/png;base64,${Buffer.from("fakepixels").toString("base64")}`,
    );
  });

  it("resolves minio refs in findLastUserMedia via the public URL", () => {
    const found = ToolOrchestratorService.findLastUserMedia(
      [
        { role: "user", images: ["minio://projects/lupos/u/uploads/public-x"] },
      ] as never,
      ["images"] as never,
    );
    expect(found).toBe(
      "https://minio.example.com/projects/lupos/u/uploads/public-x",
    );
  });

  it("returns null when the minio object is gone", async () => {
    expect(
      await ToolOrchestratorService.resolveReferenceImageEntry(
        "minio://projects/lupos/user/uploads/missing",
      ),
    ).toBeNull();
  });

  it("returns null for unusable refs", async () => {
    expect(
      await ToolOrchestratorService.resolveReferenceImageEntry("ftp://nope"),
    ).toBeNull();
  });
});
