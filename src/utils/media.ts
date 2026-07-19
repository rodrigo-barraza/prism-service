// ─────────────────────────────────────────────────────────────
// Shared Media & URL Utilities
// ─────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import crypto from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import logger from "./logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { UNITS, ENCODINGS } from "#src/constants";
import { HIGH_RES_IMAGE_MAX_DIMENSION } from "#config";

// ── ffmpeg availability (cached per process) ────────────────
let _ffmpegAvailable: boolean | null = null;
async function isFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  return new Promise<boolean>((resolve) => {
    execFile(
      "ffmpeg",
      ["-version"],
      { timeout: 5_000 },
      (error: Error | null) => {
        _ffmpegAvailable = !error;
        if (!_ffmpegAvailable) {
          logger.warn(
            "[media] ffmpeg not found on PATH — GIF animation and video frame extraction will be degraded",
          );
        }
        resolve(_ffmpegAvailable);
      },
    );
  });
}

// ── Provider Image Limits ───────────────────────────────────

/** Anthropic's per-image inline base64 limit. */
const ANTHROPIC_IMAGE_MAX_BYTES = 5 * UNITS.BYTES_PER_MB; // 5 MB

/**
 * Maximum pixel dimension (width or height) for images sent to providers.
 * Anthropic hard-rejects >8000px, but most vision models gain little
 * beyond ~1500px. Capping at 2000px saves bandwidth, memory, and tokens
 * while preserving enough detail for accurate captioning/analysis.
 */
export const MAX_IMAGE_DIMENSION = 2000;

/**
 * Anthropic high-resolution vision models accept a longer 2576px edge.
 * Matches Opus 4.7/4.8 (and later), Sonnet 5+, Fable 5+, Mythos 5+ —
 * including provider-prefixed IDs (e.g. "anthropic.claude-opus-4-8").
 * Conservative by design: unmatched models keep the 2000px default
 * (higher resolution costs up to ~3× image tokens).
 */
const HIGH_RES_VISION_MODEL_PATTERN =
  /claude-(?:opus-4-(?:[7-9]|\d{2,})|opus-(?:[5-9]|\d{2,})(?!\d)|sonnet-(?:[5-9]|\d{2,})(?!\d)|fable-(?:[5-9]|\d{2,})(?!\d)|mythos-(?:[5-9]|\d{2,})(?!\d))/;

/** Whether a model ID belongs to an Anthropic high-resolution vision model. */
export function isHighResolutionVisionModel(model?: string | null): boolean {
  return !!model && HIGH_RES_VISION_MODEL_PATTERN.test(model);
}

/**
 * Long-edge pixel cap appropriate for a given model.
 * High-res Anthropic models get HIGH_RES_IMAGE_MAX_DIMENSION (config
 * override: HIGH_RES_IMAGE_MAX_DIMENSION env); everything else keeps
 * the conservative MAX_IMAGE_DIMENSION default.
 */
export function getMaxImageDimensionForModel(model?: string | null): number {
  return isHighResolutionVisionModel(model)
    ? HIGH_RES_IMAGE_MAX_DIMENSION
    : MAX_IMAGE_DIMENSION;
}

/**
 * Compress a base64-encoded image to fit within a byte-size limit.
 *
 * Strategy:
 *  - GIFs → ffmpeg resize (preserves animation for models that support it)
 *  - Everything else → sharp JPEG conversion + progressive downscale
 */
export async function compressImageForSizeLimit(
  base64Data: string,
  mediaType: string,
  maxBytes: number = ANTHROPIC_IMAGE_MAX_BYTES,
  maxDimension: number = MAX_IMAGE_DIMENSION,
) {
  try {
    // Step 0: enforce pixel dimension limits first (avoids sending oversized pixels)
    const dimensionResult = await constrainImageDimensions(
      base64Data,
      mediaType,
      maxDimension,
    );
    base64Data = dimensionResult.data;
    mediaType = dimensionResult.mediaType;

    // Anthropic measures the base64 STRING length, not decoded binary size
    const rawBytes = base64Data.length;
    if (rawBytes <= maxBytes) {
      return { data: base64Data, mediaType };
    }

    const sizeMB = (rawBytes / UNITS.BYTES_PER_MB).toFixed(2);
    const limitMB = (maxBytes / UNITS.BYTES_PER_MB).toFixed(0);
    logger.info(
      `[media] Image exceeds ${limitMB} MB limit (${sizeMB} MB, ${mediaType}). Compressing...`,
    );

    // GIFs → ffmpeg (preserves animation)
    if (mediaType === "image/gif") {
      return await compressGifWithFfmpeg(base64Data, maxBytes);
    }

    // Everything else → sharp (converts to JPEG)
    return await compressWithSharp(base64Data, maxBytes);
  } catch (error: unknown) {
    logger.warn(
      `[media] Image compression failed (${getErrorMessage(error)}), returning original data`,
    );
    return { data: base64Data, mediaType };
  }
}

/**
 * Constrain image pixel dimensions to MAX_IMAGE_DIMENSION.
 * If either width or height exceeds the limit, the image is downscaled
 * proportionally using sharp's Lanczos3 resampler.
 *
 * GIFs are skipped (ffmpeg handles them separately in byte-size compression).
 */
export async function constrainImageDimensions(
  base64Data: string,
  mediaType: string,
  maxDim: number = MAX_IMAGE_DIMENSION,
) {
  // GIFs are animated — skip (ffmpeg handles them in compressGifWithFfmpeg)
  if (mediaType === "image/gif") {
    return { data: base64Data, mediaType };
  }

  try {
    const buffer = Buffer.from(base64Data, ENCODINGS.BASE64);
    const metadata = await sharp(buffer).metadata();
    const { width, height } = metadata;

    if (!width || !height || (width <= maxDim && height <= maxDim)) {
      return { data: base64Data, mediaType };
    }

    // Calculate scale factor to fit within maxDim on the longest axis
    const scale = maxDim / Math.max(width, height);
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);

    logger.info(
      `[media] Image dimensions ${width}×${height} exceed ${maxDim}px limit. ` +
        `Resizing to ${newWidth}×${newHeight}...`,
    );

    // Preserve original format when possible, fall back to JPEG
    let pipeline = sharp(buffer).resize(newWidth, newHeight, {
      fit: "inside",
      withoutEnlargement: true,
    });

    let outputMime = mediaType;
    if (mediaType === "image/png") {
      pipeline = pipeline.png();
    } else if (mediaType === "image/webp") {
      pipeline = pipeline.webp();
    } else {
      // JPEG for everything else (bmp, tiff, avif, any)
      pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
      outputMime = "image/jpeg";
    }

    const resized = await pipeline.toBuffer();
    const resizedB64 = resized.toString(ENCODINGS.BASE64);

    logger.info(
      `[media] Dimension-constrained: ${width}×${height} → ${newWidth}×${newHeight} ` +
        `(${(resizedB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64)`,
    );

    return { data: resizedB64, mediaType: outputMime };
  } catch (error: unknown) {
    logger.warn(
      `[media] Dimension check failed (${getErrorMessage(error)}), passing through`,
    );
    return { data: base64Data, mediaType };
  }
}

/**
 * Compress an animated GIF using ffmpeg's scale filter.
 * Preserves animation — progressively halves dimensions until under limit.
 */
async function compressGifWithFfmpeg(base64Data: string, maxBytes: number) {
  // ── Graceful degradation: if ffmpeg is not installed, convert the
  //    first frame to a static JPEG via sharp instead of crashing.
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    logger.warn(
      "[media] ffmpeg unavailable — converting GIF to static JPEG via sharp",
    );
    return compressWithSharp(base64Data, maxBytes);
  }

  let temporaryDirectory = null;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "prism-gif-"));
    const inputPath = join(temporaryDirectory, "input.gif");
    const buffer = Buffer.from(base64Data, ENCODINGS.BASE64);
    await writeFile(inputPath, buffer);

    // Progressive resize: 75% → 56% → 42% → 32% → 24% → 18% of original
    const scaleFactors = [0.75, 0.75, 0.75, 0.75, 0.75, 0.75];
    let cumulativeScale = 1;

    for (const factor of scaleFactors) {
      cumulativeScale *= factor;
      const outputPath = join(
        temporaryDirectory,
        `output_${Math.round(cumulativeScale * 100)}.gif`,
      );

      await new Promise<void>((resolve, reject) => {
        execFile(
          "ffmpeg",
          [
            "-y",
            "-i",
            inputPath,
            "-vf",
            `scale='iw*${cumulativeScale}:ih*${cumulativeScale}':flags=lanczos`,
            "-gifflags",
            "+transdiff",
            outputPath,
          ],
          { timeout: 30_000 },
          (
            error: Error | null,
            _stdout: string | Buffer,
            stderr: string | Buffer,
          ) => {
            if (error)
              reject(
                new Error(
                  `ffmpeg GIF resize failed: ${stderr?.toString().slice(-200) || error.message}`,
                ),
              );
            else resolve();
          },
        );
      });

      const result = await readFile(outputPath);
      const resultB64 = result.toString(ENCODINGS.BASE64);
      if (resultB64.length <= maxBytes) {
        logger.info(
          `[media] GIF compressed to ${(resultB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64 ` +
            `(scale=${Math.round(cumulativeScale * 100)}%)`,
        );
        return {
          data: resultB64,
          mediaType: "image/gif",
        };
      }
    }

    // Final fallback: tiny GIF
    const fallbackPath = join(temporaryDirectory, "output_fallback.gif");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputPath,
          "-vf",
          "scale='min(512,iw):min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
          "-gifflags",
          "+transdiff",
          fallbackPath,
        ],
        { timeout: 30_000 },
        (
          error: Error | null,
          _stdout: string | Buffer,
          stderr: string | Buffer,
        ) => {
          if (error)
            reject(
              new Error(
                `ffmpeg GIF fallback resize failed: ${stderr?.toString().slice(-200) || error.message}`,
              ),
            );
          else resolve();
        },
      );
    });

    const fallback = await readFile(fallbackPath);
    const fallbackB64 = fallback.toString(ENCODINGS.BASE64);
    logger.warn(
      `[media] GIF aggressive fallback: ${(fallbackB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64 (512px max)`,
    );
    return {
      data: fallbackB64,
      mediaType: "image/gif",
    };
  } catch (error: unknown) {
    logger.warn(
      `[media] ffmpeg GIF compression failed (${getErrorMessage(error)}), falling back to static JPEG via sharp`,
    );
    return compressWithSharp(base64Data, maxBytes);
  } finally {
    if (temporaryDirectory) {
      rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Compress a non-GIF image using sharp.
 * Converts to JPEG with progressive quality + dimension reduction.
 */
async function compressWithSharp(base64Data: string, maxBytes: number) {
  let buffer = Buffer.from(base64Data, ENCODINGS.BASE64);
  const qualitySteps = [85, 70, 50];

  // Step 1: try quality reduction (convert to JPEG)
  for (const quality of qualitySteps) {
    const compressed = await sharp(buffer)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    const compressedB64 = compressed.toString(ENCODINGS.BASE64);
    if (compressedB64.length <= maxBytes) {
      logger.info(
        `[media] Compressed to ${(compressedB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64 ` +
          `(JPEG q=${quality})`,
      );
      return {
        data: compressedB64,
        mediaType: "image/jpeg",
      };
    }
    buffer = Buffer.from(compressed);
  }

  // Step 2: progressive resize (shrink by 25% each iteration)
  const metadata = await sharp(buffer).metadata();
  let width = metadata.width || 0;
  let height = metadata.height || 0;

  for (let i = 0; i < 6; i++) {
    width = Math.round(width * 0.75);
    height = Math.round(height * 0.75);

    const resized = await sharp(Buffer.from(base64Data, ENCODINGS.BASE64))
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    const resizedB64 = resized.toString(ENCODINGS.BASE64);
    if (resizedB64.length <= maxBytes) {
      logger.info(
        `[media] Compressed to ${(resizedB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64 ` +
          `(${width}x${height}, JPEG q=70)`,
      );
      return {
        data: resizedB64,
        mediaType: "image/jpeg",
      };
    }
  }

  // Final fallback: aggressive resize
  const fallback = await sharp(Buffer.from(base64Data, ENCODINGS.BASE64))
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 50, mozjpeg: true })
    .toBuffer();

  const fallbackB64 = fallback.toString(ENCODINGS.BASE64);
  logger.warn(
    `[media] Aggressive fallback: ${(fallbackB64.length / UNITS.BYTES_PER_MB).toFixed(2)} MB b64 (1024px, q=50)`,
  );

  return {
    data: fallbackB64,
    mediaType: "image/jpeg",
  };
}
export function getDataUrlMimeType(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}
export function getUrlType(url: string) {
  if (url.startsWith("data:")) return "data";
  if (url.startsWith("http://") || url.startsWith("https://")) return "http";
  return "any";
}
export function inferMimeFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|avif)$/i.test(pathname))
      return "image";
    if (/\.pdf$/i.test(pathname)) return "pdf";
    if (/\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(pathname))
      return "text";
  } catch {
    /* ignore */
  }
  return "any";
}

// ── Video Frame Extraction ──────────────────────────────────

/**
 * Extract frames from a video data URL using ffmpeg.
 * Returns an array of JPEG image data URLs (one per frame at 1fps).
 *
 * Each image frame costs ~256 tokens in vision models. Default maxFrames=8
 * keeps total image tokens ~2K, leaving room for text generation in
 * local models with limited context windows (4K-8K typical).
 */
export async function extractVideoFrames(
  videoDataUrl: string,
  options: { fps?: number; maxFrames?: number; quality?: number } = {},
) {
  const { fps = 1, maxFrames = 8, quality = 5 } = options;

  // ── Graceful degradation: fail fast if ffmpeg is not installed
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error(
      "ffmpeg is not installed — video frame extraction requires ffmpeg. " +
        "Install it with: apt install ffmpeg",
    );
  }

  let temporaryDirectory = null;

  try {
    // Decode video data URL to a temp file.
    // Use string ops instead of regex — regex (.+) on multi-MB base64 causes OOM.
    const b64Marker = ";base64,";
    const markerIndex = videoDataUrl.indexOf(b64Marker);
    if (markerIndex === -1 || !videoDataUrl.startsWith("data:")) {
      throw new Error("Invalid video data URL format");
    }

    const mime = videoDataUrl.slice(5, markerIndex); // "data:" is 5 chars
    const base64Data = videoDataUrl.slice(markerIndex + b64Marker.length);
    const ext = mime.split("/")[1]?.split(";")[0] || "mp4";

    temporaryDirectory = await mkdtemp(join(tmpdir(), "prism-frames-"));
    const inputPath = join(temporaryDirectory, `input.${ext}`);
    const outputPattern = join(temporaryDirectory, "frame_%04d.jpg");

    // Write video to temp file
    const videoBuffer = Buffer.from(base64Data, ENCODINGS.BASE64);
    const fileSizeMB = (videoBuffer.length / UNITS.BYTES_PER_MB).toFixed(1);
    logger.info(
      `[media] Writing ${fileSizeMB} MB video (${mime}) to ${inputPath}`,
    );
    await writeFile(inputPath, videoBuffer);

    // Extract frames with ffmpeg
    const ffmpegStderr = await new Promise<string>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-i",
          inputPath,
          "-vf",
          `fps=${fps}`,
          "-vframes",
          String(maxFrames),
          "-q:v",
          String(quality),
          "-f",
          "image2",
          outputPattern,
        ],
        { timeout: 30_000 },
        (
          error: Error | null,
          _stdout: string | Buffer,
          stderr: string | Buffer,
        ) => {
          if (error) {
            reject(
              new Error(
                `ffmpeg failed (${fileSizeMB} MB ${ext}): ${stderr?.toString().slice(-200) || error.message}`,
              ),
            );
          } else {
            resolve(stderr?.toString() || "");
          }
        },
      );
    });

    // Read extracted frames and convert to data URLs
    const frames: string[] = [];
    for (let i = 1; i <= maxFrames; i++) {
      const framePath = join(
        temporaryDirectory,
        `frame_${String(i).padStart(4, "0")}.jpg`,
      );
      try {
        const frameBuffer = await readFile(framePath);
        const frameBase64 = frameBuffer.toString(ENCODINGS.BASE64);
        frames.push(`data:image/jpeg;base64,${frameBase64}`);
      } catch {
        break;
      }
    }

    if (frames.length === 0) {
      // ffmpeg ran but produced no frames — extract error details
      const durationMatch = ffmpegStderr?.match(/Duration: ([^,]+)/);
      const duration = durationMatch?.[1] || "any";
      throw new Error(
        `ffmpeg produced 0 frames from ${fileSizeMB} MB ${ext} video (duration: ${duration}). ` +
          `The file may be corrupt, use an unsupported codec, or contain no video stream.`,
      );
    }

    logger.info(
      `[media] Extracted ${frames.length} frames from video (${ext}, ${fileSizeMB} MB, fps=${fps})`,
    );
    return frames;
  } finally {
    if (temporaryDirectory) {
      rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── Cached Video Frame Extraction ───────────────────────────
// Prompt-cache stability: providers that expand video into image
// blocks (Anthropic) must emit byte-identical frames on every turn,
// otherwise the provider's prompt cache misses on each request.
// Frames are cached in-memory keyed by a sha256 of the source bytes
// and extraction options; entries are evicted LRU-style.

const VIDEO_FRAME_CACHE_MAX_ENTRIES = 16;
const videoFrameCache = new Map<string, string[]>();

/**
 * Extract video frames with a stable, cache-backed result.
 *
 * Identical (source, options) inputs return the exact same frame data
 * URLs for the lifetime of the process. Frames are dimension-constrained
 * deterministically before caching so consumers can embed them directly.
 *
 * Throws when ffmpeg is unavailable or extraction fails — callers must
 * fall back to a visible text placeholder, never a silent drop.
 */
export async function extractVideoFramesCached(
  videoDataUrl: string,
  options: { fps?: number; maxFrames?: number; quality?: number } = {},
): Promise<string[]> {
  const { fps = 1, maxFrames = 8, quality = 5 } = options;
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${fps}|${maxFrames}|${quality}|`)
    .update(videoDataUrl)
    .digest("hex");

  const cached = videoFrameCache.get(cacheKey);
  if (cached) {
    // Refresh LRU position
    videoFrameCache.delete(cacheKey);
    videoFrameCache.set(cacheKey, cached);
    return cached;
  }

  const rawFrames = await extractVideoFrames(videoDataUrl, {
    fps,
    maxFrames,
    quality,
  });

  // Deterministic post-processing: constrain frame dimensions so the
  // cached output is final (no per-turn re-compression downstream).
  const frames: string[] = [];
  for (const frameDataUrl of rawFrames) {
    const base64 = frameDataUrl.split(";base64,")[1] || "";
    const constrained = await constrainImageDimensions(base64, "image/jpeg");
    frames.push(`data:${constrained.mediaType};base64,${constrained.data}`);
  }

  videoFrameCache.set(cacheKey, frames);
  while (videoFrameCache.size > VIDEO_FRAME_CACHE_MAX_ENTRIES) {
    const oldestKey = videoFrameCache.keys().next().value as string;
    videoFrameCache.delete(oldestKey);
  }
  return frames;
}

/** Test hook — clear the cached video frames. */
export function clearVideoFrameCache(): void {
  videoFrameCache.clear();
}

// ── Image Input-Format Normalization (HEIC/HEIF, SVG) ───────
// Vision providers reject iPhone photos (image/heic|heif) and vector
// graphics (image/svg+xml). Normalize them at the entry of the image
// pipeline: HEIC → JPEG via the pure-JS `heic-convert` package (sharp's
// prebuilt binaries omit the patent-encumbered HEVC decoder — only AVIF
// is compiled in), SVG → PNG raster via sharp/librsvg.
//
// Output is deterministic (fixed quality, no timestamps) and cached
// in-memory keyed by a sha256 of the source bytes, so identical inputs
// produce byte-identical provider payloads across turns — required for
// provider prompt-cache stability (same concern as video frames).

/** ftyp major brands identifying HEIC/HEIF containers (AVIF excluded — sharp decodes it). */
const HEIC_FTYP_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/** Fixed JPEG quality for HEIC conversion — must stay constant for determinism. */
const HEIC_JPEG_QUALITY = 0.85;

/**
 * Target long edge for rasterized SVGs — large enough that text inside
 * the SVG stays legible, small enough to respect token budgets. The
 * model-aware dimension cap still applies on top of this.
 */
export const SVG_RASTER_TARGET_LONG_EDGE = 1600;

/** SVG sources up to this decoded size are inlined as text when rasterization fails. */
const SVG_SOURCE_INLINE_MAX_BYTES = 64 * 1024;

const NORMALIZED_IMAGE_CACHE_MAX_ENTRIES = 24;
const normalizedImageCache = new Map<
  string,
  { data: string; mediaType: string }
>();

/**
 * Identify provider-hostile image formats from declared MIME type and/or
 * the first bytes of the payload. Byte sniffing covers generic MIME types
 * (application/octet-stream) and mislabeled uploads:
 *  - ISO-BMFF `ftyp` box with a HEIC/HEIF brand → "heic"
 *  - leading `<svg` / XML prologue containing `<svg` → "svg"
 */
export function sniffSpecialImageFormat(
  head: Buffer,
  mediaType: string,
): "heic" | "svg" | null {
  const mime = mediaType.split(";")[0].trim().toLowerCase();
  if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    mime === "image/heic-sequence" ||
    mime === "image/heif-sequence"
  ) {
    return "heic";
  }
  if (mime === "image/svg+xml") return "svg";
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12).toLowerCase();
    if (HEIC_FTYP_BRANDS.has(brand)) return "heic";
  }
  const textHead = head
    .toString("utf-8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (
    textHead.startsWith("<svg") ||
    ((textHead.startsWith("<?xml") || textHead.startsWith("<!doctype")) &&
      textHead.includes("<svg"))
  ) {
    return "svg";
  }
  return null;
}

/** Wrap a visible fallback message (or inlined source) as a text/plain result. */
function textPlainFallback(text: string): { data: string; mediaType: string } {
  return {
    data: Buffer.from(text, "utf-8").toString(ENCODINGS.BASE64),
    mediaType: "text/plain",
  };
}

/** Convert a HEIC/HEIF buffer to JPEG. Falls back to a visible text placeholder. */
async function convertHeicToJpeg(
  buffer: Buffer,
): Promise<{ data: string; mediaType: string }> {
  try {
    const { default: heicConvert } = await import("heic-convert");
    const output = await heicConvert({
      buffer,
      format: "JPEG",
      quality: HEIC_JPEG_QUALITY,
    });
    const jpeg = Buffer.from(output);
    logger.info(
      `[media] Converted HEIC/HEIF → JPEG: ${(buffer.length / UNITS.BYTES_PER_MB).toFixed(2)} MB → ${(jpeg.length / UNITS.BYTES_PER_MB).toFixed(2)} MB`,
    );
    return { data: jpeg.toString(ENCODINGS.BASE64), mediaType: "image/jpeg" };
  } catch (error: unknown) {
    logger.warn(
      `[media] HEIC → JPEG conversion failed (${getErrorMessage(error)}) — inserting text placeholder`,
    );
    return textPlainFallback(
      `[Attached image (image/heic) — this HEIC photo could not be converted for this model. Ask the user to re-send it as JPEG or PNG.]`,
    );
  }
}

/**
 * Rasterize an SVG buffer to PNG at a density that renders text legibly.
 * Never silent on failure: small sources are inlined as text, large ones
 * become a visible placeholder.
 */
async function rasterizeSvgToPng(
  buffer: Buffer,
  maxDimension: number,
): Promise<{ data: string; mediaType: string }> {
  try {
    const target = Math.min(maxDimension, SVG_RASTER_TARGET_LONG_EDGE);
    // Scale the render density so the intrinsic long edge lands near the
    // target — rendering at density beats upscaling a 72dpi raster.
    let density = 300;
    try {
      const metadata = await sharp(buffer).metadata();
      const longEdge = Math.max(metadata.width || 0, metadata.height || 0);
      if (longEdge > 0) {
        density = Math.min(2400, Math.max(1, (72 * target) / longEdge));
      }
    } catch {
      /* keep default density */
    }
    const png = await sharp(buffer, { density })
      .resize(target, target, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    logger.info(
      `[media] Rasterized SVG → PNG (${(png.length / 1024).toFixed(0)} KB, target ${target}px, density ${density.toFixed(0)})`,
    );
    return { data: png.toString(ENCODINGS.BASE64), mediaType: "image/png" };
  } catch (error: unknown) {
    logger.warn(
      `[media] SVG rasterization failed (${getErrorMessage(error)}) — falling back to text`,
    );
    if (buffer.length <= SVG_SOURCE_INLINE_MAX_BYTES) {
      return textPlainFallback(
        `[Attached SVG image — rasterization failed; SVG source follows]\n${buffer.toString("utf-8")}`,
      );
    }
    return textPlainFallback(
      `[Attached SVG image (${(buffer.length / 1024).toFixed(0)} KB) — rasterization failed and the source is too large to inline]`,
    );
  }
}

/**
 * Normalize provider-hostile image payloads before the standard
 * constrain/compress pipeline:
 *  - HEIC/HEIF → JPEG (fixed quality, deterministic)
 *  - SVG → PNG raster (~SVG_RASTER_TARGET_LONG_EDGE long edge, capped by
 *    the model-aware maxDimension)
 *
 * Returns `converted: false` with the input untouched for every other
 * format. Failed conversions come back as `mediaType: "text/plain"`
 * carrying a visible fallback (placeholder or inlined SVG source) —
 * callers must surface that as text, never as an image block.
 */
export async function normalizeImageFormatForProvider(
  base64Data: string,
  mediaType: string,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): Promise<{ data: string; mediaType: string; converted: boolean }> {
  // Only the first bytes are needed for detection — avoid decoding
  // multi-MB payloads for the common (non-HEIC/SVG) case.
  const head = Buffer.from(base64Data.slice(0, 512), ENCODINGS.BASE64);
  const kind = sniffSpecialImageFormat(head, mediaType);
  if (!kind) return { data: base64Data, mediaType, converted: false };

  const cacheKey = crypto
    .createHash("sha256")
    .update(`${kind}|${maxDimension}|`)
    .update(base64Data)
    .digest("hex");
  const cached = normalizedImageCache.get(cacheKey);
  if (cached) {
    // Refresh LRU position
    normalizedImageCache.delete(cacheKey);
    normalizedImageCache.set(cacheKey, cached);
    return { ...cached, converted: true };
  }

  const buffer = Buffer.from(base64Data, ENCODINGS.BASE64);
  const result =
    kind === "heic"
      ? await convertHeicToJpeg(buffer)
      : await rasterizeSvgToPng(buffer, maxDimension);

  normalizedImageCache.set(cacheKey, result);
  while (normalizedImageCache.size > NORMALIZED_IMAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = normalizedImageCache.keys().next().value as string;
    normalizedImageCache.delete(oldestKey);
  }
  return { ...result, converted: true };
}

/** Test hook — clear the cached normalized images. */
export function clearNormalizedImageCache(): void {
  normalizedImageCache.clear();
}
