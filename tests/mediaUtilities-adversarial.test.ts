import { describe, it, expect, vi, beforeAll } from "vitest";
import sharp from "sharp";
import { execFile } from "child_process";
import {
  constrainImageDimensions,
  compressImageForSizeLimit,
  extractVideoFrames,
  getDataUrlMimeType,
  getUrlType,
  inferMimeFromUrl,
} from "../src/utils/media.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock child_process to allow dynamic execFile behavior
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    execFile: vi.fn().mockImplementation((file: string, args: any, options: any, callback: any) => {
      // Forward to original implementation by default
      return original.execFile(file, args, options, callback);
    }),
  };
});

describe("Media Utilities — Adversarial Test Suite", () => {
  let smallPngBase64: string;
  let largePngBase64: string;

  beforeAll(async () => {
    const smallPngBuffer = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    smallPngBase64 = smallPngBuffer.toString("base64");

    const largePngBuffer = await sharp({
      create: {
        width: 2500,
        height: 2500,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    largePngBase64 = largePngBuffer.toString("base64");
  });

  // 1. Boundary & Edge Cases
  describe("Boundary & Edge Cases", () => {
    it("should handle extractVideoFrames with invalid negative or zero parameters gracefully", async () => {
      const videoDataUrl = "data:video/mp4;base64,AAAAF2Z0eXBtcDRyAAAAAG1wNHJpc29tAAAAAG1vb3YAAABsbXZoZAAAAAD...";
      
      // Negative frames should either fail immediately or be rejected gracefully
      await expect(
        extractVideoFrames(videoDataUrl, { fps: -1, maxFrames: -5, quality: -2 })
      ).rejects.toThrow();
    });

    it("should handle constrainImageDimensions with negative max dimension or NaN dimensions without throwing", async () => {
      // Negative dimensions should be caught by try/catch and return original content
      const negativeResult = await constrainImageDimensions(smallPngBase64, "image/png", -100);
      expect(negativeResult.data).toBe(smallPngBase64);

      // NaN dimensions should be caught by try/catch and return original content
      const nanResult = await constrainImageDimensions(smallPngBase64, "image/png", NaN);
      expect(nanResult.data).toBe(smallPngBase64);

      // Infinity dimensions
      const infinityResult = await constrainImageDimensions(smallPngBase64, "image/png", Infinity);
      expect(infinityResult.data).toBe(smallPngBase64);
    });

    it("should handle inferMimeFromUrl with null bytes and massive path traversal strings safely", () => {
      const nullByteUrl = "https://example.com/image.png\0/../../etc/passwd";
      const resultWithNullByte = inferMimeFromUrl(nullByteUrl);
      expect(resultWithNullByte).toBe("any");

      const massiveUrl = "https://example.com/" + "a".repeat(50000) + ".png";
      const resultWithMassiveUrl = inferMimeFromUrl(massiveUrl);
      expect(resultWithMassiveUrl).toBe("image");
    });
  });

  // 2. Type Coercion & Schema Violations
  describe("Type Coercion & Schema Violations", () => {
    it("should reject extractVideoFrames when options parameter contains string coerced properties", async () => {
      const videoDataUrl = "data:video/mp4;base64,AAAAF2Z0eXBtcDRyAAAAAG1wNHJpc29tAAAAAG1vb3YAAABsbXZoZAAAAAD...";
      await expect(
        extractVideoFrames(videoDataUrl, {
          fps: "invalid" as unknown as number,
          maxFrames: "invalid" as unknown as number,
        })
      ).rejects.toThrow();
    });

    it("should handle compressImageForSizeLimit with invalid array or object media types gracefully", async () => {
      const result = await compressImageForSizeLimit(
        smallPngBase64,
        ["image/png", "image/jpeg"] as unknown as string,
        1000
      );
      expect(result.data).toBe(smallPngBase64);
    });
  });

  // 3. Concurrency & Race Conditions
  describe("Concurrency & Race Conditions", () => {
    it("should handle rapid parallel calls to check image limits without lockups", async () => {
      const promiseList = Array.from({ length: 20 }).map(() =>
        constrainImageDimensions(smallPngBase64, "image/png", 5)
      );
      const results = await Promise.all(promiseList);
      expect(results).toHaveLength(20);
      expect(results[0].data).toBeDefined();
    });
  });

  // 4. State Machine Violations
  describe("State Machine Violations", () => {
    it("should return the input string when compressImageForSizeLimit is called with corrupted base64", async () => {
      const corruptBase64 = "This is not valid base64 data!!!";
      // This is expected to fail/throw if there's no error handling around sharp in compressWithSharp.
      const result = await compressImageForSizeLimit(corruptBase64, "image/png", 5);
      expect(result.data).toBe(corruptBase64);
    });
  });

  // 5. Error Recovery & Graceful Degradation
  describe("Error Recovery & Graceful Degradation", () => {
    it("should fall back to sharp compression when ffmpeg is completely unavailable", async () => {
      // Mock execFile to simulate ffmpeg not found error
      vi.mocked(execFile).mockImplementationOnce((file: string, args: any, options: any, callback: any) => {
        const error = new Error("ffmpeg: command not found");
        (error as any).code = 127;
        callback(error);
        return {} as any;
      });

      const gifBase64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const result = await compressImageForSizeLimit(gifBase64, "image/gif", 2);
      
      // Should fall back to JPEG via sharp
      expect(result.mediaType).toBe("image/jpeg");
    });
  });
});
