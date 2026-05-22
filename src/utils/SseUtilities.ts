import { handleConversation } from "../routes/ChatRoutes.ts";
import { ProviderError } from "./errors.ts";
import { createAbortController } from "./AbortController.ts";
import { Request, Response, NextFunction } from "express";
import { SseEvent } from "../types/SseTypes.ts";
import type { ChatRequest } from "../types/schemas.ts";

// ─── shared by /chat and /agent routes ──────────────────────

/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 */
export function initSseResponse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 */
export function createSseEmitter(res: Response, signal: AbortSignal) {
  // Disable Nagle's algorithm for minimal SSE latency.
  // Without this, small SSE events can sit in the TCP buffer when
  // the server blocks on await (e.g. plan approval promise).
  if (res.socket) res.socket.setNoDelay(true);

  return (event: SseEvent) => {
    if (!signal.aborted) {
      if (event.type === "image" && event.minioRef && event.data) {
        const { data: _stripped, ...lightweight } = event;
        res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // Force-flush the write buffer. Without compression middleware,
      // res.flush() doesn't exist — use cork()/uncork() to guarantee
      // Node flushes pending writes to the socket immediately. Critical
      // for events emitted before an await block (plan_proposal,
      // approval_required) where no further writes push the buffer.
      const resWithFlush = res as Response & { flush?: () => void };
      if (typeof resWithFlush.flush === "function") {
        resWithFlush.flush();
      } else if (res.socket && !res.socket.destroyed) {
        res.socket.uncork?.();
        res.socket.cork?.();
        res.socket.uncork?.();
      }
    }
  };
}

/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 */
export function buildJsonResponseFromEvents(events: SseEvent[], reqBody: ChatRequest) {
  const errorEvent = events.find((e: SseEvent) => e.type === "error");
  if (errorEvent) {
    return { error: new ProviderError("server", errorEvent.message || "Unknown error", 500) };
  }

  const doneEvent = events.find((e: SseEvent) => e.type === "done") || ({} as SseEvent);
  const text = events
    .filter((e: SseEvent) => e.type === "chunk")
    .map((e: SseEvent) => e.content)
    .join("");
  const thinking = events
    .filter((e: SseEvent) => e.type === "thinking")
    .map((e: SseEvent) => e.content)
    .join("");
  const images = events
    .filter((e: SseEvent) => e.type === "image")
    .map((e: SseEvent) => ({
      data: e.data,
      mimeType: e.mimeType,
      minioRef: e.minioRef || null,
    }));

  const toolCalls = events
    .filter((e: SseEvent) => e.type === "tool_execution" && e.status === "calling")
    .map((e: SseEvent) => ({
      name: e.tool?.name,
      args: e.tool?.args,
    }));

  return {
    response: {
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      provider: doneEvent.provider || reqBody.provider,
      model: doneEvent.model || reqBody.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.traceId && { traceId: doneEvent.traceId }),
      ...(doneEvent.conversationId && {
        conversationId: doneEvent.conversationId,
      }),
    },
  };
}

/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 */
export async function handleSseRequest(
  req: Request,
  res: Response,
  params: ChatRequest,
  handler: (params: ChatRequest, onEvent: (event: SseEvent) => void, context: { signal: AbortSignal }) => Promise<void> = handleConversation,
) {
  initSseResponse(res);

  const controller = createAbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  await handler(params, createSseEmitter(res, controller.signal), {
    signal: controller.signal,
  });

  if (!controller.signal.aborted) res.end();
}

/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 */
export async function handleJsonRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  params: ChatRequest,
  handler: (params: ChatRequest, onEvent: (event: SseEvent) => void) => Promise<void> = handleConversation,
) {
    const events: SseEvent[] = [];
  await handler(params, (event: SseEvent) => events.push(event));

    const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}
