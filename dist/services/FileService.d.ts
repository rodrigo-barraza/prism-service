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
  
  
     * @returns {Promise<{ ref: string, size: number, contentType: string }>}
     *   ref is either `minio://...` or the original dataUrl.
     */
    uploadFile(dataUrl: any, category?: any, project?: any, username?: any): Promise<{
        ref: any;
        size: number;
        contentType: string;
    } | {
        ref: string;
        size: number;
        contentType: any;
    }>;
    /**
     * Get a file stream from a MinIO reference.
  
     * @returns {Promise<{ stream: import('stream').Readable, contentType: string } | null>}
     */
    getFile(key: any): Promise<{
        stream: import("node:stream").Readable;
        contentType: any;
    } | null>;
    /**
     * Check if a string is a MinIO reference.
  
  
     */
    isMinioRef(ref: any): boolean;
    /**
     * Extract the object key from a MinIO reference.
  
     * @returns {string} - e.g. "files/abc-123.png"
     */
    extractKey(ref: any): any;
};
export default FileService;
//# sourceMappingURL=FileService.d.ts.map