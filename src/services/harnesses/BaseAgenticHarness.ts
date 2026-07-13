import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import {
  streamWithRetries,
  withIdleTimeout,
} from "#src/utils/ProviderStreamResilience";
import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import RepetitionDetector from "#src/utils/RepetitionDetector";
import {
  mergeUsage,
  createUsageAccumulator,
  calculateTextCost,
  estimateTokens,
  withTotalInputTokens,
} from "#src/utils/CostCalculator";
import { calculateTokensPerSec } from "#src/utils/math";
import { getPricing, MODALITY_TYPES } from "#src/config";
import { stripToolCallMarkup } from "#src/utils/StreamChunkDispatcher";
import ContextWindowManager from "#src/utils/ContextWindowManager";
import ContextBudgetTracker from "./ContextBudgetTracker.ts";
import {
  isContextExhausted,
  logContextExhaustion,
  emitContextExhaustedStatus,
} from "./lifecycle/ContextExhaustionGuard.ts";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";
import ConversationGenerationTracker from "#src/services/ConversationGenerationTracker";
import ConversationStatusRegistry from "#src/services/ConversationStatusRegistry";
import RequestLogger from "#src/services/RequestLogger";
import FileService from "#src/services/FileService";
import { FILE_CATEGORIES, UNITS, DEFAULT_LOCALE } from "#src/constants";
import {
  finalizeTextGeneration,
  type FinalizerContext,
  type DeferredDoneEvent,
  computeNewTurnMessages,
} from "./lifecycle/Finalizer.ts";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  CORE_ORCHESTRATOR_TOOLS as CORE_ORCHESTRATOR_TOOLS_LIST,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import ToolContext from "#src/services/ToolContext";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";

import WebhookEventBus from "#src/services/WebhookEventBus";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import AgenticToolResolver from "#src/services/AgenticToolResolver";
import { ToolDocFormatter } from "#src/services/system-prompt/ToolDocFormatter";
import { getToolPolicyAddendum } from "#src/services/personas/utils";
import PromptLocaleService from "#src/services/PromptLocaleService";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type AgentHooks from "#src/services/AgentHooks";
import type { ChatMessage, TokenUsage } from "#src/types/admin";
import type { MessagePayload, ToolCallPayload } from "#src/services/conversation/types";
import type {
  AgenticContext,
  AgenticOptions,
  ResolvedTools,
  PassState,
  ChunkAction,
  ConversationMessage,
  StreamChunk,
  ToolCall,
  UsageAccumulator,
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

  protected context: AgenticContext;
  protected state: AgenticLoopState;
  protected tools: ResolvedTools;
  protected trackerConversationId: string;
  protected repetitionDetector: RepetitionDetector;
  protected budgetTracker: ContextBudgetTracker | null;

  /** Cached estimated message tokens from the last clampOutputTokens call.
   *  Used by the usage handler to compute calibration ratio. */
  private lastEstimatedMessageTokens = 0;

  constructor(
    context: AgenticContext,
    state: AgenticLoopState,
    tools: ResolvedTools,
  ) {
    this.context = context;
    this.state = state;
    this.tools = tools;
    this.trackerConversationId = (context.parentAgentConversationId ||
      context.agentConversationId ||
      "") as string;
    this.repetitionDetector = new RepetitionDetector();

    // Budget tracker is lazily initialized when the context window
    // first becomes available — see ensureBudgetTracker().
    this.budgetTracker = null;
  }

  /** Execute the agentic loop. Subclasses MUST override. */
  async run(): Promise<{ messages: ConversationMessage[] }> {
    throw new Error(
      `${this.constructor.name}.run() is abstract — subclasses must override.`,
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  DYNAMIC TOOL SET MUTATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private static readonly CORE_AGENTIC_SET = new Set<string>(
    CORE_AGENTIC_TOOLS_LIST,
  );
  private static readonly CORE_ORCHESTRATOR_SET = new Set<string>(
    CORE_ORCHESTRATOR_TOOLS_LIST,
  );

  private static readonly toolDocFormatter = new ToolDocFormatter();

  /**
   * Check ToolContext for a dirty flag set by enable_tools / disable_tools.
   * If set, re-filter `this.tools` from the full schema catalog using the
   * dynamic enabled set stored in ToolContext.
   *
   * When tools are added, injects a documentation addendum into
   * currentMessages so the model receives human-readable descriptions
   * and parameter docs for dynamically activated tools (the initial
   * system prompt is only assembled on iteration 1 and never rebuilt).
   *
   * Returns true if the tool set was mutated.
   */
  checkAndApplyToolSetChanges(
    currentMessages?: ConversationMessage[],
    lastPassUsage?: UsageAccumulator | null,
  ): boolean {
    const conversationId = this.context.agentConversationId;
    const toolContextStore = ToolContext.getStore(conversationId);
    if (!toolContextStore.get("toolSetDirty")) return false;

    toolContextStore.delete("toolSetDirty");

    const dynamicEnabledArray = toolContextStore.get("dynamicEnabledTools") as
      | string[]
      | null;
    if (!Array.isArray(dynamicEnabledArray)) return false;

    const dynamicEnabledSet = new Set(dynamicEnabledArray);

    const previousToolNames = new Set(
      (this.tools.finalTools as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    );

    const allSchemas = [
      ...ToolOrchestratorService.getToolSchemas(),
      ...ToolOrchestratorService.getMCPToolSchemas().map((mcpTool) => {
        const { _mcpServer, _mcpOriginalName, ...schema } =
          mcpTool as unknown as Record<string, unknown>;
        return schema as { name: string; [key: string]: unknown };
      }),
    ] as Array<{ name: string; [key: string]: unknown }>;

    const isSubAgent = !!this.context.parentAgentConversationId;

    // When the model has native thinking, the think tool is redundant —
    // re-apply the same exclusion that AgenticToolResolver.resolve() does
    // during initial resolution, so dynamic tool set mutations don't
    // accidentally re-introduce it.
    const hasNativeThinking = AgenticToolResolver.detectNativeThinking(
      this.context.modelDefinition || undefined,
      this.context.providerName,
      this.context.resolvedModel,
      this.context.options?.thinkingEnabled as boolean | undefined,
    );

    const filteredTools = allSchemas.filter((tool) => {
      if (hasNativeThinking && tool.name === TOOL_NAMES.THINK) return false;
      return (
        dynamicEnabledSet.has(tool.name) ||
        tool.name.startsWith("mcp__") ||
        BaseAgenticHarness.CORE_AGENTIC_SET.has(tool.name) ||
        (!isSubAgent &&
          BaseAgenticHarness.CORE_ORCHESTRATOR_SET.has(tool.name)) ||
        InternalToolRegistry.has(tool.name)
      );
    }) as unknown as ResolvedTools["finalTools"];

    this.tools = {
      finalTools: filteredTools,
      resolvedEnabledTools: dynamicEnabledArray,
    };

    // Tool definitions serialize AHEAD of messages in provider payloads, so a
    // mid-loop tool-set swap invalidates the entire prompt-cache prefix. The
    // cost was previously silent — surface it so cache-thrash is diagnosable.
    // The last pass's total input (remainder + cache read + cache write) is
    // the prefix the next iteration must re-prefill from scratch.
    const estimatedInvalidatedTokens = lastPassUsage
      ? (Number(lastPassUsage.inputTokens) || 0) +
        (Number(lastPassUsage.cacheReadInputTokens) || 0) +
        (Number(lastPassUsage.cacheCreationInputTokens) || 0)
      : null;
    logger.warn(
      `[AgenticLoop] Tool set changed mid-loop at iteration ${this.state.iterations} ` +
        `(${previousToolNames.size} → ${filteredTools.length} tools) — ` +
        `this busts the provider prompt-cache prefix for subsequent iterations` +
        (estimatedInvalidatedTokens !== null
          ? ` (~${estimatedInvalidatedTokens} prefix tokens invalidated).`
          : `.`),
    );

    WebhookEventBus.emit("request.cache_invalidated", {
      agentConversationId: conversationId,
      conversationId: this.context.conversationId,
      provider: this.context.providerName,
      model: this.context.resolvedModel,
      iteration: this.state.iterations,
      previousToolCount: previousToolNames.size,
      newToolCount: filteredTools.length,
      estimatedInvalidatedTokens,
      reason: "tool_set_changed",
    });

    this.context.emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.TOOL_SET_CHANGED,
      enabledCount: filteredTools.length,
      dynamicTools: dynamicEnabledArray,
      ...(estimatedInvalidatedTokens !== null && {
        estimatedInvalidatedTokens,
      }),
    });

    // Compute newly added tools and inject documentation addendum
    const newlyAddedToolSchemas = (
      filteredTools as unknown as Array<{
        name: string;
        [key: string]: unknown;
      }>
    ).filter(
      (tool) =>
        !previousToolNames.has(tool.name) &&
        !BaseAgenticHarness.CORE_AGENTIC_SET.has(tool.name) &&
        !BaseAgenticHarness.CORE_ORCHESTRATOR_SET.has(tool.name) &&
        !InternalToolRegistry.has(tool.name),
    );

    if (currentMessages && newlyAddedToolSchemas.length > 0) {
      const activeLocale =
        (this.context.options?.locale as string | undefined) ||
        PromptLocaleService.getDefaultLocale();
      const addendumDocumentation =
        BaseAgenticHarness.toolDocFormatter.buildToolDescriptions(
          newlyAddedToolSchemas.map((tool) => tool.name),
          undefined,
          undefined,
          newlyAddedToolSchemas.map((tool) => tool.name),
          undefined,
          undefined,
          activeLocale,
        );

      if (addendumDocumentation) {
        const toolNamesList = newlyAddedToolSchemas
          .map((tool) => tool.name)
          .join(", ");

        const policyAddendum = getToolPolicyAddendum(
          newlyAddedToolSchemas.map((tool) => tool.name),
          activeLocale,
        );

        const headerText = PromptLocaleService.get(
          activeLocale,
          "harness.toolSetUpdated.header",
          {
            count: String(newlyAddedToolSchemas.length),
            toolNames: toolNamesList,
          },
        );
        const availableText = PromptLocaleService.get(
          activeLocale,
          "harness.toolSetUpdated.availableDocumentation",
        );
        const guidelinesHeader = PromptLocaleService.get(
          activeLocale,
          "harness.toolSetUpdated.usageGuidelines",
        );

        currentMessages.push({
          role: "system",
          content:
            `<tool-update>\n` +
            `${headerText}\n\n` +
            `${availableText}\n\n` +
            addendumDocumentation +
            (policyAddendum
              ? `\n\n${guidelinesHeader}\n\n${policyAddendum}`
              : "") +
            `\n</tool-update>`,
        });

        logger.info(
          `[BaseAgenticHarness] Injected documentation addendum for ${newlyAddedToolSchemas.length} newly activated tools: [${toolNamesList}]` +
            (policyAddendum ? ` (with policy guidance)` : ""),
        );
      }
    }

    logger.info(
      `[BaseAgenticHarness] Tool set mutated: ${filteredTools.length} tools active (${dynamicEnabledArray.length} dynamic)`,
    );

    return true;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SHARED INFRASTRUCTURE — used by all harness subclasses
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── Progress emission ────────────────────────────────────

  /** Emit a generation_progress status event with current session stats. */
  emitGenerationProgress(): void {
    const { emit } = this.context;
    const state = this.state;
    const stats = ConversationGenerationTracker.getConversationStats(
      this.trackerConversationId,
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
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_PROGRESS,
        tokPerSec: stats.tokPerSec,
        activeRequests: stats.activeRequests,
        outputTokens: state.hwmOutputTokens,
        inputTokens: state.hwmInputTokens,
        totalTokens: state.hwmTotalTokens,
        outputCharacters: state.hwmOutputCharacters,
        avgTtft: stats.avgTtft,
      });

      // Mirror throughput data to the live status registry so clients
      // recovering from a page refresh or conversation switch can read
      // the current generation state from the REST endpoint.
      const registryConversationId = this.context.agentConversationId as string;
      if (registryConversationId) {
        ConversationStatusRegistry.patch(registryConversationId, {
          tokensPerSecond: stats.tokPerSec,
          activeRequests: stats.activeRequests,
          outputTokens: state.hwmOutputTokens,
          inputTokens: state.hwmInputTokens,
          totalTokens: state.hwmTotalTokens,
        });
      }
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
      timeSinceLast >= state.PROGRESS_TIME_INTERVAL_MILLISECONDS
    ) {
      this.emitGenerationProgress();
    }
  }

  /**
   * Emit a usage_update SSE event with the cumulative usage snapshot
   * and the server-computed estimatedCost (using CostCalculator).
   *
   * This is the authoritative intermediate cost during streaming —
   * the client should prefer this over any local recalculation.
   */
  emitUsageUpdate(): void {
    const { emit } = this.context;
    const state = this.state;
    const usage = { ...state.overallUsage, requests: state.iterations };
    const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
      this.context.resolvedModel
    ];
    const estimatedCost = calculateTextCost(usage, pricing);

    emit({
      type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
      usage: withTotalInputTokens(usage),
      estimatedCost,
    });
  }

  // ── Context window enforcement ───────────────────────────

  /** Enforce token budget on messages before sending to provider. */
  enforceContextWindow(
    messages: ConversationMessage[],
    toolCount: number,
  ): ConversationMessage[] {
    const { modelDefinition, options = {}, emit } = this.context;
    const preEnforceCount = messages.length;
    const contextResult = ContextWindowManager.enforce(
      messages as ChatMessage[],
      {
        maxInputTokens:
          modelDefinition?.maxInputTokens ||
          (options._loadedContextLength as number | undefined) ||
          DEFAULT_MAX_INPUT_TOKENS,
        maxOutputTokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
        toolCount,
        locale: options?.locale as string | undefined || DEFAULT_LOCALE,
      },
    );
    if (contextResult.truncated) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
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
      return contextResult.messages as unknown as ConversationMessage[];
    }
    return messages;
  }

  // ── Provider stream creation ──────────────────────────────

  /**
   * Estimate total input tokens for an array of messages.
   * Uses the same ~4 chars/token heuristic as ContextWindowManager.
   */
  private estimateInputTokens(messages: ConversationMessage[]): number {
    let totalTokens = 0;
    for (const message of messages) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
            ? JSON.stringify(message.content)
            : "";
      totalTokens += estimateTokens(content);
      if ((message as ChatMessage).thinking) {
        totalTokens += estimateTokens(
          (message as ChatMessage).thinking as string,
        );
      }
      const toolCalls =
        (message as ChatMessage).toolCalls ||
        (message as ChatMessage).tool_calls;
      if (toolCalls) {
        totalTokens += estimateTokens(JSON.stringify(toolCalls));
      }
      if (
        (message as ChatMessage).images &&
        Array.isArray((message as ChatMessage).images)
      ) {
        totalTokens +=
          ((message as ChatMessage).images as unknown[]).length * UNITS.MILLISECONDS_PER_SECOND;
      }
    }
    return totalTokens;
  }

  /**
   * Dynamically clamp maxTokens so that input + output never exceeds
   * the model's context window. This is the industry-standard approach
   * (used by OpenAI SDKs, Cursor, Claude Code) to prevent 400 errors
   * from context overflow on models with finite context windows.
   *
   * Accounts for the FULL provider input budget:
   *   1. System prompt (passed as systemInstruction, NOT in messages)
   *   2. Conversation messages (the messages array)
   *   3. Tool schemas (serialized function definitions in the payload)
   *
   * Returns the clamped maxTokens value. If no clamping is needed,
   * returns the original value unchanged.
   */
  private clampOutputTokens(
    messages: ConversationMessage[],
    requestedMaxTokens: number | undefined,
  ): number | undefined {
    const contextWindow = this.resolveContextWindow();
    if (!contextWindow) return requestedMaxTokens;

    const tracker = this.ensureBudgetTracker();

    // 1. Conversation messages (raw heuristic, before calibration)
    const estimatedMessageTokens = this.estimateInputTokens(messages);
    this.lastEstimatedMessageTokens = estimatedMessageTokens;

    // 2. System prompt (sent as systemInstruction, invisible to messages)
    const systemPromptText =
      (this.context.options?.systemPrompt as string | undefined) || "";

    // 3. Tool schemas (serialized JSON function definitions)
    const toolSchemas = this.tools.finalTools;

    // Delegate budget computation and SSE emission to the tracker
    if (tracker) {
      const { clampedMaxTokens, adjustedInput, availableForOutput } =
        tracker.computeAndEmitEstimate(
          estimatedMessageTokens,
          systemPromptText,
          toolSchemas,
          requestedMaxTokens,
        );

      const calibrationRatio = tracker.getCalibrationRatio();

      // ── Always log the budget breakdown for diagnostics ──
      logger.info(
        `[OutputTokenClamp] Budget: contextWindow=${contextWindow}, ` +
          `messages=${estimatedMessageTokens}${calibrationRatio !== null ? ` (calibrated ×${calibrationRatio.toFixed(3)})` : ""}, ` +
          `systemPrompt=${estimateTokens(systemPromptText)} (${systemPromptText.length} chars), ` +
          `toolSchemas=${toolSchemas.length > 0 ? estimateTokens(JSON.stringify(toolSchemas)) : 0} (${toolSchemas.length} tools), ` +
          `adjusted=${adjustedInput}, available=${availableForOutput}, ` +
          `requested=${requestedMaxTokens}, ` +
          `willClamp=${requestedMaxTokens ? requestedMaxTokens > availableForOutput : false}`,
      );

      if (!requestedMaxTokens) return requestedMaxTokens;

      if (clampedMaxTokens !== requestedMaxTokens) {
        logger.warn(
          `[OutputTokenClamp] CLAMPING maxTokens ${requestedMaxTokens} → ${clampedMaxTokens}. ` +
            `Without clamp: ${adjustedInput + requestedMaxTokens} > ${contextWindow}.`,
        );
      }

      return clampedMaxTokens;
    }

    // Unreachable: ensureBudgetTracker always returns a tracker when
    // contextWindow is non-null (checked at method entry). This return
    // satisfies TypeScript's control flow analysis.
    return requestedMaxTokens;
  }

  /**
   * Create an LLM text stream from the provider.
   * Handles liveAPI fallback, message expansion, and dynamic output
   * token clamping to prevent context window overflow.
   *
   * Returns `null` when the pre-flight ContextExhaustionGuard determines
   * that the output budget is critically low (below MINIMUM_VIABLE_OUTPUT_TOKENS).
   * Callers must check for null and trigger exhaustion recovery instead
   * of attempting to consume a non-existent stream.
   *
   * Async because self-hosted providers (vLLM, llama-cpp, Ollama) may
   * need to query their model info endpoint to discover the context
   * window before clamping can run. This fixes the cold-start race
   * where the first iteration would skip clamping because the context
   * length hadn't been discovered yet.
   */
  async createProviderStream(
    messages: ConversationMessage[],
    passOptions: AgenticOptions,
  ): Promise<AsyncIterable<unknown> | null> {
    const { provider, resolvedModel, modelDefinition, signal } = this.context;

    // Pre-discover context window for self-hosted providers so
    // clampOutputTokens has the budget available on the first iteration
    if (provider.discoverContextWindow) {
      await provider.discoverContextWindow(
        resolvedModel,
        this.context.options,
      );
    }

    const clampedMaxTokens = this.clampOutputTokens(
      messages,
      passOptions.maxTokens,
    );

    // ── Pre-flight context exhaustion guard ──────────────────
    // If the clamped output budget is below the minimum viable threshold,
    // the model cannot produce a complete response (tool call JSON needs
    // 500–2K tokens + reasoning overhead). Return null to signal the
    // caller to skip the provider call and trigger exhaustion recovery.
    const contextWindow = this.resolveContextWindow();
    if (isContextExhausted(clampedMaxTokens)) {
      logContextExhaustion(
        clampedMaxTokens ?? 0,
        contextWindow ?? 0,
        "BaseAgenticHarness",
      );
      emitContextExhaustedStatus(
        this.context.emit,
        clampedMaxTokens ?? 0,
        contextWindow ?? 0,
      );
      return null;
    }

    const clampedPassOptions =
      clampedMaxTokens !== passOptions.maxTokens
        ? { ...passOptions, maxTokens: clampedMaxTokens }
        : passOptions;

    const expandedMessages = expandMessagesForFunctionCall(
      messages as ChatMessage[],
      {
        filterDeleted: false,
      },
    );

    const providerOptions = {
      ...clampedPassOptions,
      signal,
      // Stable per-conversation prompt-cache key (used by OpenAI as
      // prompt_cache_key for cache-shard routing; ignored elsewhere).
      promptCacheKey:
        this.context.agentConversationId ||
        (this.context.conversationId as string | undefined) ||
        undefined,
    };

    for (const optionKey of [
      "_loadedContextLength",
      "_loadedEvalBatchSize",
      "_loadedPhysicalBatchSize",
    ]) {
      Object.defineProperty(providerOptions, optionKey, {
        get: () => this.context.options?.[optionKey],
        set: (value) => {
          if (this.context.options) {
            this.context.options[optionKey] = value;
          }
        },
        configurable: true,
        enumerable: true,
      });
    }

    // Shared transient-error retry for ALL providers (fetch-based providers
    // previously had none). Retries fire only when zero chunks were yielded —
    // once output reached the consumer, a retry would duplicate streamed text
    // and re-execute tool calls.
    const createStream = () =>
      modelDefinition?.liveAPI && provider.generateTextStreamLive
        ? provider.generateTextStreamLive(
            expandedMessages,
            resolvedModel,
            providerOptions,
          )
        : provider.generateTextStream(
            expandedMessages,
            resolvedModel,
            providerOptions,
          );

    // Create the first stream eagerly (preserves call-time semantics for
    // providers that validate/dispatch on invocation); retries create fresh
    // streams via the factory.
    let initialStream: AsyncIterable<unknown> | null = createStream();
    return streamWithRetries(
      () => {
        if (initialStream) {
          const firstStream = initialStream;
          initialStream = null;
          return firstStream;
        }
        return createStream();
      },
      {
        signal,
        label: this.context.providerName,
      },
    );
  }

  // ── Stream consumption ────────────────────────────────────

  /**
   * Consume an LLM stream, routing each chunk through `processStreamChunk`.
   * Handles abort signals, repetition detection, and stream teardown.
   */
  public async consumeStream(
    stream: AsyncIterable<unknown>,
    pass: PassState,
    allowedToolNames: Set<string>,
  ): Promise<void> {
    // Reset the detector for each new stream (each LLM response is independent)
    this.repetitionDetector.reset();

    // Chunk-idle watchdog: a provider that stalls without closing the socket
    // must fail the pass instead of hanging the turn until the housekeeping
    // sweep. Configurable per request; generous default for local prefill.
    const idleTimeoutMilliseconds =
      typeof this.context.options?.streamIdleTimeoutMilliseconds === "number"
        ? (this.context.options.streamIdleTimeoutMilliseconds as number)
        : undefined;
    const watchedStream = withIdleTimeout(
      stream,
      idleTimeoutMilliseconds,
      this.context.providerName,
    );

    for await (const chunk of watchedStream) {
      const result = await this.processStreamChunk(
        chunk as StreamChunk,
        pass,
        allowedToolNames,
      );
      if (result.action === "break") {
        const returnable = stream as AsyncGenerator<unknown>;
        if (typeof returnable.return === "function")
          returnable.return(undefined);
        break;
      }
      if (result.action === "repetitionDetected") {
        pass.repetitionDetected = true;
        const returnable = stream as AsyncGenerator<unknown>;
        if (typeof returnable.return === "function")
          returnable.return(undefined);
        break;
      }
    }
  }

  // ── Session tracking helpers ──────────────────────────────

  /** Register a request with ConversationGenerationTracker. */
  registerTrackerRequest(passRequestId: string): void {
    const {
      providerName,
      resolvedModel,
      parentAgentConversationId,
      agentConversationId,
    } = this.context;
    const resolvedParent = parentAgentConversationId;
    const resolvedAgent = agentConversationId;
    ConversationGenerationTracker.register(
      this.trackerConversationId,
      passRequestId,
      {
        provider: providerName,
        model: resolvedModel,
        source: resolvedParent ? "sub-agent" : "orchestrator",
        subAgentId: resolvedParent ? (resolvedAgent as string) : null,
      },
    );
  }

  // ── Context budget tracking ───────────────────────────────

  /**
   * Resolve the model's context window from all available sources.
   * Returns null when no source has the value yet (self-hosted cold start).
   */
  private resolveContextWindow(): number | null {
    return (
      this.context.modelDefinition?.maxInputTokens ||
      (this.context.options?._loadedContextLength as number | undefined) ||
      null
    );
  }

  /**
   * Lazily create or update the ContextBudgetTracker.
   *
   * The context window isn't always available at construction time:
   *   - Cloud providers (Gemini, OpenAI): known statically from modelDefinition
   *   - Self-hosted cached (vLLM 2nd+ req): cached in ContextLengthDiscovery
   *   - Self-hosted cold (vLLM 1st req): discovered mid-stream by provider
   *
   * This method is called from both clampOutputTokens (pre-stream) and
   * the usage handler (post-stream), so the tracker is created at
   * whichever point the context window first becomes available.
   */
  private ensureBudgetTracker(): ContextBudgetTracker | null {
    const contextWindow = this.resolveContextWindow();
    if (!contextWindow) return null;

    if (!this.budgetTracker) {
      this.budgetTracker = new ContextBudgetTracker(
        this.context.emit,
        contextWindow,
      );
    } else {
      this.budgetTracker.updateContextWindow(contextWindow);
    }
    return this.budgetTracker;
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
    chunk: StreamChunk,
    pass: PassState,
    allowedToolNames: Set<string>,
  ): ChunkAction | Promise<ChunkAction> {
    const { emit, signal } = this.context;
    const state = this.state;
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
      const tracker = this.ensureBudgetTracker();
      if (tracker) {
        tracker.recordRealUsage(
          usageChunk,
          this.lastEstimatedMessageTokens,
        );
      }

      return { action: "continue" };
    }

    // ── Rate limits ──────────────────────────────────────
    if (streamChunk?.type === "rateLimits") {
      state.lastRateLimits = streamChunk.rateLimits || null;
      return { action: "continue" };
    }

    // ── Stop reason (truncation detection) ───────────────
    if (streamChunk?.type === "stopReason") {
      pass.stopReason = (streamChunk.stopReason as string) || undefined;
      return { action: "continue" };
    }

    // ── Thinking ─────────────────────────────────────────
    if (streamChunk?.type === "thinking") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
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
      this.maybeEmitProgress();

      // ── Repetition detection on thinking stream ────────
      const thinkingRepetitionVerdict = this.repetitionDetector.append(
        streamChunk.content || "",
      );
      if (thinkingRepetitionVerdict.isDegenerate) {
        logger.warn(
          `[RepetitionDetector] Degenerate repetition detected in thinking stream on iteration ${state.iterations} — ` +
            `metric=${thinkingRepetitionVerdict.metric}, confidence=${thinkingRepetitionVerdict.confidence.toFixed(2)}, ` +
            `pattern="${(thinkingRepetitionVerdict.pattern || "").slice(0, 80)}"`,
        );
        return { action: "repetitionDetected", verdict: thinkingRepetitionVerdict };
      }

      return { action: "continue" };
    }

    // ── Thinking signature (Anthropic) ───────────────────
    if (streamChunk?.type === "thinking_signature") {
      pass.thinkingSignature = streamChunk.signature || "";
      return { action: "continue" };
    }

    // ── Tool call start (early disclosure) ─────────────────
    if (streamChunk?.type === "toolCallStart") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      this._sealThinkingPhase(pass);
      emit({
        type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
        tool: {
          name: streamChunk.name || "",
          args: {},
          id: streamChunk.id || "",
        },
        status: "streaming",
        timestamp: Date.now(),
      });
      this.maybeEmitProgress();
      return { action: "continue" };
    }

    // ── Tool call argument delta ─────────────────────────
    if (streamChunk?.type === "toolCallDelta") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      state.overallOutputCharacters += streamChunk.characters as number;
      if (pass.requestId) {
        ConversationGenerationTracker.recordChunkTiming(
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
      this._sealThinkingPhase(pass);
      if (pass.requestId) {
        ConversationGenerationTracker.recordChunkTiming(
          pass.requestId,
          JSON.stringify(streamChunk.args || {}).length,
        );
      }
      this.maybeEmitProgress();

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
          this._trackToolDisplaySegment(toolCallId);

          WebhookEventBus.emit("request.tool_call.started", {
            requestId: this.context.requestId || null,
            toolName,
            toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
            toolCallId,
            toolArgs: streamChunk.args || {},
            agent: this.context.agent || null,
            conversationId: this.context.conversationId || null,
            agentConversationId: this.context.agentConversationId || null,
            project: this.context.project,
            username: this.context.username,
            provider: this.context.providerName,
            model: this.context.resolvedModel,
            iteration: this.state.iterations,
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
            requestId: this.context.requestId || null,
            toolName,
            toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
            toolCallId,
            toolResult: streamChunk.result || null,
            durationMilliseconds: null,
            status: streamChunk.status,
            agent: this.context.agent || null,
            conversationId: this.context.conversationId || null,
            agentConversationId: this.context.agentConversationId || null,
            project: this.context.project,
            username: this.context.username,
            provider: this.context.providerName,
            model: this.context.resolvedModel,
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
        ...(streamChunk.argsParseError === true && {
          _argsParseError: true,
          _rawArgs:
            typeof streamChunk.rawArgs === "string"
              ? streamChunk.rawArgs
              : undefined,
        }),
      };
      pass.pendingToolCalls.push(toolCall);
      state.streamedToolCalls.push({ ...toolCall });
      this._trackToolDisplaySegment(standardToolCallId);
      emit({
        type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
        tool: {
          name: toolName,
          args: streamChunk.args || {},
          id: standardToolCallId,
        },
        toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
        status: "calling",
        timestamp: Date.now(),
      });
      WebhookEventBus.emit("request.tool_call.started", {
        requestId: this.context.requestId || null,
        toolName,
        toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
        toolCallId: standardToolCallId,
        toolArgs: streamChunk.args || {},
        agent: this.context.agent || null,
        conversationId: this.context.conversationId || null,
        agentConversationId: this.context.agentConversationId || null,
        project: this.context.project,
        username: this.context.username,
        provider: this.context.providerName,
        model: this.context.resolvedModel,
        iteration: this.state.iterations,
      });
      return { action: "toolCall", toolCall: toolCall };
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
    this._recordFirstToken(pass);
    this._recordTiming(pass);
    this._sealThinkingPhase(pass);
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
    this.maybeEmitProgress();

    // ── Repetition detection on text stream ──────────────
    const textRepetitionVerdict = this.repetitionDetector.append(rawChunkString);
    if (textRepetitionVerdict.isDegenerate) {
      logger.warn(
        `[RepetitionDetector] Degenerate repetition detected in text stream on iteration ${state.iterations} — ` +
          `metric=${textRepetitionVerdict.metric}, confidence=${textRepetitionVerdict.confidence.toFixed(2)}, ` +
          `pattern="${(textRepetitionVerdict.pattern || "").slice(0, 80)}"`,
      );
      return { action: "repetitionDetected", verdict: textRepetitionVerdict };
    }

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
      conversationId,
      agentConversationId,
      parentAgentConversationId,
      traceId,
    } = this.context;
    const state = this.state;
    const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[resolvedModel];

    const passTotalSec = (performance.now() - pass.start) / 1000;
    const passGenerationSec =
      pass.firstTokenTime && pass.generationEnd
        ? (pass.generationEnd - pass.firstTokenTime) / 1000
        : null;
    const passTokensPerSec = calculateTokensPerSec(
      pass.usage.outputTokens,
      passGenerationSec,
    );
    const passEstimatedCost = calculateTextCost(pass.usage, pricing);

    // Accumulate per-pass thinking/content phase durations into overall totals
    if (pass.thinkingStartTime != null) {
      const effectiveThinkingEnd = pass.thinkingEndTime ?? pass.generationEnd;
      if (effectiveThinkingEnd != null) {
        state.overallThinkingDurationSeconds += (effectiveThinkingEnd - pass.thinkingStartTime) / 1000;
      }
      if (pass.thinkingEndTime != null && pass.generationEnd != null) {
        state.overallContentDurationSeconds += (pass.generationEnd - pass.thinkingEndTime) / 1000;
      }
    }

    // Two-phase completion: if we pre-inserted a pending skeleton on
    // iteration start, update it in-place instead of inserting a new doc.
    const legacyPayload = {
      requestId: `${this.context.requestId}-${state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      clientIp: this.context.clientIp,
      agent: agent || null,
      provider: providerName,
      model: resolvedModel,
      conversationId,
      agentConversationId,
      parentAgentConversationId: parentAgentConversationId || null,
      traceId: traceId || null,
      success: true,
      usage: pass.usage,
      estimatedCost: passEstimatedCost,
      tokensPerSec: passTokensPerSec,
      timeToGenerationSec: pass.firstTokenTime
        ? (pass.firstTokenTime - pass.start) / 1000
        : null,
      generationSec: passGenerationSec,
      totalSec: passTotalSec,
      options: pass.options,
      messages: currentMessages as MessagePayload[],
      text: pass.streamedText,
      thinking: pass.streamedThinking,
      images: pass.streamedImages,
      toolCalls: pass.pendingToolCalls as ToolCallPayload[],
      outputCharacters: pass.outputCharacters,
      agenticIteration: state.iterations,
    };

    const fullPayload: import("../RequestLogger.ts").LogParams = {
      requestId: `${this.context.requestId}-${state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      clientIp: this.context.clientIp,
      agent: agent || null,
      provider: providerName,
      model: resolvedModel,
      conversationId,
      agentConversationId,
      parentAgentConversationId: parentAgentConversationId || null,
      traceId: traceId || null,
      toolsUsed: pass.pendingToolCalls.length > 0,
      toolDisplayNames:
        pass.pendingToolCalls.length > 0
          ? [...new Set(pass.pendingToolCalls.map((toolCall) => toolCall.name))]
          : [],
      toolApiNames:
        pass.pendingToolCalls.length > 0
          ? [...new Set(pass.pendingToolCalls.map((toolCall) => toolCall.name))]
          : [],
      success: true,
      // RequestLogger derives the top-level token fields from usage
      // (inputTokens = cache-inclusive total, cache fields unconditional).
      usage: pass.usage,
      estimatedCost: passEstimatedCost,
      tokensPerSec: passTokensPerSec,
      temperature: (pass.options?.temperature as number) ?? null,
      maxTokens: (pass.options?.maxTokens as number) ?? null,
      topP: (pass.options?.topP as number) ?? null,
      topK: (pass.options?.topK as number) ?? null,
      frequencyPenalty: (pass.options?.frequencyPenalty as number) ?? null,
      presencePenalty: (pass.options?.presencePenalty as number) ?? null,
      stopSequences: (pass.options?.stopSequences as string[]) ?? null,
      messageCount: currentMessages?.length ?? 0,
      inputCharacters:
        currentMessages?.reduce(
          (sum, message) =>
            sum +
            (typeof message.content === "string" ? message.content.length : 0),
          0,
        ) ?? 0,
      outputCharacters: pass.outputCharacters,
      timeToGeneration: pass.firstTokenTime
        ? roundMilliseconds((pass.firstTokenTime - pass.start) / 1000)
        : null,
      generationTime:
        passGenerationSec !== null
          ? roundMilliseconds(passGenerationSec)
          : null,
      totalTime: roundMilliseconds(passTotalSec),
      requestPayload: {
        messages:
          currentMessages?.map((message) => ({
            role: (message as Record<string, unknown>).role,
            content: (message as Record<string, unknown>).content,
          })) ?? [],
        agenticIteration: state.iterations,
      },
      responsePayload: {
        text: pass.streamedText || null,
        thinking: pass.streamedThinking || null,
        ...(pass.streamedImages.length > 0
          ? { images: pass.streamedImages }
          : {}),
        toolCalls:
          pass.pendingToolCalls.length > 0
            ? pass.pendingToolCalls.map((toolCall) => ({
                name: toolCall.name,
                id: toolCall.id,
                args: toolCall.args,
              }))
            : null,
        usage: pass.usage,
      },
    };

    // Fire-and-forget for streaming latency, but track the full chain so
    // finalize() can await it — the conversation rollup aggregates the
    // requests collection and must see every iteration of this turn.
    const requestLogWrite = pass.pendingRequestDocumentIdPromise
      .then((pendingRequestDocumentId) => {
        if (pendingRequestDocumentId) {
          return RequestLogger.completePending(
            pendingRequestDocumentId,
            fullPayload,
          ).catch((error: Error) =>
            logger.error(
              `[AgenticLoopService] Failed to complete pending request: ${errorMessage(error)}`,
            ),
          );
        }
        return RequestLogger.logChatGeneration(legacyPayload).catch(
          (error: Error) =>
            logger.error(
              `[AgenticLoopService] Failed to log intermediate request: ${errorMessage(error)}`,
            ),
        );
      })
      .catch((error: Error) => {
        logger.error(
          `[BaseAgenticHarness] Error resolving pendingRequestDocumentIdPromise: ${errorMessage(error)}`,
        );
        return RequestLogger.logChatGeneration(legacyPayload).catch(
          (loggingError: Error) =>
            logger.error(
              `[AgenticLoopService] Failed to log intermediate request on fallback: ${errorMessage(loggingError)}`,
            ),
        );
      });
    this.state.pendingRequestLogWrites.push(requestLogWrite);
  }

  // ── Per-iteration pass state factory ──────────────────────

  /** Create a fresh per-iteration pass state object. */
  createPassState(passOptions: AgenticOptions): PassState {
    const {
      resolvedModel,
      providerName,
      project,
      username,
      agent,
      conversationId,
      agentConversationId,
      parentAgentConversationId,
      traceId,
      requestId,
    } = this.context;

    const pendingPromise = RequestLogger.insertPending({
      requestId: `${requestId}-${this.state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      clientIp: this.context.clientIp,
      agent: agent || null,
      harness: (passOptions?.harness as string) || null,
      provider: providerName,
      model: resolvedModel,
      conversationId,
      traceId: traceId || null,
      agentConversationId: agentConversationId || null,
      parentAgentConversationId: parentAgentConversationId || null,
      agenticIteration: this.state.iterations,
    }).catch((error: Error) => {
      logger.error(
        `[BaseAgenticHarness] Failed to insert pending request: ${errorMessage(error)}`,
      );
      return null;
    });

    const passState: PassState = {
      streamedText: "",
      finalStreamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [],
      streamedImages: [],
      start: performance.now(),
      firstTokenTime: null,
      generationEnd: null,
      thinkingStartTime: null,
      thinkingEndTime: null,
      outputCharacters: 0,
      usage: createUsageAccumulator(),
      options: passOptions,
      requestId: null, // set after tracker registration
      pendingRequestDocumentIdPromise: pendingPromise,
    };

    return passState;
  }

  // ── Finalization ──────────────────────────────────────────

  /**
   * Shared finalization logic — cost calculation, persistence,
   * done event, sub-agent snapshot persistence, and afterResponse hooks.
   *
   * Lifted from ReActHarness so all harnesses share the same
   * finalization path without copy-paste.
   */
  protected async finalize(
    currentMessages: ConversationMessage[],
    hooks: AgentHooks,
    finalizeOptions?: { deferDoneEmission?: boolean },
  ): Promise<DeferredDoneEvent | null> {
    const context = this.context;
    const state = this.state;

    if (context.signal?.aborted) {
      state.conversationOutcome = "aborted";
    }

    // Ensure every iteration's request-log write has landed before
    // persistence — the conversation rollup aggregates the requests
    // collection, so a still-in-flight completePending would undercount.
    if (state.pendingRequestLogWrites.length > 0) {
      await Promise.allSettled(state.pendingRequestLogWrites);
    }

    const { agentConversationId, conversationId, project, username: _username } = context;
    const requestStart = context.requestStart ?? performance.now();

    const now = performance.now();
    state.overallUsage.requests = state.iterations;

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    // If the last message of the original context was already persisted (e.g. background timer reminder or scheduled task),
    // we slice from originalMessageCount so we don't append it again. Otherwise, we slice from
    // originalMessageCount - 1 to capture the user's triggering message for this turn.
    const newTurnMessages = computeNewTurnMessages(
      context.messages,
      currentMessages,
      state.originalMessageCount,
    );

    logger.info(
      `[AgenticLoop] finalize: conversation=${agentConversationId} conversationId=${conversationId} project=${project} ` +
        `originalMillisecondsgCount=${state.originalMessageCount} currentMillisecondsgs=${currentMessages.length} ` +
        `newTurnMillisecondsgs=${newTurnMessages.length} ` +
        `roles=[${newTurnMessages.map((conversationMessage) => conversationMessage.role).join(",")}] ` +
        `text=${(state.finalStreamedText || "").length}chars`,
    );

    const deferredDoneEvent = await finalizeTextGeneration(
      context as FinalizerContext,
      {
        text: state.finalStreamedText.trim(),
        thinking: state.streamedThinking.trim() || "",
        images: state.streamedImages,
        toolCalls: state.streamedToolCalls,
        audioChunks: state.streamedAudioChunks,
        audioSampleRate: state.audioSampleRate,
        usage: state.overallUsage,
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
        resolvedEnabledTools: this.tools.resolvedEnabledTools,
        contextBudget: this.budgetTracker?.getSnapshot() ?? undefined,
        thinkingDurationSeconds: state.overallThinkingDurationSeconds > 0
          ? roundMilliseconds(state.overallThinkingDurationSeconds)
          : null,
        contentDurationSeconds: state.overallContentDurationSeconds > 0
          ? roundMilliseconds(state.overallContentDurationSeconds)
          : null,
        conversationOutcome: state.conversationOutcome || null,
      },
      newTurnMessages as MessagePayload[],
      finalizeOptions,
    );

    // Sub-agent snapshots are now persisted to the dedicated sub_agents
    // collection by OrchestratorService on spawn and completion — no need
    // to write the embedded subAgents[] array here anymore.

    // afterResponse hook (fire-and-forget)
    hooks
      .run("afterResponse", context, {
        text: state.finalStreamedText,
        thinking: state.streamedThinking,
        toolCalls: state.streamedToolCalls,
        messages: currentMessages,
        conversationOutcome: state.conversationOutcome,
      })
      .catch((error: Error) =>
        logger.error(
          `[AgenticLoopService] afterResponse hooks failed: ${errorMessage(error)}`,
        ),
      );

    // Append the final assistant message so that the in-memory messages array
    // returned to the Orchestrator/caller includes the final text response.
    currentMessages.push({
      role: "assistant",
      content: state.finalStreamedText.trim(),
      ...(state.streamedThinking.trim() && {
        thinking: state.streamedThinking.trim(),
      }),
      ...(state.streamedImages.length > 0 && { images: state.streamedImages }),
      ...(state.streamedToolCalls.length > 0 && {
        toolCalls: state.streamedToolCalls.map((toolCall) => ({
          id: toolCall.id || null,
          responsesItemId: toolCall.responsesItemId || undefined,
          name: toolCall.name,
          args: toolCall.args,
          thoughtSignature: toolCall.thoughtSignature || undefined,
          reasoningItem: toolCall.reasoningItem || undefined,
          result: toolCall.result,
        })),
      }),
    });

    return deferredDoneEvent;
  }

  // ── Private helpers ───────────────────────────────────────

  private _recordFirstToken(pass: PassState): void {
    const state = this.state;
    if (!state.overallFirstTokenTime)
      state.overallFirstTokenTime = performance.now();
    if (!pass.firstTokenTime) {
      pass.firstTokenTime = performance.now();
      const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
      if (pass.requestId)
        ConversationGenerationTracker.update(pass.requestId, { ttft: ttftSec });
      this.context.emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_STARTED,
        timeToFirstToken: ttftSec,
      });
    }
  }

  private _recordTiming(pass: PassState): void {
    this.state.overallGenerationEnd = performance.now();
    pass.generationEnd = performance.now();
  }

  private _trackToolDisplaySegment(toolCallId: string): void {
    const state = this.state;
    const lastSeg = state.displaySegments[state.displaySegments.length - 1];
    if (state.lastDisplaySegType === "tools" && lastSeg?.type === "tools") {
      lastSeg.toolIds.push(toolCallId);
    } else {
      state.displaySegments.push({ type: "tools", toolIds: [toolCallId] });
      state.lastDisplaySegType = "tools";
    }
  }

  /** Seal the thinking phase — record thinkingEndTime if thinking was active and not yet sealed. */
  private _sealThinkingPhase(pass: PassState): void {
    if (pass.thinkingStartTime !== null && pass.thinkingEndTime === null) {
      pass.thinkingEndTime = performance.now();
    }
  }

  private async _handleImageChunk(
    chunk: StreamChunk,
    pass: PassState,
  ): Promise<ChunkAction> {
    const { emit, project, username } = this.context;
    const state = this.state;
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
}
