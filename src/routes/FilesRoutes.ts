import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import FileService from "#src/services/FileService";
import FileGarbageCollectionService from "#src/services/FileGarbageCollectionService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const router = express.Router();

// ─── Upload validation ──────────────────────────────────────

/** Maximum decoded upload size — 40 MB. */
const MAX_UPLOAD_DECODED_BYTES = 40 * 1024 * 1024;

/** MIME prefixes accepted for upload. */
const ALLOWED_MIME_PREFIXES = ["image/", "audio/", "video/"];

/** Exact MIME types accepted for upload (documents + text formats). */
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
]);

/**
 * Validate an upload payload: well-formed base64 data URL, allowlisted
 * MIME type, decoded size within limits. Returns a client-surfaceable
 * error message, or null when the payload is acceptable.
 *
 * Uses string ops instead of a regex over the (multi-MB) base64 body —
 * regex on huge strings risks catastrophic memory use.
 */
export function validateUploadDataUrl(data: unknown): string | null {
  if (typeof data !== "string" || data.length === 0) {
    return "Field 'data' must be a non-empty string";
  }
  if (!data.startsWith("data:")) {
    return "Field 'data' must be a data URL (data:<mime>;base64,<payload>)";
  }
  const base64Marker = ";base64,";
  const markerIndex = data.indexOf(base64Marker);
  if (markerIndex === -1) {
    return "Only base64-encoded data URLs are supported (missing ';base64,' section)";
  }
  const mimeType = data.slice(5, markerIndex).split(";")[0].trim().toLowerCase();
  if (!mimeType || !mimeType.includes("/")) {
    return "Data URL is missing a valid MIME type";
  }
  const isAllowed =
    ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) ||
    ALLOWED_MIME_TYPES.has(mimeType);
  if (!isAllowed) {
    return `File type "${mimeType}" is not allowed. Supported: images, audio, video, PDF, plain text, CSV/TSV, JSON, and Word/Excel documents`;
  }
  const base64Length = data.length - markerIndex - base64Marker.length;
  if (base64Length === 0) {
    return "Data URL contains no content";
  }
  const decodedBytes = Math.floor((base64Length * 3) / 4);
  if (decodedBytes > MAX_UPLOAD_DECODED_BYTES) {
    return `File is too large (${(decodedBytes / 1024 / 1024).toFixed(1)} MB decoded). Maximum upload size is ${MAX_UPLOAD_DECODED_BYTES / 1024 / 1024} MB`;
  }
  return null;
}

/**
 * POST /files/upload
 * Upload a base64 data URL to file storage (MinIO or inline fallback).
 * Body: { data: "data:image/png;base64,..." }
 * Response: { ref, reference, size, contentType }
 * (`reference` mirrors `ref` — it's the key the client reads.)
 */
router.post(
  "/upload",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ error: "Missing required field: data" });
      }
      const validationError = validateUploadDataUrl(data);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const result = await FileService.uploadFile(data);
      res.json({ ...result, reference: result.ref });
    } catch (error: unknown) {
      logger.error(`File upload error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /files/gc
 * Admin: scan for orphaned upload objects (uploads older than 30 days
 * referenced by no conversation/workflow/artifact document) and
 * optionally delete them.
 * Body: { dryRun?: boolean (default TRUE), olderThanDays?: number (min 30) }
 * Response: GarbageCollectionReport
 */
router.post(
  "/gc",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dryRun, olderThanDays } = req.body || {};
      const report = await FileGarbageCollectionService.run({
        // Deletion requires an explicit dryRun: false
        dryRun: dryRun !== false,
        ...(typeof olderThanDays === "number" && { olderThanDays }),
      });
      res.json(report);
    } catch (error: unknown) {
      logger.error(`File GC error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /files/:key(*)
 * Stream a file from MinIO storage.
 * The key is the full object path, e.g. "files/abc-123.png"
 */
router.get(
  "/*key",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Express 5 returns wildcard params as arrays of path segments
      const rawKey = req.params.key;
      const key = Array.isArray(rawKey) ? rawKey.join("/") : rawKey;
      if (!key) {
        return res.status(400).json({ error: "Missing file key" });
      }

      const result = await FileService.getFile(key);
      if (!result) {
        return res.status(404).json({ error: "File not found" });
      }

      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      result.stream.pipe(res);
    } catch (error: unknown) {
      logger.error(`File retrieval error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
