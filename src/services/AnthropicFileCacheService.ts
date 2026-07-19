// ────────────────────────────────────────────────────────────
// AnthropicFileCacheService — upload-once media for Anthropic
// ────────────────────────────────────────────────────────────
// Instead of re-inlining multi-megabyte base64 images/PDFs on every
// turn, media is uploaded ONCE to Anthropic's Files API (beta
// files-api-2025-04-14) and referenced per-turn as a stable file_id
// content block:
//   { type: "image",    source: { type: "file", file_id } }
//   { type: "document", source: { type: "file", file_id } }
// This cuts request bytes/latency and keeps the prompt-cache prefix
// byte-stable across turns.
//
// Cache: sha256(media bytes) → file_id, held in memory and persisted
// to MongoDB (COLLECTIONS.ANTHROPIC_FILE_CACHE) so ids survive
// restarts. Any Files API failure falls back seamlessly to the
// inline-base64 path and invalidates the cache entry.
//
// Only active against the first-party Anthropic API — the Files API
// does not exist on Bedrock/Vertex. Disable outright with
// ANTHROPIC_FILES_API_ENABLED=false.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import crypto from "crypto";
import logger from "#src/utils/logger";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_FILES_API_ENABLED,
  MONGO_DB_NAME,
} from "#config";
import { COLLECTIONS, ENCODINGS } from "#src/constants";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** Beta header value required on both upload and messages calls. */
export const ANTHROPIC_FILES_API_BETA = "files-api-2025-04-14";

/** Images below this base64 length stay inline — upload overhead isn't worth it. */
const MIN_INLINE_BYTES_FOR_UPLOAD = 100 * 1024;

/** Files API hard cap — 500 MB (decoded). */
const MAX_FILE_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Content block shape used by the Anthropic provider (structural subset). */
interface FileSourceBlock {
  type: string;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
    url?: string;
    file_id?: string;
  };
  [key: string]: unknown;
}

interface FileCacheRecord {
  hash: string;
  fileId: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface FileSourceSubstitution {
  block: FileSourceBlock;
  originalSource: NonNullable<FileSourceBlock["source"]>;
  hash: string;
  fileId: string;
}

export interface FileSourceApplication {
  /** Whether any block now references a Files API file_id. */
  applied: boolean;
  substitutions: FileSourceSubstitution[];
  fileIds: string[];
}

const memoryCache = new Map<string, string>(); // hash → file_id
let indexEnsured = false;
let uploadClient: Anthropic | null = null;

/** getDb throws before connectDatabase() runs — normalize to null. */
function getDatabaseSafe() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

function getUploadClient(): Anthropic {
  if (!uploadClient) {
    uploadClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return uploadClient;
}

function hashMedia(base64Data: string, mediaType: string): string {
  return crypto
    .createHash("sha256")
    .update(`${mediaType}|`)
    .update(base64Data)
    .digest("hex");
}

export default class AnthropicFileCacheService {
  /**
   * Whether Files API substitution is active: config flag ON, an API key
   * present, and the SDK pointed at the first-party API (the Files API
   * does not exist behind Bedrock/Vertex base URLs).
   */
  static isEnabled(): boolean {
    if (!ANTHROPIC_FILES_API_ENABLED || !ANTHROPIC_API_KEY) return false;
    if (ANTHROPIC_BASE_URL && !ANTHROPIC_BASE_URL.includes("api.anthropic.com"))
      return false;
    return true;
  }

  /** Look up a cached file_id by media hash — memory first, then Mongo. */
  static async getCachedFileId(hash: string): Promise<string | null> {
    const cached = memoryCache.get(hash);
    if (cached) return cached;

    const database = getDatabaseSafe();
    if (!database) return null;
    try {
      const record = (await database
        .collection(COLLECTIONS.ANTHROPIC_FILE_CACHE)
        .findOne({ hash })) as FileCacheRecord | null;
      if (!record?.fileId) return null;
      memoryCache.set(hash, record.fileId);
      return record.fileId;
    } catch (error: unknown) {
      logger.warn(
        `[AnthropicFileCache] Lookup failed for ${hash.slice(0, 12)}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /** Remove a mapping (stale/deleted file_id) from memory and Mongo. */
  static async invalidate(hash: string): Promise<void> {
    memoryCache.delete(hash);
    const database = getDatabaseSafe();
    if (!database) return;
    try {
      await database
        .collection(COLLECTIONS.ANTHROPIC_FILE_CACHE)
        .deleteOne({ hash });
    } catch (error: unknown) {
      logger.warn(
        `[AnthropicFileCache] Invalidate failed for ${hash.slice(0, 12)}: ${getErrorMessage(error)}`,
      );
    }
  }

  /** Upload media to the Files API and persist the hash → file_id mapping. */
  static async uploadAndCache(
    hash: string,
    base64Data: string,
    mediaType: string,
  ): Promise<string> {
    const buffer = Buffer.from(base64Data, ENCODINGS.BASE64);
    if (buffer.length > MAX_FILE_UPLOAD_BYTES) {
      throw new Error(
        `Media exceeds the Files API 500 MB limit (${buffer.length} bytes)`,
      );
    }
    const extension = mediaType.split("/")[1]?.split("+")[0] || "bin";
    const file = await toFile(buffer, `${hash.slice(0, 16)}.${extension}`, {
      type: mediaType,
    });
    const metadata = await getUploadClient().beta.files.upload({
      file,
      betas: [ANTHROPIC_FILES_API_BETA],
    });

    memoryCache.set(hash, metadata.id);
    const database = getDatabaseSafe();
    if (database) {
      const collection = database.collection(COLLECTIONS.ANTHROPIC_FILE_CACHE);
      if (!indexEnsured) {
        indexEnsured = true;
        collection
          .createIndex({ hash: 1 }, { unique: true })
          .catch((error: Error) =>
            logger.warn(
              `[AnthropicFileCache] createIndex failed: ${error.message}`,
            ),
          );
      }
      const record: FileCacheRecord = {
        hash,
        fileId: metadata.id,
        mediaType,
        sizeBytes: buffer.length,
        createdAt: new Date().toISOString(),
      };
      collection
        .updateOne({ hash }, { $set: record }, { upsert: true })
        .catch((error: Error) =>
          logger.warn(
            `[AnthropicFileCache] Persist failed for ${hash.slice(0, 12)}: ${error.message}`,
          ),
        );
    }
    logger.info(
      `[AnthropicFileCache] Uploaded ${mediaType} (${(buffer.length / 1024).toFixed(0)} KB) → ${metadata.id}`,
    );
    return metadata.id;
  }

  /**
   * Walk prepared Anthropic messages and swap large base64 image/document
   * blocks for Files API file_id references. Mutates blocks in place and
   * returns the substitution record needed for the beta header and for
   * reverting on failure. Per-block failures fall back to inline silently
   * (the block simply keeps its base64 source).
   */
  static async applyFileSources(
    messages: Array<{ content?: unknown; [key: string]: unknown }>,
  ): Promise<FileSourceApplication> {
    const result: FileSourceApplication = {
      applied: false,
      substitutions: [],
      fileIds: [],
    };
    if (!AnthropicFileCacheService.isEnabled()) return result;

    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as FileSourceBlock[]) {
        const isImage = block.type === "image";
        const isDocument = block.type === "document";
        if (!isImage && !isDocument) continue;
        if (block.source?.type !== "base64" || !block.source.data) continue;
        // Small images stay inline — upload round-trips aren't worth it
        if (isImage && block.source.data.length < MIN_INLINE_BYTES_FOR_UPLOAD)
          continue;

        const mediaType =
          block.source.media_type ||
          (isDocument ? "application/pdf" : "image/png");
        const hash = hashMedia(block.source.data, mediaType);
        try {
          let fileId = await AnthropicFileCacheService.getCachedFileId(hash);
          if (!fileId) {
            fileId = await AnthropicFileCacheService.uploadAndCache(
              hash,
              block.source.data,
              mediaType,
            );
          }
          const originalSource = block.source;
          block.source = { type: "file", file_id: fileId };
          result.substitutions.push({ block, originalSource, hash, fileId });
          result.fileIds.push(fileId);
          result.applied = true;
        } catch (error: unknown) {
          // Fall back to inline base64 for this block — never fail the turn
          logger.warn(
            `[AnthropicFileCache] Substitution failed (${mediaType}): ${getErrorMessage(error)} — sending inline`,
          );
        }
      }
    }
    return result;
  }

  /**
   * Revert file_id substitutions back to their inline base64 sources and
   * invalidate the cached mappings. Used when the messages call rejects a
   * file_id (e.g. the file was deleted server-side).
   */
  static async revertFileSources(
    application: FileSourceApplication,
  ): Promise<void> {
    for (const substitution of application.substitutions) {
      substitution.block.source = substitution.originalSource;
      await AnthropicFileCacheService.invalidate(substitution.hash);
    }
    application.substitutions = [];
    application.fileIds = [];
    application.applied = false;
  }

  /**
   * Whether an error from the messages endpoint implicates a file_id we
   * substituted (stale/deleted file, beta not available, malformed source).
   */
  static isFileSourceError(
    error: unknown,
    application: FileSourceApplication,
  ): boolean {
    if (!application.applied) return false;
    const message = getErrorMessage(error);
    if (application.fileIds.some((fileId) => message.includes(fileId)))
      return true;
    const status = (error as { status?: number })?.status;
    return (
      (status === 400 || status === 404) && /file[_ ]?id|files?[- ]api/i.test(message)
    );
  }

  /** Test hook — clear the in-memory mapping cache. */
  static clearMemoryCache(): void {
    memoryCache.clear();
    uploadClient = null;
  }
}
