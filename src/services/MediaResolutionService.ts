// ─── Media Resolution Service ───────────────────────────────
// Resolves image/media references across storage backends (base64 data URLs,
// MinIO object storage, HTTP URLs) and handles provider-compatible compression.
// Extracted from ChatRoutes.ts to enforce route→service architectural boundary.

import FileService from "./FileService.ts";
import logger from "../utils/logger.ts";
import {
  compressImageForSizeLimit,
  constrainImageDimensions,
} from "../utils/media.ts";

import type { ConversationMessage } from "./harnesses/types.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { FILE_CATEGORIES } from "../constants.ts";

// ─── Compress oversized data URLs ───────────────────────────
/**
 * Compress an oversized image data URL.
 * Parses the data URL, checks decoded size, runs through compressImageForSizeLimit,
 * and reconstructs if compression changed the data.
 */
export async function compressDataUrlIfOversized(
  dataUrl: string,
): Promise<string> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUrl;
  let mimeType = match[1];
  if (!mimeType.startsWith("image/")) return dataUrl;
  let base64Data = match[2];
  // Step 1: enforce pixel dimension limits (Anthropic rejects >8000px)
  try {
    const dimensionResult = await constrainImageDimensions(
      base64Data,
      mimeType,
    );
    if (dimensionResult.data !== base64Data) {
      base64Data = dimensionResult.data;
      mimeType = dimensionResult.mediaType;
      logger.info(
        `[MediaResolution] Dimension-constrained image: now ${(base64Data.length / 1024 / 1024).toFixed(2)} MB b64 (${mimeType})`,
      );
    }
  } catch (error: unknown) {
    logger.warn(
      `[MediaResolution] Dimension constraint failed: ${getErrorMessage(error)}`,
    );
  }
  // Step 2: enforce byte-size limit
  const base64Length = base64Data.length; // Anthropic checks base64 STRING length
  const MAX_BASE64_BYTES = 5 * 1024 * 1024;
  if (base64Length <= MAX_BASE64_BYTES) {
    // Dimensions may have changed even if size is fine — rebuild URL
    return `data:${mimeType};base64,${base64Data}`;
  }
  logger.info(
    `[MediaResolution] Oversized image detected: ${(base64Length / 1024 / 1024).toFixed(2)} MB b64 (${mimeType}). Compressing...`,
  );
  try {
    const result = await compressImageForSizeLimit(base64Data, mimeType);
    const newUrl = `data:${result.mediaType};base64,${result.data}`;
    const newLength = result.data.length;
    logger.info(
      `[MediaResolution] Compressed: ${(base64Length / 1024 / 1024).toFixed(2)} MB → ${(newLength / 1024 / 1024).toFixed(2)} MB b64 (${result.mediaType})`,
    );
    return newUrl;
  } catch (error: unknown) {
    logger.error(
      `[MediaResolution] Image compression failed: ${getErrorMessage(error)}. Sending original.`,
    );
    return `data:${mimeType};base64,${base64Data}`;
  }
}

// ─── Single media reference resolution ──────────────────────
/**
 * Resolve a single media reference to provider-ready and storage-ready forms.
 *
 * Returns:
 *  - `providerRef`: base64 data URL ready for LLM provider consumption
 *  - `storageRef`: MinIO ref or original URL for conversation persistence
 *
 * Handles:
 *  - data:... base64  → upload to MinIO (original gets minio ref), provider gets data URL
 *  - minio://...       → download from MinIO (original unchanged), provider gets data URL
 *  - http(s)://...     → fetch (original unchanged), provider gets data URL
 */
export async function resolveMediaReference(
  reference: string,
  project: string,
  username: string,
): Promise<{ providerRef: string; storageRef: string }> {
  // Already a base64 data URL — compress if oversized, upload to MinIO for storage
  if (reference.startsWith("data:")) {
    let providerRef = reference;
    // Compress oversized images before they reach any provider
    providerRef = await compressDataUrlIfOversized(providerRef);
    let storageRef = providerRef;
    try {
      const { ref: minioRef } = await FileService.uploadFile(
        reference, // Upload original to MinIO
        FILE_CATEGORIES.UPLOADS,
        project,
        username,
      );
      storageRef = minioRef;
    } catch (error: unknown) {
      logger.error(
        `[MediaResolution] Failed to upload media to MinIO: ${getErrorMessage(error)}`,
      );
    }
    return { providerRef, storageRef };
  }
  // MinIO reference — download for provider, keep ref for storage
  const isMinioReference = FileService.isMinioRef(reference) as boolean;
  if (isMinioReference) {
    try {
      const key = FileService.extractKey(reference);
      const file = await FileService.getFile(key);
      if (!file) {
        logger.warn(
          `[MediaResolution] Could not resolve MinIO ref: ${reference}`,
        );
        return { providerRef: reference, storageRef: reference };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString("base64");
      let providerRef = `data:${file.contentType};base64,${base64}`;
      // Constrain dimensions + compress oversized images before they reach any provider
      providerRef = await compressDataUrlIfOversized(providerRef);
      return {
        providerRef,
        storageRef: reference,
      };
    } catch (error: unknown) {
      logger.error(
        `[MediaResolution] Failed to resolve MinIO ref ${reference}: ${getErrorMessage(error)}`,
      );
      return { providerRef: reference, storageRef: reference };
    }
  }
  // HTTP(S) URL — fetch for provider, keep URL for storage
  if (reference.startsWith("http://") || reference.startsWith("https://")) {
    try {
      const response = await fetch(reference);
      if (!response.ok) {
        logger.warn(
          `[MediaResolution] Failed to fetch media URL (${response.status}): ${reference}`,
        );
        return { providerRef: reference, storageRef: reference };
      }
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      let providerRef = `data:${contentType};base64,${base64}`;
      // Compress oversized images before they reach any provider
      providerRef = await compressDataUrlIfOversized(providerRef);
      return {
        providerRef,
        storageRef: reference,
      };
    } catch (error: unknown) {
      logger.error(
        `[MediaResolution] Failed to fetch media URL ${reference}: ${getErrorMessage(error)}`,
      );
      return { providerRef: reference, storageRef: reference };
    }
  }
  // Unknown — pass through
  return { providerRef: reference, storageRef: reference };
}

// ─── Batch message media resolution ─────────────────────────
/**
 * Resolve image references in messages for both provider use and storage.
 *
 * Returns a deep copy of messages where all images are base64 data URLs
 * (ready for providers). The ORIGINAL messages array is mutated in-place
 * so that images are stored as minio:// refs (for conversation storage).
 *
 * Handles images, audio, video, and pdf media array fields.
 */
export async function resolveMessageMediaReferences(
  messages: ConversationMessage[],
  project: string,
  username: string,
): Promise<ConversationMessage[]> {
  // Deep copy for the provider — images will be data URLs
  const providerMessages = messages.map((message) => ({ ...message }));
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // Resolve media array fields: images, audio, video, pdf
    for (const field of ["images", "audio", "video", "pdf"] as const) {
      const array = (message as Record<string, unknown>)[field];
      if (array && Array.isArray(array) && array.length > 0) {
        const providerArray: string[] = [];
        const storageArray: string[] = [];
        await Promise.all(
          array.map(async (reference: string, referenceIndex: number) => {
            const resolved = await resolveMediaReference(
              reference,
              project,
              username,
            );
            providerArray[referenceIndex] = resolved.providerRef;
            storageArray[referenceIndex] = resolved.storageRef;
          }),
        );
        (providerMessages[i] as Record<string, unknown>)[field] = providerArray;
        (message as Record<string, unknown>)[field] = storageArray;
      }
    }
  }
  return providerMessages;
}
