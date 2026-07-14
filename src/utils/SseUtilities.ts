import { handleConversation } from "#src/routes/ChatRoutes";
import { ProviderError } from "./errors.ts";
import { createAbortController } from "./AbortController.ts";
import logger from "./logger.ts";
import { Request, Response, NextFunction } from "express";
import { SseEvent } from "#src/types/SseTypes";
import type { ChatRequest } from "#src/types/schemas";
import AgentSessionRegistry from "#src/services/AgentSessionRegistry";

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
export function createSseEmitter(res: Response, connectionSignal: AbortSignal) {
  // Disable Nagle's algorithm for minimal SSE latency.
  // Without this, small SSE events can sit in the TCP buffer when
  // the server blocks on await (e.g. plan approval promise).
  if (res.socket) res.socket.setNoDelay(true);

  return (event: SseEvent) => {
    if (!connectionSignal.aborted && !res.destroyed && !res.writableEnded) {
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
  const errorEvent = events.find((event: SseEvent) => event.type === "error");
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
    events.find((event: SseEvent) => event.type === "done") || ({} as SseEvent);
  const text = events
    .filter((event: SseEvent) => event.type === "chunk")
    .map((event: SseEvent) => event.content)
    .join("");
  const thinking = events
    .filter((event: SseEvent) => event.type === "thinking")
    .map((event: SseEvent) => event.content)
    .join("");
  const images = events
    .filter((event: SseEvent) => event.type === "image")
    .map((event: SseEvent) => ({
      data: event.data,
      mimeType: event.mimeType,
      minioRef: event.minioRef || null,
    }));

  const toolCalls = events
    .filter(
      (event: SseEvent) =>
        event.type === "tool_execution" && event.status === "calling",
    )
    .map((event: SseEvent) => ({
      name: event.tool?.name,
      args: event.tool?.args,
    }));

  const toolResults = events
    .filter(
      (event: SseEvent) =>
        event.type === "tool_execution" &&
        (event.status === "done" || event.status === "error"),
    )
    .map((event: SseEvent) => ({
      name: event.tool?.name,
      args: event.tool?.args,
      result: event.tool?.result,
      status: event.status,
    }));

  const audioEvents = events
    .filter((event: SseEvent) => event.type === "audio")
    .map((event: SseEvent) => ({
      data: event.data,
      mimeType: event.mimeType,
      minioRef: event.minioRef || null,
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
 * Options for SSE request handling.
 *
 * `persistOnDisconnect` — When true (used by /agent), the handler keeps
 * running after the SSE connection drops. The handler's `signal` is only
 * aborted by an explicit POST /agent/stop call. When false (default,
 * used by /chat), the handler aborts immediately on client disconnect
 * (legacy behavior).
 */
export interface SseRequestOptions {
  persistOnDisconnect?: boolean;
}

/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController(s), runs the handler, and closes.
 *
 * Two-signal architecture:
 *   - connectionController — fires when the SSE socket closes (client
 *     disconnect, mobile screen lock, network drop). Guards `emit()` writes.
 *   - stopController — fires only on explicit user stop (POST /agent/stop).
 *     Passed to the handler as `context.signal` for loop-control checks.
 *
 * When `persistOnDisconnect` is false (default), connection close also
 * aborts the stop controller (legacy behavior for non-agentic routes).
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
  options: SseRequestOptions = {},
) {
  const { persistOnDisconnect = false } = options;

  initSseResponse(res);

  // Disable socket-level timeouts for long-lived SSE streams.
  // Even with server.requestTimeout = 0, the underlying socket can
  // inherit a default timeout from Node.js or Express.
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 30_000);
  }

  const connectionStartTime = Date.now();
  const connectionController = createAbortController();

  // Heartbeat: SSE comment frames every 15s so clients can distinguish a
  // quiet-but-alive stream (long prefill, slow tool) from a dead socket.
  // Comment lines are invisible to the JSON event protocol — old clients
  // skip them in their `data: ` line filter.
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatInterval = setInterval(() => {
    if (
      !connectionController.signal.aborted &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      res.write(`: ping\n\n`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // For persistent sessions (/agent), register a separate stop controller
  // in the session registry so POST /agent/stop can abort it explicitly.
  // For non-persistent sessions (/chat), reuse the connection controller
  // as the stop signal (legacy behavior: disconnect = abort).
  const conversationId = (params as Record<string, unknown>).conversationId as
    | string
    | undefined;
  let stopController: AbortController;

  if (persistOnDisconnect && conversationId) {
    // Admission control: one active turn per conversation. Previously a
    // second request silently aborted the first via registry overwrite —
    // both loops then raced each other's finalize ($push into the same
    // document) and the first handler's cleanup deleted the second
    // session's registry entry, breaking /agent/stop for the live turn.
    if (AgentSessionRegistry.isActive(conversationId)) {
      logger.warn(
        `[SSE] Rejected concurrent agent turn for conversation ${conversationId} — a generation is already running`,
      );
      const emitRejection = createSseEmitter(res, connectionController.signal);
      emitRejection({
        type: "error",
        code: "GENERATION_IN_PROGRESS",
        message:
          "A generation is already running for this conversation. Stop it first (POST /agent/stop) or wait for it to finish.",
      } as unknown as SseEvent);
      clearInterval(heartbeatInterval);
      res.end();
      return;
    }
    stopController = AgentSessionRegistry.register(conversationId);
  } else {
    stopController = persistOnDisconnect
      ? createAbortController()
      : connectionController;
  }

  res.on("close", () => {
    const durationSeconds = ((Date.now() - connectionStartTime) / 1000).toFixed(
      1,
    );
    logger.warn(
      `[SSE] Connection closed after ${durationSeconds}s — ` +
        `writableFinished=${res.writableFinished}, destroyed=${res.destroyed}, ` +
        `socket.destroyed=${req.socket?.destroyed}, ` +
        `persistOnDisconnect=${persistOnDisconnect}`,
    );
    if (!res.writableFinished) {
      connectionController.abort();

      // Legacy behavior: when NOT persisting, also abort the handler
      if (!persistOnDisconnect && stopController !== connectionController) {
        stopController.abort();
      }
    }
  });

  try {
    await handler(params, createSseEmitter(res, connectionController.signal), {
      signal: stopController.signal,
    });
  } finally {
    clearInterval(heartbeatInterval);
    // Cleanup session registry entry — identity-checked so a stale handler
    // can never delete a newer session's entry.
    if (persistOnDisconnect && conversationId) {
      AgentSessionRegistry.cleanup(conversationId, stopController);
    }
  }

  if (!connectionController.signal.aborted) res.end();
}

/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *
 * Creates an AbortController tied to the client connection so that
 * provider-side inference (e.g. vLLM on a Jetson) is cancelled when
 * the caller disconnects or hits "stop" — preventing orphaned GPU
 * generations from blocking the LocalModelQueue semaphore.
 */
export async function handleJsonRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  params: ChatRequest,
  handler: (
    params: ChatRequest,
    onEvent: (event: SseEvent) => void,
    context: { signal: AbortSignal },
  ) => Promise<void> = handleConversation,
  options: { registerAgentSession?: boolean } = {},
) {
  const connectionStartTime = Date.now();
  const conversationId = (params as Record<string, unknown>).conversationId as
    | string
    | undefined;

  // Agent turns must register in the session registry even on the JSON
  // (?stream=false) path — otherwise POST /agent/stop cannot find them and
  // concurrent turns bypass admission control entirely.
  let controller: AbortController;
  let registeredSession = false;
  if (options.registerAgentSession && conversationId) {
    if (AgentSessionRegistry.isActive(conversationId)) {
      res.status(409).json({
        error: true,
        code: "GENERATION_IN_PROGRESS",
        message:
          "A generation is already running for this conversation. Stop it first (POST /agent/stop) or wait for it to finish.",
      });
      return;
    }
    controller = AgentSessionRegistry.register(conversationId);
    registeredSession = true;
  } else {
    controller = createAbortController();
  }

  res.on("close", () => {
    if (!res.writableFinished) {
      const durationSeconds = (
        (Date.now() - connectionStartTime) /
        1000
      ).toFixed(1);
      logger.warn(
        `[JSON] Client disconnected after ${durationSeconds}s — aborting in-flight generation`,
      );
      controller.abort();
    }
  });

  const events: SseEvent[] = [];
  try {
    await handler(params, (event: SseEvent) => events.push(event), {
      signal: controller.signal,
    });
  } finally {
    if (registeredSession && conversationId) {
      AgentSessionRegistry.cleanup(conversationId, controller);
    }
  }

  if (controller.signal.aborted) return;

  const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}
