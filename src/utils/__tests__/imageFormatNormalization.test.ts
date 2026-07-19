/**
 * Unit tests for provider-hostile image format normalization
 * (HEIC/HEIF → JPEG, SVG → PNG raster).
 *
 * Uses the real sharp pipeline for SVG rasterization. HEIC decoding is
 * exercised through the failure path only (crafting a real HEVC payload
 * needs an encoder); success-path conversion is covered by heic-convert's
 * own test suite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import sharp from "sharp";

import {
  clearNormalizedImageCache,
  normalizeImageFormatForProvider,
  sniffSpecialImageFormat,
} from "#src/utils/media";

/** Minimal ISO-BMFF header with an ftyp heic brand (not a decodable image). */
function fakeHeicBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypheic"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1heic"),
  ]);
}

const SIMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0af"/><text x="10" y="55" font-size="24">Hello</text></svg>`;

describe("sniffSpecialImageFormat", () => {
  it("detects HEIC/HEIF from MIME type", () => {
    expect(sniffSpecialImageFormat(Buffer.alloc(0), "image/heic")).toBe("heic");
    expect(sniffSpecialImageFormat(Buffer.alloc(0), "image/heif")).toBe("heic");
  });

  it("detects HEIC from ftyp brand bytes under a generic MIME type", () => {
    expect(
      sniffSpecialImageFormat(fakeHeicBytes(), "application/octet-stream"),
    ).toBe("heic");
  });

  it("detects SVG from MIME type and from leading markup", () => {
    expect(sniffSpecialImageFormat(Buffer.alloc(0), "image/svg+xml")).toBe(
      "svg",
    );
    expect(
      sniffSpecialImageFormat(
        Buffer.from(SIMPLE_SVG),
        "application/octet-stream",
      ),
    ).toBe("svg");
    expect(
      sniffSpecialImageFormat(
        Buffer.from(`<?xml version="1.0"?><svg xmlns="x"/>`),
        "application/octet-stream",
      ),
    ).toBe("svg");
  });

  it("returns null for ordinary raster formats (incl. AVIF — sharp decodes it)", () => {
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffSpecialImageFormat(pngHead, "image/png")).toBeNull();
    const avifHead = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypavif"),
    ]);
    expect(
      sniffSpecialImageFormat(avifHead, "application/octet-stream"),
    ).toBeNull();
  });
});

describe("normalizeImageFormatForProvider", () => {
  beforeEach(() => {
    clearNormalizedImageCache();
  });

  it("passes ordinary images through untouched", async () => {
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const base64 = png.toString("base64");
    const result = await normalizeImageFormatForProvider(base64, "image/png");
    expect(result.converted).toBe(false);
    expect(result.data).toBe(base64);
    expect(result.mediaType).toBe("image/png");
  });

  it("rasterizes SVG to a PNG sized for legibility (capped by maxDimension)", async () => {
    const base64 = Buffer.from(SIMPLE_SVG).toString("base64");
    const result = await normalizeImageFormatForProvider(
      base64,
      "image/svg+xml",
      2000,
    );
    expect(result.converted).toBe(true);
    expect(result.mediaType).toBe("image/png");
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(metadata.format).toBe("png");
    // 200×100 intrinsic → long edge scaled up toward the 1600px target
    expect(Math.max(metadata.width || 0, metadata.height || 0)).toBeGreaterThan(
      1000,
    );
    expect(
      Math.max(metadata.width || 0, metadata.height || 0),
    ).toBeLessThanOrEqual(1600);
  });

  it("respects a smaller model-aware dimension cap", async () => {
    const base64 = Buffer.from(SIMPLE_SVG).toString("base64");
    const result = await normalizeImageFormatForProvider(
      base64,
      "image/svg+xml",
      512,
    );
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(
      Math.max(metadata.width || 0, metadata.height || 0),
    ).toBeLessThanOrEqual(512);
  });

  it("is deterministic — identical input yields byte-identical output across cache clears", async () => {
    const base64 = Buffer.from(SIMPLE_SVG).toString("base64");
    const first = await normalizeImageFormatForProvider(
      base64,
      "image/svg+xml",
    );
    clearNormalizedImageCache();
    const second = await normalizeImageFormatForProvider(
      base64,
      "image/svg+xml",
    );
    expect(second.data).toBe(first.data);
    expect(second.mediaType).toBe(first.mediaType);
  });

  it("falls back to inlined SVG source as text/plain when rasterization fails", async () => {
    const bogus = "not really <svg but sniffed as such";
    // Force the svg path via MIME type; sharp cannot rasterize this
    const base64 = Buffer.from(bogus).toString("base64");
    const result = await normalizeImageFormatForProvider(
      base64,
      "image/svg+xml",
    );
    expect(result.converted).toBe(true);
    expect(result.mediaType).toBe("text/plain");
    const text = Buffer.from(result.data, "base64").toString("utf-8");
    expect(text).toContain("rasterization failed");
    expect(text).toContain(bogus);
  });

  it("falls back to a visible placeholder when HEIC decoding fails", async () => {
    const base64 = fakeHeicBytes().toString("base64");
    const result = await normalizeImageFormatForProvider(base64, "image/heic");
    expect(result.converted).toBe(true);
    expect(result.mediaType).toBe("text/plain");
    const text = Buffer.from(result.data, "base64").toString("utf-8");
    expect(text).toContain("HEIC");
  });
});
