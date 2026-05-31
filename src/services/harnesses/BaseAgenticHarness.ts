import { expandMessagesForFC } from "../../utils/FunctionCallingUtilities.ts";
import {
  mergeUsage,
  createUsageAccumulator,
  calculateTextCost,
} from "../../utils/CostCalculator.ts";
import { calculateTokensPerSec } from "../../utils/math.ts";
import { getPricing, TYPES } from "../../config.ts";
import { stripToolCallMarkup } from "../../utils/StreamChunkDispatcher.ts";
import ContextWindowManager from "../../utils/ContextWindowManager.ts";
import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import RequestLogger, { TokenUsage, MessagePayload, ToolCallPayload } from "../RequestLogger.ts";
import FileService from "../FileService.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import { COLLECTIONS } from "../../constants.ts";
import { finalizeTextGeneration, type FinalizerContext } from "./lifecycle/Finalizer.ts";
import logger from "../../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "../AgenticLoopState.ts";
import type AgentHooks from "../AgentHooks.ts";
import type {
  AgenticContext,
  ResolvedTools,
  PassState,
  ChunkAction,
  ConversationMessage,
  StreamChunk,
  ToolCall,
} from "./types.ts";

/**
 * BaseAgenticHarness — abstract base class that defines the contract
 * for agentic loop execution strategies ("harnesses").
 *
 * Subclasses implement `run()` with their specific control flow
 * (standard tool loop, ReAct, plan-then-execute, etc.) while
 * inheriting shared infrastructure:
 *
 *   - Stream chunk routing (`processStreamChunk`)
 *   - Stream consumption (`consumeStream` — full pass with chunk routing)
 *   - Progress emission (`emitGenerationProgress`, `maybeEmitProgress`)
 *   - Iteration logging (`logIteration`)
 *   - Context window enforcement (`enforceContextWindow`)
 *   - LLM stream creation (`createProviderStream`)
 *   - Finalization (`finalize` — cost, persistence, done event)
 */
export default class BaseAgenticHarness {
  /** Harness identifier — subclasses MUST override. */
  static id = "base";
  static label = "Base (abstract)";
  static description = "Abstract base harness — do not use directly.";

  protected ctx: AgenticContext;
  protected state: AgenticLoopState;
  protected tools: ResolvedTools;
  protected trackerSessionId: string;

  constructor(
    context: AgenticContext,
    state: AgenticLoopState,
    tools: ResolvedTools,
  ) {
    this.ctx = context;
    this.state = state;
    this.tools = tools;
    this.trackerSessionId =
      context.parentAgentSessionId || context.agentSessionId;
  }

  /** Execute the agentic loop. Subclasses MUST override. */
  async run(): Promise<{ messages: ConversationMessage[] }> {
    throw new Error(
      `${this.constructor.name}.run() is abstract — subclasses must override.`,
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SHARED INFRASTRUCTURE — used by all harness subclasses
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── Progress emission ────────────────────────────────────

  /** Emit a generation_progress status event with current session stats. */
  emitGenerationProgress(): void {
    const { emit } = this.ctx;
    const state = this.state;
    const stats = SessionGenerationTracker.getSessionStats(
      this.trackerSessionId,
    );
    if (stats.activeRequests > 0 || stats.totalOutputTokens > 0) {
      state.hwmOutputTokens = Math.max(
        state.hwmOutputTokens,
        stats.totalOutputTokens,
      );
      state.hwmInputTokens = Math.max(
        state.hwmInputTokens,
        stats.totalInputTokens,
      );
      state.hwmTotalTokens = Math.max(state.hwmTotalTokens, stats.totalTokens);
      state.hwmOutputCharacters = Math.max(
        state.hwmOutputCharacters,
        state.overallOutputCharacters,
      );
      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_PROGRESS,
        tokPerSec: stats.tokPerSec,
        activeRequests: stats.activeRequests,
        outputTokens: state.hwmOutputTokens,
        inputTokens: state.hwmInputTokens,
        totalTokens: state.hwmTotalTokens,
        outputCharacters: state.hwmOutputCharacters,
        avgTtft: stats.avgTtft,
      });
    }
    state.lastProgressEmitTime = performance.now();
    state.chunksSinceLastProgress = 0;
  }

  /** Check if it's time to emit a progress event. */
  maybeEmitProgress(): void {
    const state = this.state;
    state.chunksSinceLastProgress++;
    const timeSinceLast = performance.now() - state.lastProgressEmitTime;
    if (
      state.chunksSinceLastProgress >= state.PROGRESS_CHUNK_INTERVAL ||
      timeSinceLast >= state.PROGRESS_TIME_INTERVAL_MS
    ) {
      this.emitGenerationProgress();
    }
  }

  // ── Context window enforcement ───────────────────────────

  /** Enforce token budget on messages before sending to provider. */
  enforceContextWindow(
    messages: ConversationMessage[],
    toolCount: number,
  ): ConversationMessage[] {
    const { modelDef, options, emit } = this.ctx;
    const preEnforceCount = messages.length;
    const contextResult = ContextWindowManager.enforce(messages as Parameters<typeof ContextWindowManager.enforce>[0], {
      maxInputTokens: modelDef?.maxInputTokens || 128_000,
      maxOutputTokens: options.maxTokens || 8192,
      toolCount,
    });
    if (contextResult.truncated) {
      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.CONTEXT_TRUNCATED,
        strategy: contextResult.strategy,
        estimatedTokens: contextResult.estimatedTokens,
      });
      // Recalculate originalMessageCount so finalize() slices correctly
      // against the post-truncation array, not the pre-truncation one.
      // Without this, the slice index points to the wrong position and
      // captures synthetic [CONTEXT NOTE] markers for DB persistence.
      const droppedCount = preEnforceCount - contextResult.messages.length;
      if (droppedCount > 0) {
        this.state.originalMessageCount = Math.max(
          0,
          this.state.originalMessageCount - droppedCount,
        );
      }
      return contextResult.messages as ConversationMessage[];
    }
    return messages;
  }

  // ── Provider stream creation ──────────────────────────────

  /**
   * Create an LLM text stream from the provider.
   * Handles liveAPI fallback and message expansion.
   */
  createProviderStream(
    messages: ConversationMessage[],
    passOptions: Record<string, unknown>,
  ): AsyncIterable<unknown> {
    const { provider, resolvedModel, modelDef, signal } = this.ctx;
    const expandedMessages = expandMessagesForFC(messages as Parameters<typeof expandMessagesForFC>[0], {
      filterDeleted: false,
    });
    return modelDef?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
          ...passOptions,
          signal,
        })
      : provider.generateTextStream(expandedMessages, resolvedModel, {
          ...passOptions,
          signal,
        });
  }

  // ── Stream consumption ────────────────────────────────────

  /**
   * Consume an LLM stream, routing each chunk through `processStreamChunk`.
   * Handles abort signals and stream teardown.
   */
  public async consumeStream(
    stream: AsyncIterable<unknown>,
    pass: PassState,
    allowedToolNames: Set<string>,
  ): Promise<void> {
    for await (const chunk of stream) {
      const result = await this.processStreamChunk(chunk, pass, allowedToolNames);
      if (result.action === "break") {
        const returnable = stream as AsyncGenerator<unknown>;
        if (typeof returnable.return === "function") returnable.return(undefined);
        break;
      }
    }
  }

  // ── Session tracking helpers ──────────────────────────────

  /** Register a request with SessionGenerationTracker. */
  registerTrackerRequest(passRequestId: string): void {
    const { providerName, resolvedModel, parentAgentSessionId, agentSessionId } =
      this.ctx;
    SessionGenerationTracker.register(this.trackerSessionId, passRequestId, {
      provider: providerName,
      model: resolvedModel,
      source: parentAgentSessionId ? "worker" : "orchestrator",
      workerId: parentAgentSessionId ? agentSessionId : null,
    });
  }

  // ── Stream chunk processing ───────────────────────────────

  /**
   * Process a single stream chunk — routes to the appropriate handler.
   * Returns an action descriptor for the caller:
   *   `continue` — chunk was consumed, keep iterating
   *   `toolCall` — a tool call was detected
   *   `skip`     — chunk was filtered/dropped
   *   `break`    — abort signal received
   */
  processStreamChunk(
    chunk: unknown,
    pass: PassState,
    allowedToolNames: Set<string>,
  ): ChunkAction | Promise<ChunkAction> {
    const { emit, signal } = this.ctx;
    const state = this.state;
    // Cast to a loose typed object — we branch on `type` below
    const streamChunk = chunk as StreamChunk;

    // Abort check
    if (signal?.aborted) return { action: "break" };

    // ── Usage event ──────────────────────────────────────
    if (streamChunk?.type === "usage") {
      mergeUsage(state.overallUsage, streamChunk.usage as Parameters<typeof mergeUsage>[1]);
      mergeUsage(pass.usage, streamChunk.usage as Parameters<typeof mergeUsage>[1]);
      const usageObj = streamChunk.usage as Record<string, number> | undefined;
      const reportedInput =
        usageObj?.inputTokens || usageObj?.promptTokens || 0;
      if (reportedInput > 0 && pass.requestId) {
        SessionGenerationTracker.update(pass.requestId, {
          inputTokens: reportedInput,
        });
      }
      return { action: "continue" };
    }

    // ── Rate limits ──────────────────────────────────────
    if (streamChunk?.type === "rateLimits") {
      state.lastRateLimits = streamChunk.rateLimits || null;
      return { action: "continue" };
    }

    // ── Thinking ─────────────────────────────────────────
    if (streamChunk?.type === "thinking") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      state.streamedThinking += streamChunk.content || "";
      pass.streamedThinking += streamChunk.content || "";
      // Display segment tracking
      if (state.lastDisplaySegType !== "thinking") {
        state.displaySegments.push({
          type: SSE_EVENT_TYPES.THINKING,
          fragmentIndex: state.displayThinkingFragments.length,
        });
        state.displayThinkingFragments.push("");
        state.lastDisplaySegType = "thinking";
      }
      state.displayThinkingFragments[
        state.displayThinkingFragments.length - 1
      ] += streamChunk.content || "";
      state.overallOutputCharacters += (streamChunk.content || "").length;
      if (pass.requestId) {
        SessionGenerationTracker.recordChunkTiming(
          pass.requestId,
          (streamChunk.content || "").length,
        );
      }
      emit({
        type: SSE_EVENT_TYPES.THINKING,
        content: streamChunk.content || "",
        outputCharacters: state.overallOutputCharacters,
      });
      this.maybeEmitProgress();
      return { action: "continue" };
    }

    // ── Thinking signature (Anthropic) ───────────────────
    if (streamChunk?.type === "thinking_signature") {
      pass.thinkingSignature = streamChunk.signature || "";
      return { action: "continue" };
    }

    // ── Tool call argument delta ─────────────────────────
    if (streamChunk?.type === "toolCallDelta") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      state.overallOutputCharacters += streamChunk.characters as number;
      if (pass.requestId) {
        SessionGenerationTracker.recordChunkTiming(
          pass.requestId,
          streamChunk.characters as number,
        );
      }
      this.maybeEmitProgress();
      return { action: "continue" };
    }

    // ── Tool call ────────────────────────────────────────
    if (streamChunk?.type === "toolCall") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      if (pass.requestId) {
        SessionGenerationTracker.recordChunkTiming(
          pass.requestId,
          JSON.stringify(streamChunk.args || {}).length,
        );
      }
      this.maybeEmitProgress();

      // Native MCP tool calls: pass through directly
      if (streamChunk.native) {
        if (streamChunk.status === "calling") {
          const tcId = streamChunk.id || `ntc-${state.streamedToolCalls.length}`;
          state.streamedToolCalls.push({
            id: tcId,
            name: streamChunk.name || "",
            args: streamChunk.args || {},
          });
          this._trackToolDisplaySegment(tcId);
        } else if (streamChunk.status === "done" || streamChunk.status === "error") {
          const existing = state.streamedToolCalls.find(
            (tc) =>
              (streamChunk.id && tc.id === streamChunk.id) ||
              (!streamChunk.id && tc.name === streamChunk.name),
          );
          if (existing) {
            existing.result = streamChunk.result;
            existing.status = streamChunk.status;
            if (streamChunk.args && Object.keys(streamChunk.args).length > 0)
              existing.args = streamChunk.args;
          }
        }
        emit({
          type: SSE_EVENT_TYPES.TOOL_CALL,
          id: streamChunk.id || null,
          name: streamChunk.name,
          args: streamChunk.args || {},
          result: streamChunk.result || undefined,
          status: streamChunk.status || "calling",
        });
        return { action: "continue" };
      }

      // Schema enforcement
      const toolName = streamChunk.name || "";
      if (!allowedToolNames.has(toolName)) {
        logger.warn(
          `[AgenticLoop] Dropped tool call "${toolName}" — not in schema: [${[...allowedToolNames].join(", ")}]`,
        );
        return { action: "skip" };
      }

      const stdTcId = streamChunk.id || `tc-${state.streamedToolCalls.length}`;
      const toolCall: ToolCall = {
        id: stdTcId,
        responsesItemId: streamChunk.responsesItemId || undefined,
        name: toolName,
        args: streamChunk.args || {},
        thoughtSignature: streamChunk.thoughtSignature || undefined,
        reasoningItem: streamChunk.reasoningItem || undefined,
      };
      pass.pendingToolCalls.push(toolCall);
      state.streamedToolCalls.push({ ...toolCall });
      this._trackToolDisplaySegment(stdTcId);
      emit({
        type: SSE_EVENT_TYPES.TOOL_EXECUTION,
        tool: { name: toolName, args: streamChunk.args || {}, id: stdTcId },
        status: "calling",
      });
      return { action: "toolCall", tc: toolCall };
    }

    // ── Image ────────────────────────────────────────────
    if (streamChunk?.type === "image") {
      return this._handleImageChunk(streamChunk, pass);
    }

    // ── Pass-through events ──────────────────────────────
    if (streamChunk?.type === "executableCode") {
      emit({
        type: "executableCode",
        code: streamChunk.code,
        language: streamChunk.language,
      });
      return { action: "continue" };
    }
    if (streamChunk?.type === "codeExecutionResult") {
      emit({
        type: "codeExecutionResult",
        output: streamChunk.output,
        outcome: streamChunk.outcome,
      });
      return { action: "continue" };
    }
    if (streamChunk?.type === "webSearchResult") {
      emit({ type: "webSearchResult", results: streamChunk.results });
      return { action: "continue" };
    }
    if (streamChunk?.type === "audio") {
      emit({ type: SSE_EVENT_TYPES.AUDIO, data: streamChunk.data, mimeType: streamChunk.mimeType });
      if (streamChunk.data) state.streamedAudioChunks.push(streamChunk.data);
      if (streamChunk.mimeType) {
        const rateMatch = streamChunk.mimeType.match(/rate=(\d+)/);
        if (rateMatch) state.audioSampleRate = parseInt(rateMatch[1], 10);
      }
      return { action: "continue" };
    }
    if (streamChunk?.type === "status") {
      const { type: _t, ...statusRest } = streamChunk;
      emit({ type: SSE_EVENT_TYPES.STATUS, ...statusRest });
      return { action: "continue" };
    }

    // ── Text chunk (default) ─────────────────────────────
    this._recordFirstToken(pass);
    this._recordTiming(pass);
    const rawChunkStr = typeof chunk === "string" ? chunk : "";
    state.overallOutputCharacters += rawChunkStr.length;
    pass.outputCharacters += rawChunkStr.length;
    pass.streamedText += rawChunkStr;
    // Strip tool call XML markup leaked by some local models
    const cleanedPassText = stripToolCallMarkup(pass.streamedText);
    const chunkStr = cleanedPassText.slice((pass.finalStreamedText || "").length);
    pass.finalStreamedText = cleanedPassText;
    state.finalStreamedText = cleanedPassText;
    if (state.planModeActive) state.planModeText += chunkStr;
    // Display segment tracking
    if (state.lastDisplaySegType !== "text") {
      state.displaySegments.push({
        type: SSE_EVENT_TYPES.TEXT,
        fragmentIndex: state.displayTextFragments.length,
      });
      state.displayTextFragments.push("");
      state.lastDisplaySegType = "text";
    }
    state.displayTextFragments[state.displayTextFragments.length - 1] +=
      chunkStr;
    if (pass.requestId) {
      SessionGenerationTracker.recordChunkTiming(
        pass.requestId,
        rawChunkStr.length,
      );
    }
    if (chunkStr)
      emit({
        type: SSE_EVENT_TYPES.CHUNK,
        content: chunkStr,
        outputCharacters: state.overallOutputCharacters,
      });
    this.maybeEmitProgress();
    return { action: "continue" };
  }

  // ── Iteration logging ─────────────────────────────────────

  /** Log a single iteration to the request log. */
  logIteration(pass: PassState, currentMessages: ConversationMessage[]): void {
    const {
      resolvedModel,
      providerName,
      project,
      username,
      agent,
      agentSessionId,
      parentAgentSessionId,
      traceId,
    } = this.ctx;
    const state = this.state;
    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];

    const passTotalSec = (performance.now() - pass.start) / 1000;
    const passGenerationSec =
      pass.firstTokenTime && pass.generationEnd
        ? (pass.generationEnd - pass.firstTokenTime) / 1000
        : null;
    const passTokensPerSec = calculateTokensPerSec(
      pass.usage.outputTokens,
      passGenerationSec,
    );
    const passEstimatedCost = calculateTextCost(pass.usage as Parameters<typeof calculateTextCost>[0], pricing);

    RequestLogger.logChatGeneration({
      requestId: `${this.ctx.requestId}-${state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      clientIp: this.ctx.clientIp,
      agent: agent || null,
      provider: providerName,
      model: resolvedModel,
      agentSessionId,
      parentAgentSessionId: parentAgentSessionId || null,
      traceId: traceId || null,
      success: true,
      usage: pass.usage as unknown as TokenUsage,
      estimatedCost: passEstimatedCost,
      tokensPerSec: passTokensPerSec,
      timeToGenerationSec: pass.firstTokenTime
        ? (pass.firstTokenTime - pass.start) / 1000
        : null,
      generationSec: passGenerationSec,
      totalSec: passTotalSec,
      options: pass.options,
      messages: currentMessages as unknown as MessagePayload[],
      text: pass.streamedText,
      thinking: pass.streamedThinking,
      images: pass.streamedImages,
      toolCalls: pass.pendingToolCalls as unknown as ToolCallPayload[],
      outputCharacters: pass.outputCharacters,
      agenticIteration: state.iterations,
    }).catch((error: Error) =>
      logger.error(
        `[AgenticLoopService] Failed to log intermediate request: ${error.message}`,
      ),
    );
  }

  // ── Per-iteration pass state factory ──────────────────────

  /** Create a fresh per-iteration pass state object. */
  createPassState(passOptions: Record<string, unknown>): PassState {
    return {
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [],
      streamedImages: [],
      start: performance.now(),
      firstTokenTime: null,
      generationEnd: null,
      outputCharacters: 0,
      usage: createUsageAccumulator(),
      options: passOptions,
      requestId: null, // set after tracker registration
    };
  }

  // ── Finalization ──────────────────────────────────────────

  /**
   * Shared finalization logic — cost calculation, persistence,
   * done event, worker snapshot persistence, and afterResponse hooks.
   *
   * Lifted from ReActHarness so all harnesses share the same
   * finalization path without copy-paste.
   */
  protected async finalize(
    currentMessages: ConversationMessage[],
    hooks: AgentHooks,
  ): Promise<void> {
    const context = this.ctx;
    const state = this.state;
    const { agentSessionId, project, username } = context;
    const requestStart = context.requestStart ?? performance.now();

    const now = performance.now();
    state.overallUsage.requests = state.iterations;

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    const newTurnMessages = currentMessages.slice(
      Math.max(0, state.originalMessageCount - 1),
    ).filter(
      (message) =>
        !(
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("[CONTEXT NOTE:")
        ),
    );

    logger.info(
      `[AgenticLoop] finalize: session=${agentSessionId} project=${project} ` +
        `originalMsgCount=${state.originalMessageCount} currentMsgs=${currentMessages.length} ` +
        `newTurnMsgs=${newTurnMessages.length} ` +
        `roles=[${newTurnMessages.map((m) => m.role).join(",")}] ` +
        `text=${(state.finalStreamedText || "").length}chars`,
    );

    await finalizeTextGeneration(
      context as FinalizerContext,
      {
        text: state.finalStreamedText.trim(),
        thinking: state.streamedThinking.trim() || "",
        images: state.streamedImages,
        toolCalls: state.streamedToolCalls,
        audioChunks: state.streamedAudioChunks,
        audioSampleRate: state.audioSampleRate,
        usage: state.overallUsage as Parameters<typeof finalizeTextGeneration>[1]["usage"],
        outputCharacters: state.overallOutputCharacters,
        timeToGenerationSec: state.overallFirstTokenTime
          ? (state.overallFirstTokenTime - requestStart) / 1000
          : null,
        generationSec:
          state.overallFirstTokenTime && state.overallGenerationEnd
            ? (state.overallGenerationEnd - state.overallFirstTokenTime) / 1000
            : null,
        totalSec: (now - requestStart) / 1000,
        rateLimits: state.lastRateLimits,
        contentSegments: cleanSegments,
        textFragments: cleanTextFragments,
        thinkingFragments: cleanThinkingFragments,
      },
      newTurnMessages as Parameters<typeof finalizeTextGeneration>[2],
    );

    // Persist worker snapshots for coordinator sessions
    if (
      // TODO(cleanup): Remove "team_create" once historical sessions have aged out
      state.streamedToolCalls.some((toolCall) => toolCall.name === "create_team" || toolCall.name === "team_create") &&
      agentSessionId
    ) {
      try {
        const { default: CoordinatorService } =
          await import("../CoordinatorService.js");
        const activeWorkersList = CoordinatorService.listWorkers({
          parentAgentSessionId: agentSessionId,
        });
        if (activeWorkersList.length > 0) {
          const collection = MongoWrapper.getCollection(
            MONGO_DB_NAME,
            COLLECTIONS.AGENT_CONVERSATIONS,
          );
          const agentSessionDocument = await collection.findOne(
            { id: agentSessionId, project, username },
            { projection: { workers: 1 } },
          );
          const existingWorkersList = (agentSessionDocument && agentSessionDocument.workers) || [];
          const mergedWorkersMap = new Map<string, any>();
          for (const worker of existingWorkersList) {
            mergedWorkersMap.set(worker.agentId, worker);
          }
          for (const worker of activeWorkersList) {
            mergedWorkersMap.set(worker.agentId, worker);
          }
          const finalWorkersList = Array.from(mergedWorkersMap.values());
          await collection.updateOne(
            { id: agentSessionId, project, username },
            {
              $set: {
                workers: finalWorkersList,
                workersUpdatedAt: new Date().toISOString(),
              },
            },
          );
          logger.info(
            `[AgenticLoop] Persisted ${finalWorkersList.length} worker(s) to session ${agentSessionId}`,
          );
        }
      } catch (error: unknown) {
        logger.error(`[AgenticLoop] Failed to persist workers: ${errorMessage(error)}`);
      }
    }

    // afterResponse hook (fire-and-forget)
    hooks
      .run("afterResponse" as Parameters<typeof hooks.run>[0], context, {
        text: state.finalStreamedText,
        thinking: state.streamedThinking,
        toolCalls: state.streamedToolCalls,
        messages: currentMessages,
      })
      .catch((error: Error) =>
        logger.error(
          `[AgenticLoopService] afterResponse hooks failed: ${error.message}`,
        ),
      );
  }

  // ── Private helpers ───────────────────────────────────────

  private _recordFirstToken(pass: PassState): void {
    const state = this.state;
    if (!state.overallFirstTokenTime)
      state.overallFirstTokenTime = performance.now();
    if (!pass.firstTokenTime) {
      pass.firstTokenTime = performance.now();
      const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
      if (pass.requestId) SessionGenerationTracker.update(pass.requestId, { ttft: ttftSec });
      this.ctx.emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_STARTED,
        timeToFirstToken: ttftSec,
      });
    }
  }

  private _recordTiming(pass: PassState): void {
    this.state.overallGenerationEnd = performance.now();
    pass.generationEnd = performance.now();
  }

  private _trackToolDisplaySegment(tcId: string): void {
    const state = this.state;
    const lastSeg = state.displaySegments[state.displaySegments.length - 1];
    if (state.lastDisplaySegType === "tools" && lastSeg?.type === "tools") {
      lastSeg.toolIds.push(tcId);
    } else {
      state.displaySegments.push({ type: "tools", toolIds: [tcId] });
      state.lastDisplaySegType = "tools";
    }
  }

  private async _handleImageChunk(
    chunk: Record<string, unknown>,
    pass: PassState,
  ): Promise<ChunkAction> {
    const { emit, project, username } = this.ctx;
    const state = this.state;
    let minioRef = null;
    if (chunk.data) {
      try {
        const mimeType = chunk.mimeType || "image/png";
        const dataUrl = `data:${mimeType};base64,${chunk.data}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          "generations",
          project,
          username,
        );
        minioRef = ref;
      } catch (error: unknown) {
        logger.error(`MinIO upload failed: ${errorMessage(error)}`);
      }
      const imgRef =
        minioRef ||
        `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`;
      state.streamedImages.push(imgRef);
      pass.streamedImages.push(imgRef);
    }
    emit({
      type: SSE_EVENT_TYPES.IMAGE,
      ...(minioRef ? {} : { data: chunk.data }),
      mimeType: chunk.mimeType,
      minioRef,
    });
    return { action: "continue" };
  }
}
