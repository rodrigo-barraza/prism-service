import { ProviderError } from "./errors.ts";
import { Request, Response, NextFunction } from "express";
import { SseEvent } from "../types/SseTypes.ts";
/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 *

 */
export declare function initSseResponse(res: Response): void;
/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 *


 */
export declare function createSseEmitter(res: Response, signal: AbortSignal): (event: SseEvent) => void;
/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 *


 * @returns {{ error?: object, response?: object }}
 */
export declare function buildJsonResponseFromEvents(events: SseEvent[], reqBody: any): {
    error: ProviderError;
    response?: undefined;
} | {
    response: {
        conversationId?: string | undefined;
        traceId?: string | undefined;
        text: string | null;
        thinking: string | null;
        images: {
            data: string | undefined;
            mimeType: string | undefined;
            minioRef: string | null;
        }[] | undefined;
        toolCalls: {
            name: string | undefined;
            args: Record<string, unknown> | undefined;
        }[] | undefined;
        provider: any;
        model: any;
        usage: Record<string, unknown> | null;
        estimatedCost: number | null;
    };
    error?: undefined;
};
/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 *


 */
export declare function handleSseRequest(req: Request, res: Response, params: any, handler?: (params: any, onEvent: (event: SseEvent) => void, context: {
    signal: AbortSignal;
}) => Promise<void>): Promise<void>;
/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *


 */
export declare function handleJsonRequest(req: Request, res: Response, next: NextFunction, params: any, handler?: (params: any, onEvent: (event: SseEvent) => void) => Promise<void>): Promise<void>;
//# sourceMappingURL=SseUtilities.d.ts.map