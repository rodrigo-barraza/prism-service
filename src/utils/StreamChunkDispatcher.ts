// ─────────────────────────────────────────────────────────────
// StreamChunkDispatcher — Shared stream chunk processing
// ─────────────────────────────────────────────────────────────
// Centralises the chunk-type dispatching logic used by
// handleStreamingText (chat.js) and AgenticLoopService.
// ─────────────────────────────────────────────────────────────

import FileService from "../services/FileService.ts";
import logger from "./logger.ts";

/**
 * Strip XML tool call markup that some local models (e.g. Gemma 4) leak into
 * text output. Applied server-side so SSE chunk events arrive clean.
 *
 * Handles both completed tags (matched pairs) and incomplete tags at the
 * end of a streaming buffer (closing tag hasn't arrived yet).
 */
export function stripToolCallMarkup(text: any) {
  return (
        (text as any)
      // Completed tag pairs
      .replace(/<\|?tool_call\|?>[\s\S]*?<\/?\|?tool_call\|?>/gi, "")
      .replace(/<\|?tool_response\|?>[\s\S]*?<\/?\|?tool_response\|?>/gi, "")
      .replace(/<\|?result\|?>[\s\S]*?<\/?\|?result\|?>/gi, "")
      .replace(/\[END_TOOL_REQUEST\]/gi, "")
      // Incomplete tags at end of stream (closing tag hasn't arrived yet)
      .replace(/<\|?tool_call\|?>[\s\S]*$/gi, "")
      .replace(/<\|?tool_response\|?>[\s\S]*$/gi, "")
      .replace(/<\|?result\|?>[\s\S]*$/gi, "")
  );
}

/**
 * Process a provider image chunk: upload to MinIO and track the ref.
 */
export async function uploadImageChunk(
  chunk: any,
  project: any,
  username: string,
    logPrefix: any = "stream",
) {
  if (!chunk.data) return null;
  try {
    const mimeType = chunk.mimeType || "image/png";
    const dataUrl = `data:${mimeType};base64,${chunk.data}`;
    const { ref } = await (FileService as any).uploadFile(
      dataUrl,
      "generations",
            (project as any),
      username,
    );
    return ref;
  } catch (error: any) {
        logger.error(`[${logPrefix}] MinIO upload failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Create an image ref string, preferring MinIO ref over inline base64.
 */
export function imageRefOrInline(
  minioRef: any,
  data: any,
    mimeType: any = "image/png",
) {
  return minioRef || `data:${mimeType};base64,${data}`;
}

/**
 * Dispatch a single typed chunk to an accumulator state object and emit function.
 *
 * This is the single source of truth for the chunk type → handler mapping that was
 * previously duplicated across chat.js (handleStreamingText) and AgenticLoopService.
 */
export async function dispatchChunk(
  chunk: any,
  state: any,
  context: any,
  options: any = {},
) {
  const { emit, project, username } = context;
    const logPrefix = options.logPrefix || "stream";

  // Non-object chunks are treated as text (raw string from provider)
  if (!chunk || typeof chunk !== "object") {
    if (!state.firstTokenTime) {
      state.firstTokenTime = performance.now();
      if (state.requestStart) {
                (emit as any)({
          type: "status",
          message: "generation_started",
                    timeToFirstToken: ((state as any).firstTokenTime - state.requestStart) / 1000,
        });
      }
    }
    state.generationEnd = performance.now();
    const rawStr = typeof chunk === "string" ? chunk : "";
    state.text += rawStr;
    // Strip tool call XML markup leaked by some local models (Gemma 4)
        const cleanText = stripToolCallMarkup((state.text as any));
    const chunkStr = cleanText.slice(state.outputCharacters);
    state.outputCharacters = cleanText.length;
    if (chunkStr)
            (emit as any)({
        type: "chunk",
        content: chunkStr,
        outputCharacters: state.outputCharacters,
      });
    return true;
  }

  switch (chunk.type) {
    case "usage":
            if (options.onUsage) {
                options.onUsage(chunk.usage);
      } else {
        state.usage = chunk.usage;
      }
      return true;

    case "rateLimits":
      state.rateLimits = chunk.rateLimits;
      return true;

    case "thinking":
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
                    (emit as any)({
            type: "status",
            message: "generation_started",
            timeToFirstToken:
                            ((state as any).firstTokenTime - state.requestStart) / 1000,
          });
        }
      }
      state.generationEnd = performance.now();
            (state as any).thinking += (chunk as any).content;
            (state as any).outputCharacters += ((chunk.content || "") as any).length;
            (emit as any)({
        type: "thinking",
        content: chunk.content,
        outputCharacters: state.outputCharacters,
      });
      return true;

    case "thinking_signature":
      state.thinkingSignature = chunk.signature;
      return true;

    case "image": {
      const minioRef = await uploadImageChunk(
        chunk,
                (project as any),
        (username as any),
        (logPrefix as any),
      );
      if (chunk.data) {
                (state as any).images.push(
                    imageRefOrInline((minioRef as any), (chunk.data as any), (chunk.mimeType as any | undefined)),
        );
      }
            (emit as any)({
        type: "image",
        data: chunk.data,
        mimeType: chunk.mimeType,
        minioRef,
      });
      return true;
    }

    case "executableCode":
            (emit as any)({
        type: "executableCode",
        code: chunk.code,
        language: chunk.language,
      });
      return true;

    case "codeExecutionResult":
            (emit as any)({
        type: "codeExecutionResult",
        output: chunk.output,
        outcome: chunk.outcome,
      });
      return true;

    case "webSearchResult":
            (emit as any)({ type: "webSearchResult", results: chunk.results });
      return true;

    case "audio":
            (emit as any)({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
            if (chunk.data) (state as any).audioChunks.push(chunk.data);
      if (chunk.mimeType) {
                const rateMatch = (chunk.mimeType as any).match(/rate=(\d+)/);
        if (rateMatch) state.audioSampleRate = parseInt(rateMatch[1], 10);
      }
      return true;

    case "toolCall":
      // Tool call chunks indicate model output — track generation timing
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
                    (emit as any)({
            type: "status",
            message: "generation_started",
            timeToFirstToken:
                            ((state as any).firstTokenTime - state.requestStart) / 1000,
          });
        }
      }
      state.generationEnd = performance.now();

      if (chunk.status === "done" || chunk.status === "error") {
                const existing = (state as any).toolCalls.find(
          (tc: any) =>
            (chunk.id && tc.id === chunk.id) ||
            (!chunk.id && tc.name === chunk.name && !tc.result),
        );
        if (existing) {
          existing.result = chunk.result || undefined;
          existing.status = chunk.status;
          if (chunk.args && Object.keys(chunk.args).length > 0) {
            existing.args = chunk.args;
          }
        }
      } else {
                (state as any).toolCalls.push({
          id: chunk.id || null,
          name: chunk.name,
          args: chunk.args || {},
          result: chunk.result || undefined,
          status: chunk.status || undefined,
          thoughtSignature: chunk.thoughtSignature || undefined,
        });
      }
            (emit as any)({
        type: "toolCall",
        id: chunk.id || null,
        name: chunk.name,
        args: chunk.args || {},
        result: chunk.result || undefined,
        status: chunk.status || undefined,
        thoughtSignature: chunk.thoughtSignature || undefined,
      });
      return true;

    case "toolCallDelta":
      // Incremental tool call argument streaming — track generation timing
      // so the throughput badge stays alive, but don't emit to the client.
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
                    (emit as any)({
            type: "status",
            message: "generation_started",
            timeToFirstToken:
                            ((state as any).firstTokenTime - state.requestStart) / 1000,
          });
        }
      }
      state.generationEnd = performance.now();
            (state as any).outputCharacters += Math.ceil((chunk.characters || 0) / 4);
      return true;

    case "status":
            (emit as any)({
        type: "status",
        message: chunk.message,
        phase: chunk.phase,
        ...(chunk.progress != null && { progress: chunk.progress }),
      });
      return true;

    default: {
      // Unknown typed chunk — treat as text
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
                    (emit as any)({
            type: "status",
            message: "generation_started",
            timeToFirstToken:
                            ((state as any).firstTokenTime - state.requestStart) / 1000,
          });
        }
      }
      state.generationEnd = performance.now();
      const rawStr = typeof chunk === "string" ? chunk : "";
      state.text += rawStr;
      // Strip tool call XML markup leaked by some local models (Gemma 4)
            const cleanText = stripToolCallMarkup((state.text as any));
      const chunkStr = cleanText.slice(state.outputCharacters);
      state.outputCharacters = cleanText.length;
      if (chunkStr)
                (emit as any)({
          type: "chunk",
          content: chunkStr,
          outputCharacters: state.outputCharacters,
        });
      return true;
    }
  }
}

/**
 * Create a fresh state accumulator for stream chunk dispatching.

 */
export function createStreamState() {
  return {
    usage: null,
    firstTokenTime: null,
    generationEnd: null,
    requestStart: null, // Set by caller to enable server-computed TTFT
    outputCharacters: 0,
    text: "",
    thinking: "",
    thinkingSignature: "",
    images: [],
    toolCalls: [],
    audioChunks: [],
    audioSampleRate: 24000,
    rateLimits: null,
  };
}
