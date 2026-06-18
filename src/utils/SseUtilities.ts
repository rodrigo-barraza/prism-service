import { handleConversation } from "../routes/ChatRoutes.ts";
import { ProviderError } from "./errors.ts";
import { createAbortController } from "./AbortController.ts";
import logger from "./logger.ts";
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
      const responseWithFlush = res as Response & { flush?: () => void };
      if (typeof responseWithFlush.flush === "function") {
        responseWithFlush.flush();
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
export function buildJsonResponseFromEvents(
  events: SseEvent[],
  requestBody: ChatRequest,
) {
  const errorEvent = events.find((e: SseEvent) => e.type === "error");
  if (errorEvent) {
    return {
      error: new ProviderError(
        "server",
        errorEvent.message || "Unknown error",
        500,
      ),
    };
  }

  const doneEvent =
    events.find((e: SseEvent) => e.type === "done") || ({} as SseEvent);
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
    .filter(
      (e: SseEvent) => e.type === "tool_execution" && e.status === "calling",
    )
    .map((e: SseEvent) => ({
      name: e.tool?.name,
      args: e.tool?.args,
    }));

  const toolResults = events
    .filter(
      (e: SseEvent) =>
        e.type === "tool_execution" &&
        (e.status === "done" || e.status === "error"),
    )
    .map((e: SseEvent) => ({
      name: e.tool?.name,
      args: e.tool?.args,
      result: e.tool?.result,
      status: e.status,
    }));

  const audioEvents = events
    .filter((e: SseEvent) => e.type === "audio")
    .map((e: SseEvent) => ({
      data: e.data,
      mimeType: e.mimeType,
      minioRef: e.minioRef || null,
    }));

  return {
    response: {
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      audio: audioEvents.length > 0 ? audioEvents : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      provider: doneEvent.provider || requestBody.provider,
      model: doneEvent.model || requestBody.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.audioRef && { audioRef: doneEvent.audioRef }),
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
  handler: (
    params: ChatRequest,
    onEvent: (event: SseEvent) => void,
    context: { signal: AbortSignal },
  ) => Promise<void> = handleConversation,
) {
  initSseResponse(res);

  // Disable socket-level timeouts for long-lived SSE streams.
  // Even with server.requestTimeout = 0, the underlying socket can
  // inherit a default timeout from Node.js or Express.
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 30_000);
  }

  const connectionStartTime = Date.now();
  const controller = createAbortController();
  res.on("close", () => {
    const durationSeconds = ((Date.now() - connectionStartTime) / 1000).toFixed(
      1,
    );
    logger.warn(
      `[SSE] Connection closed after ${durationSeconds}s — ` +
        `writableFinished=${res.writableFinished}, destroyed=${res.destroyed}, ` +
        `socket.destroyed=${req.socket?.destroyed}`,
    );
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
  handler: (
    params: ChatRequest,
    onEvent: (event: SseEvent) => void,
  ) => Promise<void> = handleConversation,
) {
  const events: SseEvent[] = [];
  await handler(params, (event: SseEvent) => events.push(event));

  const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}
