import crypto from "crypto";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import logger from "../utils/logger.ts";

/**
 * MIME type → file extension map for common file types.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogg",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
};

interface MinioStatResult {
  metaData?: Record<string, string>;
  size?: number;
  lastModified?: Date;
  etag?: string;
}

/**
 * FileService — abstracts file storage with MinIO primary / MongoDB inline fallback.
 *
 * When MinIO is available, files are uploaded to the bucket and a lightweight
 * reference string `minio://files/<uuid>.<ext>` is returned.
 *
 * When MinIO is unavailable, the original base64 data URL is returned unchanged,
 * so it continues to be stored inline in MongoDB.
 */
const FileService = ({
  /**
   * Whether external (MinIO) storage is active.
   */
  isExternalStorage(): boolean {
    return MinioWrapper.isAvailable();
  },

  /**
   * Upload a file from a base64 data URL.
   *
   * @returns {Promise<{ ref: string, size: number, contentType: string }>}
   *   ref is either `minio://...` or the original dataUrl.
   */
  async uploadFile(
    dataUrl: string,
    category = "uploads",
    project: string | null = null,
    username: string | null = null,
  ): Promise<{ ref: string; size: number; contentType: string }> {
    // If MinIO is not available, return the data URL as-is (MongoDB inline)
    if (!MinioWrapper.isAvailable()) {
      const size = Math.round((dataUrl.length * 3) / 4); // rough base64 → bytes
      return { ref: dataUrl, size, contentType: "application/octet-stream" };
    }

    // Parse the data URL
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      // Not a data URL — return as-is (could be a plain URL or already a ref)
      return { ref: dataUrl, size: 0, contentType: "application/octet-stream" };
    }

    const contentType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");
    const ext = MIME_TO_EXT[contentType] || "bin";

    // Build path: projects/{project}/{username}/{category}/{uuid}.{ext}
    // Falls back to flat {category}/{uuid}.{ext} when project/username not provided
    let key: string;
    if (project && username) {
      // Sanitize: never use raw IP addresses as path segments — they cause
      // duplicate directories when the same user is later identified by name.
      const safeUsername =
        /^\d{1,3}(\.\d{1,3}){3}$/.test(username) || username.includes(":")
          ? "anonymous"
          : username;
      key = `projects/${project}/${safeUsername}/${category}/${crypto.randomUUID()}.${ext}`;
    } else {
      key = `${category}/${crypto.randomUUID()}.${ext}`;
    }

    await MinioWrapper.upload(key, buffer, contentType);
    logger.info(
      `FileService: uploaded ${key} (${buffer.length} bytes, ${contentType})`,
    );

    return {
      ref: `minio://${key}`,
      size: buffer.length,
      contentType,
    };
  },

  /**
   * Get a file stream from a MinIO reference.
   *
   * @returns {Promise<{ stream: any, contentType: string } | null>}
   */
  async getFile(key: string): Promise<{ stream: any; contentType: string } | null> {
    if (!MinioWrapper.isAvailable()) return null;

    // Helper to fetch stat + stream for a given key
    const tryKey = async (k: string) => {
      const stat = (await MinioWrapper.stat(k)) as MinioStatResult | null | undefined;
      const stream = await MinioWrapper.get(k);
      return {
        stream,
        contentType:
          stat?.metaData?.["content-type"] || "application/octet-stream",
      };
    };

    try {
            return await tryKey(key);
    } catch {
      logger.error(`FileService: failed to get ${key}`);
      return null;
    }
  },

  /**
   * Check if a string is a MinIO reference.
   */
  isMinioRef(ref: any): ref is string {
    return typeof ref === "string" && ref.startsWith("minio://");
  },

  /**
   * Extract the object key from a MinIO reference.
   *
   * @returns {string} - e.g. "files/abc-123.png"
   */
  extractKey(ref: string): string {
    return ref.replace("minio://", "");
  },
} as any as { stream: any; contentType: string; });

export default FileService;
