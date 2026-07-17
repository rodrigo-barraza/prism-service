import { describe, it, expect } from "vitest";
import {
  extractCapturableArtifact,
  ARTIFACT_MAX_CONTENT_CHARS,
} from "#src/services/ArtifactsService";
import artifactTools from "#src/services/tool-definitions/ArtifactTools";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ────────────────────────────────────────────────────────────
// ArtifactsService — capture eligibility + artifact tool guards
//
// Mongo is unavailable in unit tests (MongoWrapper.getDb → null),
// so these cover the pure extraction logic behind the orchestrator's
// auto-capture hook and the tools' argument validation paths.
// ────────────────────────────────────────────────────────────

const [createArtifactTool, updateArtifactTool] = artifactTools;

describe("extractCapturableArtifact", () => {
  it("captures media display metadata with title and height", () => {
    const capturable = extractCapturableArtifact("generate_diagram", {
      display: {
        kind: "embed",
        url: "https://tools.example/compute/diagram/embed?id=abc",
        title: "Diagram",
        height: 420,
      },
    });
    expect(capturable).toEqual({
      kind: "embed",
      url: "https://tools.example/compute/diagram/embed?id=abc",
      title: "Diagram",
      height: 420,
    });
  });

  it("falls back to a humanized tool name when display has no title", () => {
    const capturable = extractCapturableArtifact("create_3d_scene", {
      display: { kind: "embed", url: "https://tools.example/embed?id=x" },
    });
    expect(capturable?.title).toBe("Create 3d scene");
  });

  it("captures generate_image results via the post-hoc minioRef", () => {
    const capturable = extractCapturableArtifact("generate_image", {
      image: { data: "AAAA", mimeType: "image/png", minioRef: "minio://generations/a.png" },
    });
    expect(capturable).toEqual({
      kind: "image",
      url: "minio://generations/a.png",
      title: "Generate image",
    });
  });

  it("ignores code displays, errored results, and non-object results", () => {
    expect(
      extractCapturableArtifact("generate_ascii_art", {
        display: { kind: "code", sourceField: "ascii" },
      }),
    ).toBeNull();
    expect(
      extractCapturableArtifact("generate_image", {
        error: "boom",
        display: { kind: "image", url: "https://x.example/a.png" },
      }),
    ).toBeNull();
    expect(extractCapturableArtifact("execute_shell", "plain text")).toBeNull();
    expect(extractCapturableArtifact("execute_shell", null)).toBeNull();
  });

  it("rejects non-durable URLs (base64 data URLs, relative paths)", () => {
    expect(
      extractCapturableArtifact("generate_image", {
        display: { kind: "image", url: "data:image/png;base64,AAAA" },
      }),
    ).toBeNull();
    expect(
      extractCapturableArtifact("generate_image", {
        display: { kind: "image", url: "/files/a.png" },
      }),
    ).toBeNull();
  });
});

describe("artifact tools — argument validation", () => {
  it("registers the three artifact tools with taxonomy names", () => {
    expect(artifactTools.map((tool) => tool.name)).toEqual([
      TOOL_NAMES.CREATE_ARTIFACT,
      TOOL_NAMES.UPDATE_ARTIFACT,
      TOOL_NAMES.LIST_ARTIFACTS,
    ]);
  });

  it("create_artifact rejects missing/invalid arguments before touching the DB", async () => {
    expect(
      await createArtifactTool.execute({ kind: "markdown", content: "x" }, {}),
    ).toHaveProperty("error", "title is required");
    expect(
      await createArtifactTool.execute(
        { title: "T", kind: "docx", content: "x" },
        {},
      ),
    ).toHaveProperty("error", "kind must be one of: markdown, html");
    expect(
      await createArtifactTool.execute({ title: "T", kind: "markdown" }, {}),
    ).toHaveProperty("error", "content is required");
  });

  it("create_artifact enforces the content size ceiling", async () => {
    const oversized = "a".repeat(ARTIFACT_MAX_CONTENT_CHARS + 1);
    const result = (await createArtifactTool.execute(
      { title: "T", kind: "markdown", content: oversized },
      {},
    )) as { error?: string };
    expect(result.error).toContain("character limit");
  });

  it("update_artifact requires artifactId and content", async () => {
    expect(
      await updateArtifactTool.execute({ content: "x" }, {}),
    ).toHaveProperty("error", "artifactId is required");
    expect(
      await updateArtifactTool.execute({ artifactId: "abc" }, {}),
    ).toHaveProperty("error", "content is required");
  });
});
