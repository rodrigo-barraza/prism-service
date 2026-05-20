import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
import { sleep } from "@rodrigo-barraza/utilities-library";
// ─────────────────────────────────────────────────────────────
// LM Studio provider — Fully native /api/v1/chat
// Uses the native REST API for all streaming, with:
//   - `reasoning` parameter for thinking toggle
//   - `integrations[]` for MCP-based function calling via tools-api
// Non-streaming + captionImage still use OpenAI-compat.
// ─────────────────────────────────────────────────────────────
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { resolveArchParams } from "../utils/gguf-arch.ts";
import {
  TOOLS_SERVICE_URL,
  LM_STUDIO_EVAL_BATCH_SIZE,
  LM_STUDIO_DEFAULT_MAX_CONTEXT,
} from "../../config.ts";
import { TYPES, getDefaultModels } from "../config.ts";
import {} from "../utils/utilities.ts";
// Default MCP server URL for ephemeral tool integrations (vault-resolved)
const DEFAULT_MCP_SERVER_URL = TOOLS_SERVICE_URL;
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  expandVideoToFrames,
  processNonStreamingResponse,
  fetchOpenAICompat,
  parseSSEStream,
  MEDIA_STRATEGIES,
} from "../utils/openai-compat.ts";
import { COORDINATOR_ONLY_TOOLS } from "../services/CoordinatorPrompt.ts";
// ── Native /api/v1/chat SSE stream parser ────────────────────
// The native endpoint emits named SSE events: reasoning.start/delta/end,
// message.start/delta/end, content.start/delta/end, chat.end.
// This generator yields the same event types as parseSSEStream so both
// paths integrate seamlessly with the rest of the pipeline.
async function* parseNativeSSEStream(reader: any, options: ProviderOptions = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  // Accumulate tool call arguments for streaming tool events
  let currentToolCall = null;
  try {
    while (true) {
            if (options.signal?.aborted) {
                (reader as any).cancel();
        break;
      }
            const { done, value } = await (reader as any).read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for ( const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const type = json.type;
          // ── Chat lifecycle events ──
          if (type === "chat.start") {
            yield { type: "status", message: "Starting…", phase: "starting" };
          }
          // ── Reasoning events ──
          else if (type === "reasoning.delta" && json.content) {
            yield { type: "thinking", content: json.content };
          }
          // ── Message content events ──
          else if (
            (type === "content.delta" || type === "message.delta") &&
            json.content
          ) {
            yield json.content;
          }
          // ── Model loading events ──
          else if (type === "model_load.start") {
            yield {
              type: "status",
              message: "Loading model… 0%",
              phase: "loading",
            };
          } else if (type === "model_load.progress") {
            const pct =
              json.progress != null ? Math.round(json.progress * 100) : 0;
            yield {
              type: "status",
              message: `Loading model… ${pct}%`,
              phase: "loading",
            };
          } else if (type === "model_load.end") {
            yield {
              type: "status",
              message: "Loading model… 100%",
              phase: "loading",
            };
          }
          // ── Prompt processing events ──
          else if (type === "prompt_processing.start") {
            yield {
              type: "status",
              message: "Processing prompt…",
              phase: "processing",
              progress: 0,
            };
          } else if (type === "prompt_processing.progress") {
            const progress = json.progress != null ? json.progress : 0;
            const pct = Math.round(progress * 100);
            yield {
              type: "status",
              message: `Processing prompt… ${pct}%`,
              phase: "processing",
              progress,
            };
          } else if (type === "prompt_processing.end") {
            yield {
              type: "status",
              message: "Processing prompt… done",
              phase: "processing",
              progress: 1,
            };
          }
          // ── Generation start ──
          else if (type === "message.start") {
            yield {
              type: "status",
              message: "Generating…",
              phase: "generating",
            };
          }
          // ── Tool call events (MCP) ──
          else if (type === "tool_call.start") {
            currentToolCall = {
              tool: "any",
              arguments: {},
            };
          } else if (type === "tool_call.name") {
            // Separate event with the tool name
            if (currentToolCall) {
              currentToolCall.tool = json.tool_name || "any";
            }
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: json.tool_name || "any",
              args: {},
              status: "calling",
              native: true, // MCP-executed, skip agentic loop re-execution
            };
          } else if (type === "tool_call.arguments") {
            // Arguments arrive as a parsed object, not a streamed string
            if (currentToolCall && json.arguments) {
              currentToolCall.arguments =
                typeof json.arguments === "object"
                  ? json.arguments
                  : safeParseJSON(json.arguments);
            }
            if (currentToolCall && json.tool) {
              currentToolCall.tool = json.tool;
            }
          } else if (type === "tool_call.success") {
            const toolName = json.tool || currentToolCall?.tool || "any";
            const args = json.arguments || currentToolCall?.arguments || {};
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: toolName,
              args: typeof args === "object" ? args : safeParseJSON(args),
              result: json.output ? safeParseJSON(json.output) : json.output,
              status: "done",
              native: true,
            };
            currentToolCall = null;
          } else if (type === "tool_call.failure") {
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: json.tool || currentToolCall?.tool || "any",
              args: currentToolCall?.arguments || {},
              result: { error: json.reason || "Tool call failed" },
              status: "error",
              native: true,
            };
            currentToolCall = null;
          }
          // ── Error event ──
          else if (type === "error") {
            const errMsg = json.error?.message || JSON.stringify(json.error);
            logger.warn(`[LM-Studio] Stream error: ${errMsg}`);
            // Yield as text so the client sees the error
            yield `\n\n⚠️ **LM Studio Error:** ${errMsg}`;
          }
          // ── Chat end with stats ──
          else if (type === "chat.end") {
            const stats = json.result?.stats || json.stats;
            if (stats) {
              usage = {
                inputTokens: stats.input_tokens || 0,
                outputTokens: stats.total_output_tokens || 0,
                // Enrich with LM Studio-specific perf metrics
                tokensPerSec: stats.tokens_per_second || undefined,
                timeToFirstToken:
                  stats.time_to_first_token_seconds || undefined,
                reasoningOutputTokens:
                  stats.reasoning_output_tokens || undefined,
              };
            }
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
  } finally {
    // reader released
  }
}
function safeParseJSON(str: any) {
  try {
        return JSON.parse((str as any));
  } catch {
    return str;
  }
}
// Build the native /api/v1/chat input from OpenAI-style messages.
// The native API only accepts `input` (current turn) + `system_prompt` — it has
// no built-in multi-turn message array. We serialize prior conversation turns
// as formatted text context so the model retains conversational memory.
// For the last user turn with images, we use the array format with type: "text"|"image".
function buildNativeInput(messages: ChatMessage[]) {
  // Separate system, conversation history, and the last user message
  const nonSystemMessages = messages.filter((m: ChatMessage) => m.role !== "system");
  if (nonSystemMessages.length === 0) return "";
  const lastUser = [...nonSystemMessages]
    .reverse()
    .find((m: ChatMessage) => m.role === "user");
  if (!lastUser) return "";
  // Find the index of the last user message to separate history from current turn
  const lastUserIdx = nonSystemMessages.lastIndexOf(lastUser);
  const historyMessages = nonSystemMessages.slice(0, lastUserIdx);
  // Build conversation history prefix (prior turns only)
  let historyPrefix = "";
  if (historyMessages.length > 0) {
    const lines: string[] = [];
        for ( const message of historyMessages) {
      const role = message.role === "user" ? "User" : "Assistant";
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                                .filter((c: any) => c.type === "text")
                                .map((c: any) => c.text)
                .join("\n")
            : "";
      if (text) lines.push(`[${role}]: ${text}`);
    }
    if (lines.length > 0) {
      historyPrefix =
        "[Conversation History]\n" +
        lines.join("\n") +
        "\n\n[Current Message]\n";
    }
  }
  // Check if the last user message has images (multi-part)
  if (Array.isArray(lastUser.content)) {
    const parts: any[] = [];
    // Prepend history as a text part if present
    let textContent = lastUser.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
      .join("\n");
    if (historyPrefix) textContent = historyPrefix + textContent;
    if (textContent) parts.push({ type: "text", content: textContent });
    // Add images
        for ( const c of lastUser.content) {
      if (c.type === "image_url" && c.image_url?.url) {
        parts.push({ type: "image", data_url: c.image_url.url });
      }
    }
    return parts;
  }
  // Simple text-only message → use string input (enables reasoning)
  const currentText =
    typeof lastUser.content === "string" ? lastUser.content : "";
  return historyPrefix ? historyPrefix + currentText : currentText;
}
/**
 * Factory: create an LM Studio provider instance targeting a specific baseUrl.


 */
export function createLmStudioProvider(baseUrl: string, instanceId: string = "lm-studio") {
  const getBaseUrl = () => baseUrl;
  const MCP_SERVER_URL = DEFAULT_MCP_SERVER_URL;
  // ── Per-instance model load mutex (singleflight) ──────────
  // Prevents duplicate model loads when multiple concurrent requests
  // (e.g. worker agents) hit the same instance before the first load finishes.
  // Key: model name → Promise that resolves when the load completes.

  const _loadInflight = new Map();
  return {
    name: instanceId,
    async generateText(
      messages: ChatMessage[],
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["lm-studio"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("LM Studio" as any),
        (`generateText model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
        // Expand video attachments to image frames (ffmpeg) before message prep
                await expandVideoToFrames((messages as any));
                const prepared = prepareOpenAICompatMessages((messages as any), {
          mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
        });
        const payload = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // LM Studio extensions: top_k, min_p, repeat_penalty
          ...(options.topK !== undefined && options.topK > 0 && { top_k: options.topK }),
          ...(options.minP !== undefined && { min_p: options.minP }),
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: false,
        };
        // Function calling tools
                const tools = convertToolsToOpenAI((options.tools as any));
                if (tools) (payload as any).tools = tools;
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = await response.json();
        const { text, thinking, usage, toolCalls } =
                    processNonStreamingResponse((data as any));
        const result = { text, thinking, usage };
                if (toolCalls) (result as any).toolCalls = toolCalls;
        return result;
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    // ── Streaming Text Generation (SSE) ──────────────────────
    async *generateTextStream(
      messages: ChatMessage[],
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["lm-studio"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("LM Studio" as any),
        (`generateTextStream model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
        // Auto-load the model if not currently loaded (with streaming progress)
        try {
                    if (options.signal?.aborted) return;
                    const { models } = await this.listModels();
                    if (options.signal?.aborted) return;
                    const modelEntry = (models || []).find((m: ChatMessage) => (m as any).key === model);
          const isLoaded = modelEntry?.loaded_instances?.length > 0;
          // Capture loaded context for tool cap calculation
          if (isLoaded) {
            const loadedCtx =
              modelEntry.loaded_instances[0]?.config?.context_length;
                        if (loadedCtx) options._loadedContextLength = loadedCtx;
          }
          // If minContextLength is requested (e.g. agentic mode) and model is loaded
          // with insufficient context, force a reload with the required minimum.
          // BUT: skip reload if the model is already at its maximum context — reloading
          // would just load the same max again, creating an infinite unload/reload loop
          // (e.g. minContextLength=150k but model max is 32k → loads at 32k → 32k<150k → reload → 32k → …).
          const modelMaxCtx = modelEntry?.max_context_length || 0;
                    const alreadyAtMax =
                        modelMaxCtx > 0 && (options as any)._loadedContextLength >= modelMaxCtx;
          const needsReload =
            isLoaded &&
                        options.minContextLength &&
                        options._loadedContextLength &&
                        options._loadedContextLength < options.minContextLength &&
            !alreadyAtMax;
                    if (
            alreadyAtMax &&
                        options.minContextLength &&
                        (options as any)._loadedContextLength < options.minContextLength
          ) {
                        logger.info(
                            `[LM-Studio] Model ${model} already at max context (${options._loadedContextLength}/${modelMaxCtx}) — skipping reload (requested ${options.minContextLength})`,
            );
          }
          if (needsReload) {
                        const target = Math.min(
                            (options.minContextLength as any),
                            modelEntry.max_context_length || options.minContextLength,
            );
                        logger.info(
                            `[LM-Studio] Reloading ${model}: loaded ctx ${options._loadedContextLength} < required ${options.minContextLength}, target=${target}`,
            );
            yield {
              type: "status",
              message: `Reloading model with ${(target / 1000).toFixed(0)}k context…`,
            };
            // Unload current instance
                        for ( const inst of modelEntry.loaded_instances || []) {
              await this.unloadModel(inst.id);
            }
            // Fall through to load below
          }
          if (!isLoaded || needsReload) {
            // ── Singleflight: coalesce concurrent loads of the same model ──
            // When multiple workers hit this instance simultaneously (e.g.
            // team_create spawns 3 workers on the same instance), only the
            // first triggers the actual load. Subsequent callers wait for
            // the inflight promise to resolve, then proceed to inference.
            //
            // CRITICAL: The check-and-register is fully synchronous (no
            // awaits between the check and the set). This closes the race
            // window where concurrent workers could all pass the check
            // before any of them registers the inflight.
            if (_loadInflight.has(model) && !needsReload) {
              // ── Another caller is already loading this model — wait ──
              logger.info(
                `[LM-Studio:${instanceId}] Model "${model}" already loading (singleflight) — waiting…`,
              );
              yield {
                type: "status",
                message: "Waiting for model load…",
                phase: "loading",
              };
              try {
                await _loadInflight.get(model);
              } catch {
                // If the original load failed, we'll re-detect below
              }
                            if (options.signal?.aborted) return;
              // Model should now be loaded — capture its context length
              const refreshed = await this.listModels();
                            const entry = ((refreshed as any).models || []).find(
                                (m: ChatMessage) => (m as any).key === model,
              );
              if (entry?.loaded_instances?.length > 0) {
                const context = entry.loaded_instances[0]?.config?.context_length;
                                if (context) options._loadedContextLength = context;
                logger.info(
                  `[LM-Studio:${instanceId}] Singleflight resolved — model "${model}" ready (ctx=${context})`,
                );
                // Skip to inference — model is loaded
              } else {
                logger.warn(
                  `[LM-Studio:${instanceId}] Singleflight resolved but model "${model}" not loaded — will attempt load`,
                );
                // The inflight was cleaned up by the original loader's finally block.
                // Fall through — the next synchronous check will NOT find an inflight,
                // so this worker becomes the new loader.
              }
            }
            // ── Synchronous gate: check + register with NO async gap ──
            // If no inflight exists, register one IMMEDIATELY (synchronous)
            // before doing any async work. This guarantees only one caller
            // enters the load path — all others will see the inflight above.
            if (!_loadInflight.has(model)) {
              // Check if the model was loaded by a previous singleflight or externally
              const recheck = await this.listModels()
                                .then((({ models: ms }: any) =>
                                                                    ((ms || []) as any).find((m: ChatMessage) => (m as any).key === model) as any as (value: any) => any),
                )
                .catch(() => null);
              const isNowLoaded = (recheck as any)?.loaded_instances?.length > 0;
              if (isNowLoaded && !needsReload) {
                // Model is loaded — capture context and skip to inference
                const context =
                  (recheck as any)?.loaded_instances?.[0]?.config?.context_length;
                                if (context) options._loadedContextLength = context;
              } else if (!_loadInflight.has(model)) {
                // ── SYNCHRONOUS registration — no awaits after this point ──
                // Double-check: between our listModels() and here, another
                // worker may have registered. Only register if still clear.
                let resolveInflight: any, rejectInflight: any;
                                const inflightPromise = new Promise((res: any, rej: any) => {
                  resolveInflight = res;
                  rejectInflight = rej;
                });
                inflightPromise.catch(() => {}); // prevent unhandled rejection
                _loadInflight.set(model, inflightPromise);
                try {
                  // Unload any other loaded models first (single-model enforcement)
                  if (!needsReload) {
                                        for ( const m of models || []) {
                                            if (options.signal?.aborted) return;
                                            for ( const inst of m.loaded_instances || []) {
                        yield {
                          type: "status",
                          message: "Unloading previous model…",
                        };
                        logger.info(
                          `Auto-unloading ${inst.id} before loading ${model}`,
                        );
                        await this.unloadModel(inst.id);
                      }
                    }
                  }
                                    if (options.signal?.aborted) return;
                  logger.info(`Auto-loading model ${model} for streaming`);
                  yield {
                    type: "status",
                    message: "Loading model… 0%",
                    phase: "loading",
                  };
                  // Build load options — enforce minContextLength if set
                  // Apply default hardware params for consistent auto-load behavior
                  const loadOpts = {
                    eval_batch_size: LM_STUDIO_EVAL_BATCH_SIZE,
                  };
                                    if (options.minContextLength) {
                    const maxCtx =
                      modelEntry?.max_context_length ||
                      LM_STUDIO_DEFAULT_MAX_CONTEXT;
                                        (loadOpts as any).context_length = Math.min(
                                            (options.minContextLength as any),
                      maxCtx,
                    );
                                        logger.info(
                                            `[LM-Studio] Loading with context_length=${(loadOpts as any).context_length} (min=${options.minContextLength}, max=${maxCtx})`,
                    );
                  }
                  // Start load (non-blocking) and poll for progress
                  let loadDone = false;
                  let loadError = null;
                                    const loadPromise = this.loadModel(
                                        (model as any),
                    loadOpts,
                                        (options.signal as any),
                  )
                    .then(() => {
                      loadDone = true;
                    })
                    .catch((error: any) => {
                      loadDone = true;
                                            if ((error as any).name !== "AbortError") loadError = error;
                    });
                  const startTime = Date.now();
                  const EXPECTED_LOAD_MS = 15_000;
                  let lastPct = 0;
                  while (!loadDone) {
                    await sleep(500);
                                        if (options.signal?.aborted) {
                      logger.info(
                        `[LM-Studio] Aborted during model load for ${model}`,
                      );
                                            this.unloadModelByKey((model as any)).catch((e: any) =>
                        logger.warn(
                          `[LM-Studio] Failed to unload ${model} after abort: ${e.message}`,
                        ),
                      );
                      return;
                    }
                    if (loadDone) break;
                    const elapsed = Date.now() - startTime;
                    const pct = Math.min(
                      95,
                      Math.round(
                        (elapsed / (elapsed + EXPECTED_LOAD_MS)) * 100,
                      ),
                    );
                    if (pct > lastPct) {
                      lastPct = pct;
                      yield {
                        type: "status",
                        message: `Loading model… ${pct}%`,
                        phase: "loading",
                      };
                    }
                  }
                  await loadPromise;
                                    if (options.signal?.aborted) {
                    logger.info(
                      `[LM-Studio] Model ${model} loaded but benchmark aborted — unloading`,
                    );
                                        this.unloadModelByKey((model as any)).catch((e: any) =>
                      logger.warn(
                        `[LM-Studio] Failed to unload ${model} after abort: ${e.message}`,
                      ),
                    );
                    return;
                  }
                  if (loadError) {
                                        rejectInflight(loadError);
                    throw loadError;
                  }
                  yield {
                    type: "status",
                    message: "Loading model… 100%",
                    phase: "loading",
                  };
                  // Re-fetch to get the loaded context length
                  try {
                    const refreshed = await this.listModels();
                                        const entry = ((refreshed as any).models || []).find(
                                            (m: ChatMessage) => (m as any).key === model,
                    );
                    const context =
                      entry?.loaded_instances?.[0]?.config?.context_length;
                                        if (context) options._loadedContextLength = context;
                  } catch {
                    /* ignore */
                  }
                                    resolveInflight();
                } finally {
                  _loadInflight.delete(model);
                }
              } else {
                // Another worker registered between our recheck and here —
                // loop back by recursing into the singleflight wait above.
                // In practice this is extremely rare but handles the edge case.
                logger.info(
                  `[LM-Studio:${instanceId}] Inflight appeared during recheck — waiting…`,
                );
                yield {
                  type: "status",
                  message: "Waiting for model load…",
                  phase: "loading",
                };
                try {
                  await _loadInflight.get(model);
                } catch {
                  /* ignore */
                }
                                if (options.signal?.aborted) return;
                const refreshed = await this.listModels().catch(() => ({
                  models: [],
                }));
                                const entry = ((refreshed as any).models || []).find(
                                    (m: ChatMessage) => (m as any).key === model,
                );
                const context =
                  entry?.loaded_instances?.[0]?.config?.context_length;
                                if (context) options._loadedContextLength = context;
              }
            }
          }
        } catch (loadCheckErr: any) {
          // If model load explicitly failed, re-throw so the generator exits
          // cleanly. runSingleModel will catch it and record an error result,
          // allowing the benchmark to continue to the next model.
          if (
                        ((loadCheckErr as Error)?.cause as any)?.type === "model_load_failed" ||
                        (loadCheckErr as Error).message?.includes("Failed to load") ||
                        (loadCheckErr as Error).message?.includes("API error")
          ) {
            throw loadCheckErr;
          }
          logger.warn(
                        `Could not check/load model before streaming: ${(loadCheckErr as Error).message}`,
          );
        }
                if (options.signal?.aborted) return;
        // Expand video attachments to image frames (ffmpeg) before message prep.
        // This lets the model analyze video content as a sequence of frames,
        // which is the standard approach for Gemma 4 and other VLMs.
                const hasVideo = messages.some((m: ChatMessage) => (m as any).video?.length > 0);
        if (hasVideo) {
          yield { type: "status", message: "Extracting video frames…" };
                    await expandVideoToFrames((messages as any));
        }
                const prepared = prepareOpenAICompatMessages((messages as any), {
          mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
        });
        // ── Determine tool-calling strategy ──────────────────────
        // When called from Prism's agentic loop (options.agent is set),
        // ALWAYS use the OpenAI-compat /v1/chat/completions endpoint.
        // Prism's loop handles multi-turn tool re-prompting with full
        // tool schemas on every turn — critical for smaller models that
        // lose structured FC format across turns. Native MCP delegates
        // the loop to LM Studio, which conflicts with Prism's approval
        // gating, error budgets, and context window management.
        //
        // Coordinator tools (team_create, etc.) are Prism-local and
        // also require this path since they can't route via MCP.
        const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
                const hasCoordinatorTools = options.tools?.some((t: any) =>
                    coordinatorSet.has((t.name as any)),
        );
                if (options.agent || hasCoordinatorTools) {
          // ── OpenAI-compat path (agentic + coordinator) ─────────
                    yield* this._streamOpenAICompat(prepared, (model as any), options, baseUrl);
          return;
        }
        // ── Native /api/v1/chat path (MCP-based tools) ──────────
        // The native API supports reasoning toggle, MCP tool calling,
        // model load events, and structured stats — all in one path.
        const nativePayload = {
          model,
          input: buildNativeInput(prepared),
          stream: true,
          store: false,
        };
        // Extract system prompt from messages
        const systemMsg = prepared.find((m: ChatMessage) => m.role === "system");
        if (systemMsg?.content) {
                    (nativePayload as any).system_prompt = systemMsg.content;
        }
        // Temperature & max tokens from options
        const params = buildPayloadParams(options);
                if (params.temperature != null)
                    (nativePayload as any).temperature = params.temperature;
                if ((params as any).max_tokens > 0)
                    (nativePayload as any).max_output_tokens = params.max_tokens;
        // Extended sampling params for native API
                if (params.seed != null) (nativePayload as any).seed = params.seed;
        if (options.topK !== undefined && options.topK > 0) (nativePayload as any).top_k = options.topK;
        if (options.minP !== undefined) (nativePayload as any).min_p = options.minP;
        if (options.repeatPenalty !== undefined && options.repeatPenalty !== 1)
          (nativePayload as any).repeat_penalty = options.repeatPenalty;
        // Reasoning toggle — may be rejected by models that don't support it.
        // We'll try first, and retry without reasoning if it fails.
        let useReasoning = null;
                if (options.thinkingEnabled === false) {
          useReasoning = "off";
                  } else if (options.thinkingEnabled === true) {
          useReasoning = "on";
        }
        if (useReasoning) {
                    (nativePayload as any).reasoning = useReasoning;
        }
        // ── MCP integrations for function calling ──
        // When tools are requested, attach tools-api as an ephemeral MCP server.
        // LM Studio handles the agentic loop — calls tools, re-prompts, streams.
        // NOTE: Each MCP tool schema averages ~500 tokens. We cap the tool count
        // to prevent context overflow. The model's loaded context determines the cap.
                if (options.tools && options.tools.length > 0) {
                    let toolNames = options.tools.map((t: any) => t.name);
          // Cap tool count based on loaded model context
          // ~500 tokens/tool; reserve 50% of context for conversation
                    const contextLength =
                        options._loadedContextLength || options.contextLength || 8192;
                    const maxTools = Math.max(1, Math.floor((contextLength * 0.5) / 500));
          let skipMcp = false;
          // If context is too small for even 1 tool, skip MCP entirely
                    if (contextLength < 4096) {
            logger.warn(
              `[LM-Studio] Context (${contextLength}) too small for MCP tools. Minimum 4096 recommended. Skipping tools.`,
            );
            yield `⚠️ **Context too small for function calling.** Loaded context is ${contextLength} tokens — each tool requires ~500 tokens. Increase model context to at least **4,096** (8,192+ recommended) to use tools.`;
            skipMcp = true;
          } else if (toolNames.length > maxTools) {
            logger.warn(
              `[LM-Studio] Tool count (${toolNames.length}) exceeds safe limit for ctx=${contextLength}. Capping at ${maxTools}.`,
            );
            toolNames = toolNames.slice(0, maxTools);
                        yield {
              type: "status",
                            message: `Context limit (${contextLength}) — using ${maxTools} of ${options.tools.length} tools`,
            };
          }
          if (!skipMcp) {
                        (nativePayload as any).integrations = [
              {
                type: "ephemeral_mcp",
                server_label: "tools",
                                server_url: `${MCP_SERVER_URL}/mcp/sse?project=${encodeURIComponent((options.project || "default" as any | number | boolean))}&agent=${encodeURIComponent((options.agent || "CODING" as any | number | boolean))}${options.username ? `&username=${encodeURIComponent((options.username as any | number | boolean))}` : ""}`,
                allowed_tools: toolNames,
              },
            ];
            logger.info(
              `[LM-Studio] MCP integration: ${toolNames.length} tools via ${MCP_SERVER_URL}/mcp/sse`,
            );
          }
        }
        // ── Send request (with reasoning fallback) ──
        // Some models (e.g. DeepSeek R1 Distill) don't expose reasoning config.
        // If the request fails with a reasoning-related error, retry without it.
        const makeRequest = async (payload: any) => {
          const payloadStr = JSON.stringify(payload, null, 2);
          const inputShape = Array.isArray(payload.input)
            ? `array[${payload.input.length}]: ${payload.input.map((p: any) => p.type).join(", ")}`
                        : `string[${((payload.input || "") as any).length}]`;
          logger.info(
            `[LM-Studio] Native API: reasoning=${payload.reasoning || "default"}, tools=${payload.integrations ? "mcp" : "none"}, input=${inputShape}, ${payloadStr.length} chars`,
          );
          const response = await fetch(`${baseUrl}/api/v1/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
                        ...(options.signal && { signal: options.signal }),
          });
          return response;
        };
        let nativeResponse = await makeRequest(nativePayload);
        // If reasoning param was rejected, retry without it
        if (!nativeResponse.ok && useReasoning) {
          const errorText = await nativeResponse.text();
          if (
            nativeResponse.status === 400 &&
            (errorText.includes("reasoning") ||
              errorText.includes("does not expose"))
          ) {
            logger.warn(
              `[LM-Studio] Model ${model} does not support reasoning config, retrying without it`,
            );
                        delete (nativePayload as any).reasoning;
            nativeResponse = await makeRequest(nativePayload);
          } else {
            throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
          }
        }
        if (!nativeResponse.ok) {
          const errorText = await nativeResponse.text();
          throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
        }
        if (!nativeResponse.body) throw new Error("No response body");
        const nativeReader = nativeResponse.body.getReader();
        yield* parseNativeSSEStream((nativeReader as any), { signal: options.signal });
      } catch (error: any) {
                if ((error as Error).name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    /**
     * OpenAI-compat streaming path — used when coordinator tools are enabled.
     * Sends a standard /v1/chat/completions request with `tools` array.
     * Tool calls yield as non-native events, so Prism's agentic loop
     * executes them (including team_create, send_message, stop_agent).
     *
     * @private
     */
    async *_streamOpenAICompat(
      prepared: any,
      model: any,
      options: ProviderOptions,
      baseUrl: string,
    ) {
      const payload = {
        messages: prepared,
        model,
        ...buildPayloadParams(options),
        ...(options.topK !== undefined && options.topK > 0 && { top_k: options.topK }),
        ...(options.minP !== undefined && { min_p: options.minP }),
        ...(options.repeatPenalty !== undefined &&
          options.repeatPenalty !== 1 && {
            repeat_penalty: options.repeatPenalty,
          }),
        stream: true,
        // Request usage in the final streamed chunk
        stream_options: { include_usage: true },
      };
      // Convert tool schemas to OpenAI format
            const tools = convertToolsToOpenAI((options.tools as any));
      if (tools) {
        // ── Cap tool count based on loaded model context ──────────
        // Each tool schema averages ~500 tokens. Reserve 50% of context
        // for the conversation. Without this cap, 65+ tool schemas
        // overflow the context and LM Studio returns empty responses.
        const contextLength =
          options._loadedContextLength || options.contextLength || 8192;
                const maxTools = Math.max(1, Math.floor((contextLength * 0.5) / 500));
        if (tools.length > maxTools) {
          logger.warn(
            `[LM-Studio] OpenAI-compat: tool count (${tools.length}) exceeds safe limit for ctx=${contextLength}. Capping at ${maxTools}.`,
          );
                    (payload as any).tools = tools.slice(0, maxTools);
        } else {
                    (payload as any).tools = tools;
        }
      }
      logger.info(
                `[LM-Studio] OpenAI-compat streaming (agentic): model=${model}, tools=${(payload as any).tools?.length || 0}/${options.tools?.length || 0}, ctx=${options._loadedContextLength || "unset"}`,
      );
      yield { type: "status", message: "Starting…", phase: "starting" };
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(options.signal && { signal: options.signal }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          "lm-studio",
          `API error: ${response.status} ${errorText}`,
          response.status,
        );
      }
      yield {
        type: "status",
        message: "Processing prompt…",
        phase: "processing",
        progress: 0,
      };
      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      let emittedPhaseTransition = false;
            for await ( const chunk of parseSSEStream((reader as any), {
        signal: options.signal,
        thinkingEnabled: options.thinkingEnabled,
      })) {
        // Emit the correct phase based on the first chunk type —
        // avoids a false "generating" → "thinking" flicker when the
        // model starts with reasoning tokens.
        if (!emittedPhaseTransition) {
          emittedPhaseTransition = true;
          const isThinking =
            chunk && typeof chunk === "object" && chunk.type === "thinking";
          yield {
            type: "status",
            message: isThinking ? "Thinking…" : "Generating…",
            phase: isThinking ? "thinking" : "generating",
          };
        }
        yield chunk;
      }
    },
    // ── Embedding Generation ─────────────────────────────────
    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * LM Studio exposes this for any loaded embedding model (e.g. Granite,
     * nomic-embed, etc.).
     */
    async generateEmbedding(content: any, model: any, options: ProviderOptions = {}) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("LM Studio" as any),
        (`generateEmbedding model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
        const payload = { model, input: content };
                if (options.dimensions) (payload as any).dimensions = options.dimensions;
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/embeddings`,
          payload,
        );
        const data = await response.json();
                const embedding = (data as any).data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("No embedding data in LM Studio response");
        }
        return { embedding, dimensions: embedding.length };
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
            model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["lm-studio"],
      systemPrompt?: string,
    ) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("LM Studio" as any),
        (`captionImage model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
        const content = [
          { type: "text", text: prompt },
          ...images.map((image: string) => ({
            type: "image_url",
            image_url: { url: image },
          })),
        ];
        const messages: ChatMessage[] = [];
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content });
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          {
            messages,
            model,
            temperature: 0.7,
            max_tokens: -1,
            stream: false,
          },
        );
        const data = await response.json();
                const text = (data as any).choices?.[0]?.message?.content || "";
        const usage = {
                    inputTokens: (data as any).usage?.prompt_tokens || 0,
                    outputTokens: (data as any).usage?.completion_tokens || 0,
        };
        return { text, usage };
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    // ── Model Management ─────────────────────────────────────
    /**
     * Ensure exactly one model is loaded in LM Studio.
     * - If the requested model is already loaded, returns immediately with its context info.
     * - If a different model is loaded, unloads it first.
     * - If no model is loaded, loads the requested one.
     */
    async ensureModelLoaded(
      modelKey: any,
      loadOptions: any = {},
      signal: any,
      onStatus: any,
    ) {
      if (signal?.aborted) return { alreadyLoaded: false, contextLength: null };
            const { models } = await this.listModels();
      if (signal?.aborted) return { alreadyLoaded: false, contextLength: null };
      // Check if the requested model is already loaded
            const modelEntry = (models || []).find((m: ChatMessage) => (m as any).key === modelKey);
      const isLoaded = modelEntry?.loaded_instances?.length > 0;
      if (isLoaded) {
        const loadedCtx =
          modelEntry.loaded_instances[0]?.config?.context_length || null;
        logger.info(
          `[LM-Studio] Model ${modelKey} already loaded (ctx=${loadedCtx})`,
        );
        return { alreadyLoaded: true, contextLength: loadedCtx };
      }
      // Unload any other loaded models first (single-model enforcement)
            for ( const m of models || []) {
        if (signal?.aborted)
          return { alreadyLoaded: false, contextLength: null };
                for ( const inst of m.loaded_instances || []) {
                    onStatus?.("Unloading previous model…");
          logger.info(
            `[LM-Studio] Auto-unloading ${inst.id} before loading ${modelKey}`,
          );
          await this.unloadModel(inst.id);
        }
      }
      if (signal?.aborted) return { alreadyLoaded: false, contextLength: null };
      // Load the requested model
      logger.info(`[LM-Studio] Loading model ${modelKey}`);
            onStatus?.("Loading model… 0%");
      await this.loadModel(modelKey, loadOptions, signal);
            onStatus?.("Loading model… 100%");
      // Re-fetch to get the loaded context length
      try {
        const refreshed = await this.listModels();
                const entry = ((refreshed as any).models || []).find(
                    (m: ChatMessage) => (m as any).key === modelKey,
        );
        const context =
          entry?.loaded_instances?.[0]?.config?.context_length || null;
        return { alreadyLoaded: false, contextLength: context };
      } catch {
        return { alreadyLoaded: false, contextLength: null };
      }
    },
    /**
     * List all models available in LM Studio.
     * Uses the proprietary GET /api/v1/models endpoint.
     */
    async listModels(): Promise<any> {
      const baseUrl = getBaseUrl();
            (logger.provider as any)(("LM Studio" as any), ("listModels" as any));
      try {
        const response = await fetch(`${baseUrl}/api/v1/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        const data = await response.json();
        // Enrich each model with resolved architecture params for VRAM estimation
                if ((data as any)?.data) {
                    for ( const model of (data as any).data) {
            const arch = model.architecture;
            const params = model.params_string;
            const sizeBytes = model.size_bytes || 0;
            const bpw = model.quantization?.bits_per_weight || 4;
            model.archParams = resolveArchParams(arch, params, sizeBytes, bpw);
          }
        }
        return data;
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    /**
     * Load a model into LM Studio memory.
     */
    async loadModel(model: any, options: ProviderOptions = {}, signal: any) {
      const baseUrl = getBaseUrl();
            (logger.provider as any)(("LM Studio" as any), (`loadModel model=${model}` as any));
      try {
        const payload = { model, echo_load_config: true };
                if (options.context_length != null)
                    (payload as any).context_length = options.context_length;
                if (options.flash_attention != null)
                    (payload as any).flash_attention = options.flash_attention;
                if (options.offload_kv_cache_to_gpu != null)
                    (payload as any).offload_kv_cache_to_gpu = options.offload_kv_cache_to_gpu;
                if (options.eval_batch_size != null)
                    (payload as any).eval_batch_size = options.eval_batch_size;
                const response = await fetch(`${baseUrl}/api/v1/models/load`, ({
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(payload),
                          ...(signal && { signal }),
                        } as any as RequestInit));
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        return response.json();
      } catch (error: any) {
                if ((error as Error).name === "AbortError") throw error; // Let AbortError propagate
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
    /**
     * Unload a model from LM Studio by its model key.
     * Looks up the loaded instance ID and unloads it.
     */
    async unloadModelByKey(modelKey: any) {
      try {
                const { models } = await this.listModels();
                for ( const m of models || []) {
          if (m.key !== modelKey) continue;
                    for ( const inst of m.loaded_instances || []) {
            logger.info(
              `[LM-Studio] Unloading ${inst.id} (cleanup after abort)`,
            );
            await this.unloadModel(inst.id);
          }
        }
      } catch (error: any) {
        logger.warn(
                    `[LM-Studio] unloadModelByKey(${modelKey}) failed: ${(error as Error).message}`,
        );
      }
    },
    /**
     * Unload a model from LM Studio memory.
     */
    async unloadModel(instanceId: string) {
      const baseUrl = getBaseUrl();
            (logger.provider as any)(("LM Studio" as any), (`unloadModel instanceId=${instanceId}` as any));
      try {
        const response = await fetch(`${baseUrl}/api/v1/models/unload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instance_id: instanceId }),
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        return response.json();
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("lm-studio", (error as Error).message, 500, error);
      }
    },
  };
}
