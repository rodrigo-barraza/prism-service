declare const MinioWrapper: {
    /**
     * Initialize the MinIO client with positional arguments (legacy Prism API).
  
  
     */
    init(endpoint: string, accessKey: string, secretKey: string, bucket: string): Promise<void>;
    isAvailable: () => boolean;
    getBucketUrl: () => string | null;
    getPublicUrl: (key: string) => string | null;
    upload: (key: string, buffer: Buffer, contentType: string) => Promise<void>;
    get: (key: string) => Promise<import("node:stream").Readable>;
    remove: (key: string) => Promise<void>;
    stat: (key: string) => Promise<Record<string, unknown>>;
    listObjects: (prefix: string) => Promise<import("@rodrigo-barraza/service-library/minio").MinioObjectInfo[]>;
};
export default MinioWrapper;
//# sourceMappingURL=MinioWrapper.d.ts.map