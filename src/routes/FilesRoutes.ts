import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import FileService from "../services/FileService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = express.Router();

/**
 * POST /files/upload
 * Upload a base64 data URL to file storage (MinIO or inline fallback).
 * Body: { data: "data:image/png;base64,..." }
 * Response: { ref, size, contentType }
 */
router.post(
  "/upload",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ error: "Missing required field: data" });
      }

      const result = await FileService.uploadFile(data);
      res.json(result);
    } catch (error: unknown) {
      logger.error(`File upload error: ${getErrorMessage(error)}`);
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
