/**
 * Compress a base64-encoded image to fit within a byte-size limit.
 *
 * Strategy:
 *  - GIFs → ffmpeg resize (preserves animation for models that support it)
 *  - Everything else → sharp JPEG conversion + progressive downscale
 *


 * @returns {Promise<{ data: string, mediaType: string }>} Compressed base64 + updated MIME
 */
export declare function compressImageForSizeLimit(base64Data: string, mediaType: string, maxBytes?: number): Promise<{
    data: string;
    mediaType: string;
}>;
/**
 * Constrain image pixel dimensions to MAX_IMAGE_DIMENSION.
 * If either width or height exceeds the limit, the image is downscaled
 * proportionally using sharp's Lanczos3 resampler.
 *
 * GIFs are skipped (ffmpeg handles them separately in byte-size compression).
 *


 * @returns {Promise<{ data: string, mediaType: string }>} Possibly resized base64 + MIME
 */
export declare function constrainImageDimensions(base64Data: string, mediaType: string, maxDim?: number): Promise<{
    data: string;
    mediaType: string;
}>;
/**
 * Detect MIME type from a base64 data URL.

 * @returns {string|null} The MIME type (e.g. "image/png") or null
 */
export declare function getDataUrlMimeType(dataUrl: string): string | null;
/**
 * Check if a string is a valid data: URL, HTTP(S) URL, or other ref type.


 */
export declare function getUrlType(url: string): "unknown" | "data" | "http";
/**
 * Infer MIME category from a URL's file extension.


 */
export declare function inferMimeFromUrl(url: string): "unknown" | "text" | "image" | "pdf";
/**
 * Extract frames from a video data URL using ffmpeg.
 * Returns an array of JPEG image data URLs (one per frame at 1fps).
 *
 * Each image frame costs ~256 tokens in vision models. Default maxFrames=8
 * keeps total image tokens ~2K, leaving room for text generation in
 * local models with limited context windows (4K-8K typical).
 *


 * @returns {Promise<string[]>} Array of data:image/jpeg;base64,... URLs
 */
export declare function extractVideoFrames(videoDataUrl: string, options?: {
    fps?: number;
    maxFrames?: number;
    quality?: number;
}): Promise<string[]>;
//# sourceMappingURL=media.d.ts.map