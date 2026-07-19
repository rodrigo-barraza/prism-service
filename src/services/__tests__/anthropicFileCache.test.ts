import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Enable the Files API for this suite (the global test setup disables it)
vi.mock("#config", () => ({
  ANTHROPIC_API_KEY: "fake",
  ANTHROPIC_BASE_URL: undefined,
  ANTHROPIC_FILES_API_ENABLED: true,
  MONGO_URI: "mongodb://localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(() => {
      throw new Error("no database in unit tests");
    }),
  },
}));

import AnthropicFileCacheService from "#src/services/AnthropicFileCacheService";

/** Base64 payload comfortably above the 100 KB inline threshold. */
const LARGE_DATA = "A".repeat(150 * 1024);

function imageBlock(data: string = LARGE_DATA) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

describe("AnthropicFileCacheService", () => {
  beforeEach(() => {
    AnthropicFileCacheService.clearMemoryCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("substitutes large image blocks with cached file_id sources", async () => {
    vi.spyOn(AnthropicFileCacheService, "getCachedFileId").mockResolvedValue(
      "file_abc123",
    );
    const block = imageBlock();
    const messages = [{ role: "user", content: [block] }];

    const application =
      await AnthropicFileCacheService.applyFileSources(messages);

    expect(application.applied).toBe(true);
    expect(application.fileIds).toEqual(["file_abc123"]);
    expect(block.source).toEqual({ type: "file", file_id: "file_abc123" });
  });

  it("uploads on cache miss and stores the mapping", async () => {
    vi.spyOn(AnthropicFileCacheService, "getCachedFileId").mockResolvedValue(
      null,
    );
    const uploadSpy = vi
      .spyOn(AnthropicFileCacheService, "uploadAndCache")
      .mockResolvedValue("file_new456");
    const block = imageBlock();

    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: [block] },
    ]);

    expect(uploadSpy).toHaveBeenCalledOnce();
    expect(application.fileIds).toEqual(["file_new456"]);
    expect(block.source).toEqual({ type: "file", file_id: "file_new456" });
  });

  it("keeps small images inline (upload overhead not worth it)", async () => {
    const lookupSpy = vi.spyOn(AnthropicFileCacheService, "getCachedFileId");
    const block = imageBlock("A".repeat(10 * 1024));

    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: [block] },
    ]);

    expect(lookupSpy).not.toHaveBeenCalled();
    expect(application.applied).toBe(false);
    expect(block.source.type).toBe("base64");
  });

  it("substitutes PDF document blocks regardless of size", async () => {
    vi.spyOn(AnthropicFileCacheService, "getCachedFileId").mockResolvedValue(
      "file_pdf789",
    );
    const block = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
    };

    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: [block] },
    ]);

    expect(application.applied).toBe(true);
    expect(block.source).toEqual({ type: "file", file_id: "file_pdf789" });
  });

  it("falls back to inline base64 when the Files API fails, without failing the turn", async () => {
    vi.spyOn(AnthropicFileCacheService, "getCachedFileId").mockResolvedValue(
      null,
    );
    vi.spyOn(AnthropicFileCacheService, "uploadAndCache").mockRejectedValue(
      new Error("upload exploded"),
    );
    const block = imageBlock();

    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: [block] },
    ]);

    expect(application.applied).toBe(false);
    expect(block.source.type).toBe("base64");
  });

  it("reverts substitutions and invalidates cache entries", async () => {
    vi.spyOn(AnthropicFileCacheService, "getCachedFileId").mockResolvedValue(
      "file_stale",
    );
    const invalidateSpy = vi
      .spyOn(AnthropicFileCacheService, "invalidate")
      .mockResolvedValue();
    const block = imageBlock();
    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: [block] },
    ]);
    expect(block.source.type).toBe("file");

    await AnthropicFileCacheService.revertFileSources(application);

    expect(block.source.type).toBe("base64");
    expect(block.source.data).toBe(LARGE_DATA);
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(application.applied).toBe(false);
  });

  it("classifies file-source errors by referenced file_id or file-api status", () => {
    const application = {
      applied: true,
      substitutions: [],
      fileIds: ["file_abc123"],
    };
    expect(
      AnthropicFileCacheService.isFileSourceError(
        new Error("file_abc123 not found"),
        application,
      ),
    ).toBe(true);
    expect(
      AnthropicFileCacheService.isFileSourceError(
        Object.assign(new Error("invalid file_id in source"), { status: 400 }),
        application,
      ),
    ).toBe(true);
    expect(
      AnthropicFileCacheService.isFileSourceError(
        Object.assign(new Error("overloaded"), { status: 529 }),
        application,
      ),
    ).toBe(false);
    expect(
      AnthropicFileCacheService.isFileSourceError(new Error("file_abc123"), {
        applied: false,
        substitutions: [],
        fileIds: [],
      }),
    ).toBe(false);
  });

  it("does nothing when string content or no media blocks are present", async () => {
    const application = await AnthropicFileCacheService.applyFileSources([
      { role: "user", content: "plain text" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(application.applied).toBe(false);
  });
});
