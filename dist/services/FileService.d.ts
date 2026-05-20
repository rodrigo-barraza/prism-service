/**
 * FileService — abstracts file storage with MinIO primary / MongoDB inline fallback.
 *
 * When MinIO is available, files are uploaded to the bucket and a lightweight
 * reference string `minio://files/<uuid>.<ext>` is returned.
 *
 * When MinIO is unavailable, the original base64 data URL is returned unchanged,
 * so it continues to be stored inline in MongoDB.
 */
declare const FileService: {
    /**
     * Whether external (MinIO) storage is active.
     */
    isExternalStorage(): boolean;
    /**
     * Upload a file from a base64 data URL.
     *
     * @returns {Promise<{ ref: string, size: number, contentType: string }>}
     *   ref is either `minio://...` or the original dataUrl.
     */
    uploadFile(dataUrl: string, category?: string, project?: string | null, username?: string | null): Promise<{
        ref: string;
        size: number;
        contentType: string;
    }>;
    /**
     * Get a file stream from a MinIO reference.
     *
     * @returns {Promise<{ stream: Record<string, unknown>, contentType: string } | null>}
     */
    getFile(key: string): Promise<{
        stream: Record<string, unknown>;
        contentType: string;
    } | null>;
    /**
     * Check if a string is a MinIO reference.
     */
    isMinioRef(ref: unknown): ref is string;
    /**
     * Extract the object key from a MinIO reference.
     *
     * @returns {string} - e.g. "files/abc-123.png"
     */
    extractKey(ref: string): string;
};
export default FileService;
//# sourceMappingURL=FileService.d.ts.map