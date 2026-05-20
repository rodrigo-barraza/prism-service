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
    stream: any;
    contentType: string;
};
export default FileService;
//# sourceMappingURL=FileService.d.ts.map