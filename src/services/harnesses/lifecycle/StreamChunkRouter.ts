/**
 * StreamChunkRouter — routes a single provider stream chunk to the
 * appropriate handler, mutating pass/loop state and emitting SSE events.
 *
 * Extracted from BaseAgenticHarness (which delegates via
 * `processStreamChunk`) so chunk routing has its own home instead of
 * living inside the 1,800-line base class. Operates on the harness via
 * the same bracket-access idiom the strategies use.
 */
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { mergeUsage } from "#src/utils/CostCalculator";
import { takeNativeTurnInput } from "#src/services/harnesses/lifecycle/TurnInputDrain";
import { stripToolCallMarkup } from "#src/utils/StreamChunkDispatcher";
import ConversationGenerationTracker from "#src/services/ConversationGenerationTracker";
import WebhookEventBus from "#src/services/WebhookEventBus";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import FileService from "#src/services/FileService";
import { FILE_CATEGORIES } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import type BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import type { TokenUsage, AnthropicThinkingBlock } from "#src/types/admin";
import type { RequestTelemetryChunk } from "#src/utils/PromptPrefixHashes";
import type {
  PassState,
  ChunkAction,
  StreamChunk,
  ToolCall,
} from "#src/services/harnesses/types";

/**
 * Process a single stream chunk — routes to the appropriate handler.
 * Returns an action descriptor for the caller:
 *   `continue` — chunk was consumed, keep iterating
 *   `toolCall` — a tool call was detected
 *   `skip`     — chunk was filtered/dropped
 *   `break`    — abort signal received
 */
export function routeStreamChunk(
  harness: BaseAgenticHarness,
  chunk: StreamChunk,
  pass: PassState,
  allowedToolNames: Set<string>,
): ChunkAction | Promise<ChunkAction> {
  const context = harness["context"];
  const state = harness["state"];
  const { emit, signal } = context;
  // Cast to a loose typed object — we branch on `type` below
  const streamChunk = chunk as StreamChunk;

  // Abort check
  if (signal?.aborted) return { action: "break" };

  // ── Usage event ──────────────────────────────────────
  if (streamChunk?.type === "usage") {
    const usageChunk = streamChunk.usage as TokenUsage | undefined;
    mergeUsage(state.overallUsage, usageChunk);
    mergeUsage(pass.usage, usageChunk);
    const rawUsage = streamChunk.usage as Record<string, number> | undefined;
    if (pass.requestId) {
      const reportedInput =
        usageChunk?.inputTokens || rawUsage?.promptTokens || 0;
      const reportedOutput = usageChunk?.outputTokens || 0;
      const trackerUpdate: Record<string, number> = {};
      if (reportedInput > 0) trackerUpdate.inputTokens = reportedInput;
      if (reportedOutput > 0) trackerUpdate.outputTokens = reportedOutput;
      const reportedCacheRead = usageChunk?.cacheReadInputTokens || 0;
      const reportedCacheWrite = usageChunk?.cacheCreationInputTokens || 0;
      if (reportedCacheRead > 0) {
        trackerUpdate.cacheReadInputTokens = reportedCacheRead;
      }
      if (reportedCacheWrite > 0) {
        trackerUpdate.cacheCreationInputTokens = reportedCacheWrite;
      }
      if (usageChunk?.tokensPerSec != null && usageChunk.tokensPerSec > 0) {
        trackerUpdate.providerTokPerSec = usageChunk.tokensPerSec;
      }
      if (Object.keys(trackerUpdate).length > 0) {
        ConversationGenerationTracker.update(pass.requestId, trackerUpdate);
      }
    }

    // Record real token counts on the budget tracker for calibration
    // and to re-emit a corrected context budget snapshot.
    // For self-hosted cold starts, the context window only becomes known
    // mid-stream — ensureBudgetTracker will create the tracker now
    // using the freshly-discovered context length.
    const tracker = harness["ensureBudgetTracker"]();
    if (tracker) {
      tracker.recordRealUsage(
        usageChunk,
        harness["lastEstimatedMessageTokens"],
      );
    }

    return { action: "continue" };
  }

  // ── Rate limits ──────────────────────────────────────
  if (streamChunk?.type === "rateLimits") {
    state.lastRateLimits = streamChunk.rateLimits || null;
    return { action: "continue" };
  }

  // ── Prompt-cache telemetry (hashes of what was sent) ──
  if (streamChunk?.type === "requestTelemetry") {
    pass.requestTelemetry = streamChunk as unknown as RequestTelemetryChunk;
    return { action: "continue" };
  }

  // ── Stop reason (truncation detection) ───────────────
  if (streamChunk?.type === "stopReason") {
    pass.stopReason = (streamChunk.stopReason as string) || undefined;
    return { action: "continue" };
  }

  // ── Thinking ─────────────────────────────────────────
  if (streamChunk?.type === "thinking") {
    recordFirstToken(harness, pass);
    recordTiming(harness, pass);
    if (pass.thinkingStartTime === null) {
      pass.thinkingStartTime = performance.now();
    }
    state.streamedThinking += streamChunk.content || "";
    pass.streamedThinking += streamChunk.content || "";
    if (
      state.displayThinkingFragments.length === 0 ||
      state.lastDisplaySegType !== "thinking"
    ) {
      logger.debug(
        `[Harness:Thinking] NEW thinking segment on iteration ${state.iterations}, ` +
          `fragments=${state.displayThinkingFragments.length}, lastSegType=${state.lastDisplaySegType}, ` +
          `contentLen=${(streamChunk.content || "").length}ch`,
      );
    }
    // Display segment tracking
    if (state.lastDisplaySegType !== "thinking") {
      state.displaySegments.push({
        type: SERVER_SENT_EVENT_TYPES.THINKING,
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
      ConversationGenerationTracker.recordChunkTiming(
        pass.requestId,
        (streamChunk.content || "").length,
      );
    }
    emit({
      type: SERVER_SENT_EVENT_TYPES.THINKING,
      content: streamChunk.content || "",
      outputCharacters: state.overallOutputCharacters,
    });
    harness.maybeEmitProgress();

    // ── Deviation rules on the thinking stream ─────────
    const thinkingDeviation = harness["deviationEngine"].observeTextChunk(
      streamChunk.content || "",
    );
    if (thinkingDeviation) {
      logger.warn(
        `[DeviationRuleEngine] Rule "${thinkingDeviation.ruleId}" fired on thinking stream ` +
          `at iteration ${state.iterations}: ${thinkingDeviation.detail}`,
      );
      return { action: "deviation", verdict: thinkingDeviation };
    }

    return { action: "continue" };
  }

  // ── Thinking signature (Anthropic) ───────────────────
  if (streamChunk?.type === "thinking_signature") {
    pass.thinkingSignature = streamChunk.signature || "";
    return { action: "continue" };
  }

  // ── Thinking block (Anthropic) ───────────────────────
  // Stored verbatim and in order on the assistant message this pass
  // produces — a merged or trimmed block is a tampered signature. A block
  // that followed other content (a progress update) stays `trailing` until
  // the tool call it introduces starts.
  if (streamChunk?.type === "thinking_block" && streamChunk.block) {
    const block = {
      ...(streamChunk.block as AnthropicThinkingBlock),
    } as AnthropicThinkingBlock;
    if (streamChunk.afterContent === true) block.trailing = true;
    (pass.thinkingBlocks ??= []).push(block);
    state.thinkingBlocks = pass.thinkingBlocks;
    return { action: "continue" };
  }

  // ── Refusal (Anthropic safety classifiers) ───────────
  if (streamChunk?.type === "refusal") {
    pass.refusal = {
      category: (streamChunk.category as string | null) ?? null,
      explanation: (streamChunk.explanation as string | null) ?? null,
      recommendedModel: (streamChunk.recommendedModel as string | null) ?? null,
      model: pass.servedModel ?? context.resolvedModel,
    };
    return { action: "continue" };
  }

  // ── Server-side fallback took over mid-response ──────
  // Thinking and client tool calls the declining model produced before the
  // hand-off are never replayed or run; streamed text stays (the fallback
  // model continues from it).
  if (streamChunk?.type === "fallback") {
    logger.info(
      `[AgenticLoop] ${streamChunk.from ?? context.resolvedModel} declined — ${streamChunk.to ?? "a fallback model"} continues (iteration ${state.iterations})`,
    );
    pass.thinkingBlocks = [];
    state.thinkingBlocks = pass.thinkingBlocks;
    pass.pendingToolCalls = [];
    return { action: "continue" };
  }

  // ── The model that actually served the pass ──────────
  if (streamChunk?.type === "servedModel") {
    pass.servedModel = (streamChunk.model as string) || undefined;
    return { action: "continue" };
  }

  // ── Provider-native state (OpenAI Responses) ─────────
  // response.id, message phase and unpaired reasoning items — stored on
  // the assistant message this pass produces and replayed next turn.
  if (streamChunk?.type === "providerState") {
    const loopState = harness["state"];
    if (streamChunk.providerResponseId) {
      pass.providerResponseId = streamChunk.providerResponseId;
      // A new response id opens a new pass: whatever the previous pass left
      // on the loop state belongs to a message already pushed.
      loopState.providerResponseId = streamChunk.providerResponseId;
      loopState.phase = undefined;
      loopState.reasoningItems = undefined;
      loopState.responsesEffort = undefined;
    }
    if (streamChunk.responsesEffort) {
      pass.responsesEffort = streamChunk.responsesEffort;
      loopState.responsesEffort = streamChunk.responsesEffort;
    }
    // Gemini reports its parts once per response ([] when none need
    // replaying): the loop state tracks the newest pass, citations included.
    if (streamChunk.geminiParts) {
      const parts = streamChunk.geminiParts.length > 0 ? streamChunk.geminiParts : undefined;
      pass.geminiParts = parts;
      loopState.geminiParts = parts;
      loopState.citations = undefined;
    }
    if (streamChunk.phase !== undefined) {
      pass.phase = streamChunk.phase;
      loopState.phase = streamChunk.phase;
    }
    if (streamChunk.reasoningItems && streamChunk.reasoningItems.length > 0) {
      pass.reasoningItems = [
        ...(pass.reasoningItems ?? []),
        ...streamChunk.reasoningItems,
      ];
      loopState.reasoningItems = pass.reasoningItems;
    }
    return { action: "continue" };
  }

  // ── Grounding citations (Gemini Google Search) ──────────
  // Stored on the answer's message and shown live as the turn's sources.
  if (streamChunk?.type === "citations") {
    const citations = {
      sources: streamChunk.sources ?? [],
      queries: streamChunk.queries ?? [],
      supports: streamChunk.supports ?? [],
    };
    pass.citations = citations;
    harness["state"].citations = citations;
    emit({ type: "citations", sources: citations.sources, queries: citations.queries });
    emit({ type: "webSearchResult", results: citations.sources });
    return { action: "continue" };
  }

  // ── Mid-turn input applied natively (OpenAI response.steer) ──
  // The continuation now streaming carries it: acknowledge it now, and the
  // harness records it ahead of this pass's assistant message.
  if (streamChunk?.type === "turnInputApplied") {
    const applied = takeNativeTurnInput(streamChunk.inputIds ?? [], state, context);
    if (applied.length > 0) {
      pass.nativeTurnInput = [...(pass.nativeTurnInput ?? []), ...applied];
    }
    return { action: "continue" };
  }

  // ── Tool call start (early disclosure) ─────────────────
  if (streamChunk?.type === "toolCallStart") {
    anchorTrailingThinkingBlocks(pass, streamChunk.id);
    recordFirstToken(harness, pass);
    recordTiming(harness, pass);
    sealThinkingPhase(pass);
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
      tool: {
        name: streamChunk.name || "",
        args: {},
        id: streamChunk.id || "",
      },
      toolLabel: ToolOrchestratorService.getToolLabel(
        streamChunk.name || "",
        {},
        true,
      ),
      status: "streaming",
      timestamp: Date.now(),
    });
    harness.maybeEmitProgress();
    return { action: "continue" };
  }

  // ── Tool call argument delta ─────────────────────────
  if (streamChunk?.type === "toolCallDelta") {
    recordFirstToken(harness, pass);
    recordTiming(harness, pass);
    state.overallOutputCharacters += streamChunk.characters as number;
    if (pass.requestId) {
      ConversationGenerationTracker.recordChunkTiming(
        pass.requestId,
        streamChunk.characters as number,
      );
    }
    harness.maybeEmitProgress();
    return { action: "continue" };
  }

  // ── Tool call ────────────────────────────────────────
  if (streamChunk?.type === "toolCall") {
    recordFirstToken(harness, pass);
    recordTiming(harness, pass);
    sealThinkingPhase(pass);
    if (pass.requestId) {
      ConversationGenerationTracker.recordChunkTiming(
        pass.requestId,
        JSON.stringify(streamChunk.args || {}).length,
      );
    }
    harness.maybeEmitProgress();

    // Native MCP tool calls: pass through directly
    if (streamChunk.native) {
      const toolName = streamChunk.name || "";
      const toolCallId =
        streamChunk.id || `ntc-${state.streamedToolCalls.length}`;

      if (streamChunk.status === "calling") {
        state.streamedToolCalls.push({
          id: toolCallId,
          name: toolName,
          args: streamChunk.args || {},
        });
        trackToolDisplaySegment(harness, toolCallId);

        WebhookEventBus.emit("request.tool_call.started", {
          requestId: context.requestId || null,
          toolName,
          toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
          toolCallId,
          toolArgs: streamChunk.args || {},
          agent: context.agent || null,
          conversationId: context.conversationId || null,
          agentConversationId: context.agentConversationId || null,
          project: context.project,
          username: context.username,
          provider: context.providerName,
          model: context.resolvedModel,
          iteration: state.iterations,
        });
      } else if (
        streamChunk.status === "done" ||
        streamChunk.status === "error"
      ) {
        const existing = state.streamedToolCalls.find(
          (toolCall) =>
            (streamChunk.id && toolCall.id === streamChunk.id) ||
            (!streamChunk.id && toolCall.name === streamChunk.name),
        );
        if (existing) {
          existing.result = streamChunk.result;
          existing.status = streamChunk.status;
          if (streamChunk.args && Object.keys(streamChunk.args).length > 0)
            existing.args = streamChunk.args;
        }

        WebhookEventBus.emit("request.tool_call.completed", {
          requestId: context.requestId || null,
          toolName,
          toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
          toolCallId,
          toolResult: streamChunk.result || null,
          durationMilliseconds: null,
          status: streamChunk.status,
          agent: context.agent || null,
          conversationId: context.conversationId || null,
          agentConversationId: context.agentConversationId || null,
          project: context.project,
          username: context.username,
          provider: context.providerName,
          model: context.resolvedModel,
        });
      }
      emit({
        type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
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
      // Record the drop so the harness can tell the model the tool is
      // unavailable — a silent skip leaves the pass looking thinking-only
      // and the model retries the same call forever.
      if (toolName) {
        (pass.droppedToolCallNames ??= []).push(toolName);
      }
      return { action: "skip" };
    }

    const standardToolCallId =
      streamChunk.id || `toolCall-${state.streamedToolCalls.length}`;
    const toolCall: ToolCall = {
      id: standardToolCallId,
      responsesItemId: streamChunk.responsesItemId || undefined,
      name: toolName,
      args: streamChunk.args || {},
      thoughtSignature: streamChunk.thoughtSignature || undefined,
      reasoningItem: streamChunk.reasoningItem || undefined,
      ...(streamChunk.nativeAsync === true && { nativeAsync: true }),
      ...(streamChunk.argsParseError === true && {
        _argsParseError: true,
        _rawArgs:
          typeof streamChunk.rawArgs === "string"
            ? streamChunk.rawArgs
            : undefined,
      }),
    };

    // ── Deviation rules on streamed tool calls ─────────────
    // Evaluated BEFORE the call is recorded or disclosed via SSE, so an
    // aborted pass leaves no phantom tool call in state or on the client.
    // (Native calls above are provider-executed and cannot be cancelled.)
    const toolCallDeviation =
      harness["deviationEngine"].observeToolCall(toolCall);
    if (toolCallDeviation) {
      logger.warn(
        `[DeviationRuleEngine] Rule "${toolCallDeviation.ruleId}" fired on tool call ` +
          `"${toolName}" at iteration ${state.iterations}: ${toolCallDeviation.detail}`,
      );
      return { action: "deviation", verdict: toolCallDeviation };
    }

    pass.pendingToolCalls.push(toolCall);
    state.streamedToolCalls.push({ ...toolCall });
    trackToolDisplaySegment(harness, standardToolCallId);
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
      tool: {
        name: toolName,
        args: streamChunk.args || {},
        id: standardToolCallId,
      },
      toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
      toolLabel: ToolOrchestratorService.getToolLabel(
        toolName,
        streamChunk.args || {},
        true,
      ),
      status: "calling",
      timestamp: Date.now(),
    });
    WebhookEventBus.emit("request.tool_call.started", {
      requestId: context.requestId || null,
      toolName,
      toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
      toolCallId: standardToolCallId,
      toolArgs: streamChunk.args || {},
      agent: context.agent || null,
      conversationId: context.conversationId || null,
      agentConversationId: context.agentConversationId || null,
      project: context.project,
      username: context.username,
      provider: context.providerName,
      model: context.resolvedModel,
      iteration: state.iterations,
    });
    return { action: "toolCall", toolCall: toolCall };
  }

  // ── Image ────────────────────────────────────────────
  if (streamChunk?.type === "image") {
    return handleImageChunk(harness, streamChunk, pass);
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
    emit({
      type: SERVER_SENT_EVENT_TYPES.AUDIO,
      data: streamChunk.data,
      mimeType: streamChunk.mimeType,
    });
    if (streamChunk.data) state.streamedAudioChunks.push(streamChunk.data);
    if (streamChunk.mimeType) {
      const rateMatch = streamChunk.mimeType.match(/rate=(\d+)/);
      if (rateMatch) state.audioSampleRate = parseInt(rateMatch[1], 10);
    }
    return { action: "continue" };
  }
  if (streamChunk?.type === "status") {
    const { type: _type, ...statusRest } = streamChunk;
    emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, ...statusRest });
    return { action: "continue" };
  }

  // ── Text chunk (default) ─────────────────────────────
  recordFirstToken(harness, pass);
  recordTiming(harness, pass);
  sealThinkingPhase(pass);
  const rawChunkString = typeof chunk === "string" ? chunk : "";
  state.overallOutputCharacters += rawChunkString.length;
  pass.outputCharacters += rawChunkString.length;
  pass.streamedText += rawChunkString;
  // Strip tool call XML markup leaked by some local models
  const cleanedPassText = stripToolCallMarkup(pass.streamedText);
  const chunkString = cleanedPassText.slice(
    (pass.finalStreamedText || "").length,
  );
  pass.finalStreamedText = cleanedPassText;
  state.finalStreamedText = cleanedPassText;
  if (state.planModeActive) state.planModeText += chunkString;
  // Display segment tracking
  if (state.lastDisplaySegType !== "text") {
    state.displaySegments.push({
      type: SERVER_SENT_EVENT_TYPES.TEXT,
      fragmentIndex: state.displayTextFragments.length,
    });
    state.displayTextFragments.push("");
    state.lastDisplaySegType = "text";
  }
  state.displayTextFragments[state.displayTextFragments.length - 1] +=
    chunkString;
  if (pass.requestId) {
    ConversationGenerationTracker.recordChunkTiming(
      pass.requestId,
      rawChunkString.length,
    );
  }
  if (chunkString)
    emit({
      type: SERVER_SENT_EVENT_TYPES.CHUNK,
      content: chunkString,
      outputCharacters: state.overallOutputCharacters,
    });
  harness.maybeEmitProgress();

  // ── Deviation rules on the text stream ───────────────
  const textDeviation =
    harness["deviationEngine"].observeTextChunk(rawChunkString);
  if (textDeviation) {
    logger.warn(
      `[DeviationRuleEngine] Rule "${textDeviation.ruleId}" fired on text stream ` +
        `at iteration ${state.iterations}: ${textDeviation.detail}`,
    );
    return { action: "deviation", verdict: textDeviation };
  }

  return { action: "continue" };
}

// ── Timing / display-segment helpers ────────────────────────

function recordFirstToken(harness: BaseAgenticHarness, pass: PassState): void {
  const state = harness["state"];
  if (!state.overallFirstTokenTime)
    state.overallFirstTokenTime = performance.now();
  if (!pass.firstTokenTime) {
    pass.firstTokenTime = performance.now();
    const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
    if (pass.requestId)
      ConversationGenerationTracker.update(pass.requestId, { ttft: ttftSec });
    harness["context"].emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.GENERATION_STARTED,
      timeToFirstToken: ttftSec,
    });
  }
}

function recordTiming(harness: BaseAgenticHarness, pass: PassState): void {
  harness["state"].overallGenerationEnd = performance.now();
  pass.generationEnd = performance.now();
}

function trackToolDisplaySegment(
  harness: BaseAgenticHarness,
  toolCallId: string,
): void {
  const state = harness["state"];
  const lastSeg = state.displaySegments[state.displaySegments.length - 1];
  if (state.lastDisplaySegType === "tools" && lastSeg?.type === "tools") {
    lastSeg.toolIds.push(toolCallId);
  } else {
    state.displaySegments.push({ type: "tools", toolIds: [toolCallId] });
    state.lastDisplaySegType = "tools";
  }
}

/**
 * Thinking blocks that followed other content in the pass (progress
 * updates) belong in front of the tool call that starts next.
 */
function anchorTrailingThinkingBlocks(
  pass: PassState,
  toolCallId: string | undefined,
): void {
  if (!toolCallId || !pass.thinkingBlocks) return;
  for (const block of pass.thinkingBlocks) {
    if (block.trailing) {
      delete block.trailing;
      block.beforeToolCallId = toolCallId;
    }
  }
}

/** Seal the thinking phase — record thinkingEndTime if thinking was active and not yet sealed. */
function sealThinkingPhase(pass: PassState): void {
  if (pass.thinkingStartTime !== null && pass.thinkingEndTime === null) {
    pass.thinkingEndTime = performance.now();
  }
}

async function handleImageChunk(
  harness: BaseAgenticHarness,
  chunk: StreamChunk,
  pass: PassState,
): Promise<ChunkAction> {
  const context = harness["context"];
  const state = harness["state"];
  const { emit, project, username } = context;
  let minioRef = null;
  if (chunk.data) {
    try {
      const mimeType = chunk.mimeType || "image/png";
      const dataUrl = `data:${mimeType};base64,${chunk.data}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        FILE_CATEGORIES.GENERATIONS,
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
    type: SERVER_SENT_EVENT_TYPES.IMAGE,
    ...(minioRef ? {} : { data: chunk.data }),
    mimeType: chunk.mimeType,
    minioRef,
  });
  return { action: "continue" };
}
