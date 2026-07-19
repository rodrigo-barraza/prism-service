// ─── Media Resolution Service ───────────────────────────────
// Resolves image/media references across storage backends (base64 data URLs,
// MinIO object storage, HTTP URLs) and handles provider-compatible compression.
// Extracted from ChatRoutes.ts to enforce route→service architectural boundary.

import FileService from "./FileService.ts";
import logger from "#src/utils/logger";
import {
  compressImageForSizeLimit,
  constrainImageDimensions,
} from "#src/utils/media";

import type { ConversationMessage } from "./harnesses/types.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { FILE_CATEGORIES } from "#src/constants";

/** Message media array fields resolved for providers and storage. */
export const RESOLVABLE_MEDIA_FIELDS = [
  "images",
  "audio",
  "video",
  "pdf",
  "documents",
] as const;

/** Client file-attachment entry: { url, name, mimeType, modality }. */
interface FileAttachment {
  url?: string;
  name?: string;
  mimeType?: string;
  modality?: string;
}

// ─── Compress oversized data URLs ───────────────────────────
/**
 * Compress an oversized image data URL.
 * Parses the data URL, checks decoded size, runs through compressImageForSizeLimit,
 * and reconstructs if compression changed the data.
 */
export async function compressDataUrlIfOversized(
  dataUrl: string,
  maxDimension?: number,
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
      maxDimension,
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
    const result = await compressImageForSizeLimit(
      base64Data,
      mimeType,
      undefined,
      maxDimension,
    );
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
  maxImageDimension?: number,
): Promise<{ providerRef: string; storageRef: string }> {
  // Already a base64 data URL — compress if oversized, upload to MinIO for storage
  if (reference.startsWith("data:")) {
    let providerRef = reference;
    // Compress oversized images before they reach any provider
    providerRef = await compressDataUrlIfOversized(
      providerRef,
      maxImageDimension,
    );
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
      providerRef = await compressDataUrlIfOversized(
        providerRef,
        maxImageDimension,
      );
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
      providerRef = await compressDataUrlIfOversized(
        providerRef,
        maxImageDimension,
      );
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

// ─── Document reference resolution ──────────────────────────
/**
 * Resolve a `documents` entry (CSV/DOCX/XLSX/…) — unlike images, documents
 * are NEVER inlined as provider base64. The provider/tool-facing form
 * prefers a resolvable http URL (direct MinIO bucket URL) so reader tools
 * receive a lightweight reference instead of megabytes of base64.
 *
 *  - data:...   → upload to MinIO; storage = minio ref, provider = public URL
 *                 (falls back to the data URI when MinIO is unavailable —
 *                 the readers accept data: URIs too)
 *  - minio://   → storage unchanged, provider = public URL
 *  - http(s):// → passthrough on both sides (no fetch, no inlining)
 */
export async function resolveDocumentReference(
  reference: string,
  project: string,
  username: string,
): Promise<{ providerRef: string; storageRef: string }> {
  if (reference.startsWith("data:")) {
    try {
      const { ref: minioRef } = await FileService.uploadFile(
        reference,
        FILE_CATEGORIES.UPLOADS,
        project,
        username,
      );
      const publicUrl = FileService.getPublicUrl(minioRef);
      return { providerRef: publicUrl || reference, storageRef: minioRef };
    } catch (error: unknown) {
      logger.error(
        `[MediaResolution] Failed to upload document to MinIO: ${getErrorMessage(error)}`,
      );
      return { providerRef: reference, storageRef: reference };
    }
  }
  if (FileService.isMinioRef(reference)) {
    const publicUrl = FileService.getPublicUrl(reference);
    return { providerRef: publicUrl || reference, storageRef: reference };
  }
  // http(s) or unknown — pass through
  return { providerRef: reference, storageRef: reference };
}

// ─── Client file-attachment normalization ───────────────────
/**
 * Fold client `files: [{ url, name, mimeType, modality }]` attachments
 * into the resolvable media array fields so providers and the tool-input
 * resolver can see them:
 *   audio → audio[], video → video[], pdf → pdf[], image → images[],
 *   document (CSV/DOCX/XLSX/…) → documents[]
 *
 * Idempotent (URLs already present are skipped) and mutation-safe: the
 * `files` field itself is left untouched for the client UI. Runs before
 * resolution so the folded entries get resolved like any other media.
 */
export function normalizeFileAttachments(messages: ConversationMessage[]) {
  for (const message of messages) {
    const files = (message as Record<string, unknown>).files;
    if (!Array.isArray(files) || files.length === 0) continue;
    for (const file of files as FileAttachment[]) {
      const url = typeof file?.url === "string" ? file.url : null;
      if (!url) continue;
      const modality = file.modality || "";
      const mimeType = file.mimeType || "";
      let targetField: (typeof RESOLVABLE_MEDIA_FIELDS)[number];
      if (modality === "image" || mimeType.startsWith("image/")) {
        targetField = "images";
      } else if (modality === "audio" || mimeType.startsWith("audio/")) {
        targetField = "audio";
      } else if (modality === "video" || mimeType.startsWith("video/")) {
        targetField = "video";
      } else if (modality === "pdf" || mimeType === "application/pdf") {
        targetField = "pdf";
      } else {
        // CSV, DOCX, XLSX, and anything else document-shaped
        targetField = "documents";
      }
      const record = message as Record<string, unknown>;
      const existing = Array.isArray(record[targetField])
        ? (record[targetField] as string[])
        : [];
      if (!existing.includes(url)) {
        record[targetField] = [...existing, url];
      }
    }
  }
}

// ─── Batch message media resolution ─────────────────────────
/**
 * Resolve image references in messages for both provider use and storage.
 *
 * Returns a deep copy of messages where all images are base64 data URLs
 * (ready for providers). The ORIGINAL messages array is mutated in-place
 * so that images are stored as minio:// refs (for conversation storage).
 *
 * Handles the images, audio, video, pdf, and documents media array fields;
 * client `files[]` attachments are folded into those fields first.
 * `documents` entries resolve to lightweight URLs (never inlined base64) —
 * see resolveDocumentReference.
 */
export async function resolveMessageMediaReferences(
  messages: ConversationMessage[],
  project: string,
  username: string,
  { maxImageDimension }: { maxImageDimension?: number } = {},
): Promise<ConversationMessage[]> {
  // Fold client file attachments into resolvable media fields first
  normalizeFileAttachments(messages);
  // Deep copy for the provider — images will be data URLs
  const providerMessages = messages.map((message) => ({ ...message }));
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // Resolve media array fields: images, audio, video, pdf, documents
    for (const field of RESOLVABLE_MEDIA_FIELDS) {
      const array = (message as Record<string, unknown>)[field];
      if (array && Array.isArray(array) && array.length > 0) {
        const providerArray: string[] = [];
        const storageArray: string[] = [];
        await Promise.all(
          array.map(async (reference: string, referenceIndex: number) => {
            const resolved =
              field === "documents"
                ? await resolveDocumentReference(reference, project, username)
                : await resolveMediaReference(
                    reference,
                    project,
                    username,
                    maxImageDimension,
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
