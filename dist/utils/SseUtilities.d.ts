import { ProviderError } from "./errors.ts";
/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 *

 */
export declare function initSseResponse(res: any): void;
/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 *


 */
export declare function createSseEmitter(res: any, signal: any): (event: any) => void;
/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 *


 * @returns {{ error?: object, response?: object }}
 */
export declare function buildJsonResponseFromEvents(events: any, reqBody: any): {
    error: ProviderError;
    response?: undefined;
} | {
    response: any;
    error?: undefined;
};
/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 *


 */
export declare function handleSseRequest(req: any, res: any, params: any, handler?: any): Promise<void>;
/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *


 */
export declare function handleJsonRequest(req: any, res: any, next: any, params: any, handler?: any): Promise<any>;
//# sourceMappingURL=SseUtilities.d.ts.map