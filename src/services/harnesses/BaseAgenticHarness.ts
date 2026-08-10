import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import {
  streamWithRetries,
  withIdleTimeout,
  parseContextOverflowError,
} from "#src/utils/ProviderStreamResilience";
import { getDocumentContextText } from "#src/utils/documentContext";
import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import RepetitionDetector from "#src/services/RepetitionDetector";
import {
  createUsageAccumulator,
  calculateTextCost,
  estimateTokens,
  withTotalInputTokens,
} from "#src/utils/CostCalculator";
import { calculateTokensPerSec } from "#src/utils/math";
import { getPricing, MODALITY_TYPES } from "#src/config";
import ContextWindowManager from "#src/services/ContextWindowManager";
import ContextBudgetTracker from "./ContextBudgetTracker.ts";
import {
  isContextExhausted,
  logContextExhaustion,
  emitContextExhaustedStatus,
} from "./lifecycle/ContextExhaustionGuard.ts";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
} from "#src/constants/TokenBudgetDefaults";
import ConversationGenerationTracker from "#src/services/ConversationGenerationTracker";
import ConversationStatusRegistry from "#src/services/ConversationStatusRegistry";
import RequestLogger from "#src/services/RequestLogger";
import { resolveMessageMediaReferences } from "#src/services/MediaResolutionService";
import { getMaxImageDimensionForModel } from "#src/utils/media";
import { UNITS, DEFAULT_LOCALE } from "#src/constants";
import {
  finalizeTextGeneration,
  type FinalizerContext,
  type DeferredDoneEvent,
  computeNewTurnMessages,
  sanitizeMessagesForPersistence,
  getCollectionOpts,
} from "./lifecycle/Finalizer.ts";
import { routeStreamChunk } from "./lifecycle/StreamChunkRouter.ts";
import { substituteToolOutputTokens } from "./lifecycle/ToolOutputSubstituter.ts";
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
import type { ChatMessage } from "#src/types/admin";
import type { MessagePayload, ToolCallPayload } from "#src/services/conversation/types";
import type {
  AgenticContext,
  AgenticOptions,
  ResolvedTools,
  PassState,
  ChunkAction,
  ConversationMessage,
  StreamChunk,
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

  /** Calibrated full-prompt estimate (messages + system + tools + skills)
   *  from the last clampOutputTokens call — seeds the tracker's live cost
   *  estimate before the provider reports real input usage. */
  private lastEstimatedTotalInputTokens = 0;

  /** Most recently registered tracker request id for this harness. */
  private lastTrackerRequestId: string | null = null;

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
          content: wrapSystemMessage(
            SYSTEM_MESSAGE_TAGS.TOOL_UPDATE,
            `${headerText}\n\n` +
              `${availableText}\n\n` +
              addendumDocumentation +
              (policyAddendum
                ? `\n\n${guidelinesHeader}\n\n${policyAddendum}`
                : ""),
          ),
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
      state.hwmEstimatedCost = Math.max(
        state.hwmEstimatedCost,
        stats.estimatedCost || 0,
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
        estimatedCost: state.hwmEstimatedCost,
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
          estimatedCost: state.hwmEstimatedCost,
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
      // Document attachments inline their primed text (or a pointer) at the
      // provider layer — invisible in message.content, so count it here.
      // Verified failure without this: a 30KB inlined JSON left the clamp
      // estimating 34 message tokens while the provider saw ~10K.
      const documents = (message as ChatMessage).documents;
      if (Array.isArray(documents)) {
        for (const documentReference of documents) {
          if (typeof documentReference === "string") {
            totalTokens += estimateTokens(
              getDocumentContextText(documentReference),
            );
          }
        }
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
    this.lastEstimatedTotalInputTokens = estimatedMessageTokens;

    // 2. System prompt (sent as systemInstruction, invisible to messages)
    const systemPromptText =
      (this.context.options?.systemPrompt as string | undefined) || "";

    // 3. Tool schemas (serialized JSON function definitions)
    const toolSchemas = this.tools.finalTools;

    // 4. Injected skills text (lives inside the messages array; the tracker
    //    carves it out of the message estimate as its own budget category)
    const skillsText =
      (this.context.options?._skillsText as string | undefined) || "";
    const skillTokens = skillsText ? estimateTokens(skillsText) : 0;

    // Delegate budget computation and SSE emission to the tracker
    if (tracker) {
      const { clampedMaxTokens, adjustedInput, availableForOutput } =
        tracker.computeAndEmitEstimate(
          estimatedMessageTokens,
          systemPromptText,
          toolSchemas,
          requestedMaxTokens,
          skillTokens,
        );

      this.lastEstimatedTotalInputTokens = adjustedInput;

      const calibrationRatio = tracker.getCalibrationRatio();

      // ── Always log the budget breakdown for diagnostics ──
      logger.info(
        `[OutputTokenClamp] Budget: contextWindow=${contextWindow}, ` +
          `messages=${estimatedMessageTokens}${calibrationRatio !== null ? ` (calibrated ×${calibrationRatio.toFixed(3)})` : ""}, ` +
          `systemPrompt=${estimateTokens(systemPromptText)} (${systemPromptText.length} chars), ` +
          `toolSchemas=${toolSchemas.length > 0 ? estimateTokens(JSON.stringify(toolSchemas)) : 0} (${toolSchemas.length} tools), ` +
          `skills=${skillTokens}, ` +
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

    // Resolve media/attachments for the provider payload — folds client
    // `files[]` into resolvable media fields, resolves minio:// refs to
    // provider-ready data, and primes small text documents for inlining.
    // The /chat path does this in prepareGenerationContext; the agent path
    // must do it here since the message array evolves across iterations
    // (resolution is idempotent, and priming/conversion are cached).
    // Mutates `messages` in place to compact storage refs and returns the
    // provider copy. A resolution failure must never kill the turn — fall
    // back to the unresolved messages.
    let resolvedMessages = messages;
    try {
      resolvedMessages = await resolveMessageMediaReferences(
        messages,
        this.context.project,
        this.context.username,
        { maxImageDimension: getMaxImageDimensionForModel(resolvedModel) },
      );
    } catch (error) {
      console.warn(
        "[BaseAgenticHarness] media resolution failed; sending unresolved messages:",
        error instanceof Error ? error.message : error,
      );
    }

    // Pre-discover context window for self-hosted providers so
    // clampOutputTokens has the budget available on the first iteration
    if (provider.discoverContextWindow) {
      await provider.discoverContextWindow(
        resolvedModel,
        this.context.options,
      );
    }

    const clampedMaxTokens = this.clampOutputTokens(
      resolvedMessages,
      passOptions.maxTokens,
    );

    // Seed the tracker's live cost estimate with the calibrated prompt
    // size so input-side cost ticks immediately, before the provider
    // reports real usage (OpenAI and most local runtimes only report
    // usage at the end of the stream).
    if (this.lastTrackerRequestId && this.lastEstimatedTotalInputTokens > 0) {
      ConversationGenerationTracker.setEstimatedInputTokens(
        this.lastTrackerRequestId,
        this.lastEstimatedTotalInputTokens,
      );
    }

    // ── Pre-flight context exhaustion guard ──────────────────
    // If clamping had to reduce the output budget below the minimum viable
    // threshold, the model cannot produce a complete response (tool call
    // JSON needs 500–2K tokens + reasoning overhead). Return null to signal
    // the caller to skip the provider call and trigger exhaustion recovery.
    // A caller-requested maxTokens below the threshold is NOT exhaustion —
    // only fire when window pressure forced the reduction.
    const contextWindow = this.resolveContextWindow();
    const wasClampedByWindow =
      passOptions.maxTokens != null && clampedMaxTokens !== passOptions.maxTokens;
    if (wasClampedByWindow && isContextExhausted(clampedMaxTokens)) {
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
      resolvedMessages as ChatMessage[],
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

    // Context-overflow recovery: the pre-flight clamp works from a chars/4
    // heuristic that dense content (JSON, hex, code) can undershoot far
    // beyond any fixed margin, and vLLM's rejection only reports a LOWER
    // BOUND on the real prompt size (window - max_tokens + 1). So on an
    // overflow rejection, shrink maxTokens — halving guarantees geometric
    // convergence even when the reported numbers understate the overshoot —
    // and retry. The factory below re-reads providerOptions on every call,
    // so the mutation reaches the next attempt.
    const recoverFromContextOverflow = (error: unknown): boolean => {
      const overflow = parseContextOverflowError(error);
      if (!overflow) return false;
      const currentMaxTokens = providerOptions.maxTokens;
      if (
        typeof currentMaxTokens !== "number" ||
        currentMaxTokens <= MINIMUM_CLAMPED_OUTPUT_TOKENS
      ) {
        return false;
      }
      const halvedMaxTokens = Math.floor(currentMaxTokens / 2);
      const boundFromReport =
        overflow.inputTokens !== null
          ? overflow.contextWindow -
            overflow.inputTokens -
            OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS
          : Number.POSITIVE_INFINITY;
      const reducedMaxTokens = Math.max(
        Math.min(halvedMaxTokens, boundFromReport),
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
      );
      if (reducedMaxTokens >= currentMaxTokens) return false;
      logger.warn(
        `[ContextOverflowRecovery] ${this.context.providerName} rejected the request ` +
          `(window=${overflow.contextWindow}, reported input≥${overflow.inputTokens ?? "?"}). ` +
          `Retrying with maxTokens ${currentMaxTokens} → ${reducedMaxTokens}.`,
      );
      providerOptions.maxTokens = reducedMaxTokens;
      return true;
    };

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
        tryRecoverFromError: recoverFromContextOverflow,
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
        this._teardownStream(stream);
        break;
      }
      if (result.action === "repetitionDetected") {
        pass.repetitionDetected = true;
        this._teardownStream(stream);
        break;
      }
    }
  }

  /**
   * Tear down a provider stream after an early exit (abort, repetition).
   * The return() promise is intentionally not awaited — a wedged stream's
   * return() may never resolve — but it MUST carry a rejection handler:
   * an unhandled rejection here kills the whole process (observed when
   * users stop a generation mid-tool-call), wiping every in-flight turn.
   */
  private _teardownStream(stream: AsyncIterable<unknown>): void {
    const returnable = stream as AsyncGenerator<unknown>;
    if (typeof returnable.return !== "function") return;
    try {
      void Promise.resolve(returnable.return(undefined)).catch(() => {
        /* stream teardown is best-effort */
      });
    } catch {
      /* stream teardown is best-effort */
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
    this.lastTrackerRequestId = passRequestId;
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
   * Full routing logic lives in lifecycle/StreamChunkRouter.ts; this
   * delegation preserves the public API for harnesses and tests.
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
    return routeStreamChunk(this, chunk, pass, allowedToolNames);
  }

  // ── Iteration logging ─────────────────────────────────────

  /** Log a single iteration to the request log. */
  logIteration(pass: PassState, currentMessages: ConversationMessage[]): void {
    const {
      resolvedModel,
      providerName,
      project,
      username,
      profileId,
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
    const requestLogPayload = {
      requestId: `${this.context.requestId}-${state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      profileId,
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
      profileId,
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
        return RequestLogger.logChatGeneration(requestLogPayload).catch(
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
        return RequestLogger.logChatGeneration(requestLogPayload).catch(
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
      profileId,
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
      profileId,
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

  // ── Crash-safety checkpoint ───────────────────────────────

  /**
   * Persist a shadow copy of the turn's accumulated messages so far.
   *
   * Messages only reach MongoDB at finalize — before this checkpoint
   * existed, a process crash/restart mid-turn (observed when users stop a
   * generation mid-tool-call) lost the ENTIRE turn including the user's
   * message, leaving the conversation as an empty stub.
   *
   * Called at the top of each loop iteration. Writes to a transient
   * `turnCheckpoint` field (never `messages`, so live clients see no
   * mid-turn duplication); the finalize append atomically clears it, and
   * startup recovery merges any orphaned checkpoint into `messages`.
   *
   * Best-effort: a failed checkpoint must never break the turn.
   */
  protected async checkpointTurnProgress(
    currentMessages: ConversationMessage[],
  ): Promise<void> {
    const { conversationId, project, username, agent } = this.context;
    if (!conversationId) return;
    try {
      const newTurnMessages = computeNewTurnMessages(
        this.context.messages,
        currentMessages,
        this.state.originalMessageCount,
      );
      const sanitizedMessages = sanitizeMessagesForPersistence(
        newTurnMessages as MessagePayload[],
      );
      if (sanitizedMessages.length === 0) return;
      const { default: ConversationService } =
        await import("#src/services/ConversationService");
      await ConversationService.saveTurnCheckpoint(
        conversationId,
        project,
        username,
        sanitizedMessages,
        getCollectionOpts(project, agent) || {},
      );
    } catch (error: unknown) {
      logger.warn(
        `[BaseAgenticHarness] Turn checkpoint failed for ${conversationId}: ${errorMessage(error)}`,
      );
    }
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

    // Verbatim tool-output substitution ({{tool_output:field}} → exact tool
    // result value) — must run before the done event, persistence, and the
    // in-memory assistant push, since all three read this text.
    state.finalStreamedText = substituteToolOutputTokens(
      state.finalStreamedText,
      currentMessages,
    );
    for (let i = 0; i < cleanTextFragments.length; i++) {
      cleanTextFragments[i] = substituteToolOutputTokens(
        cleanTextFragments[i],
        currentMessages,
      );
    }
    for (const message of newTurnMessages) {
      if (message.role === "assistant" && typeof message.content === "string") {
        message.content = substituteToolOutputTokens(
          message.content,
          currentMessages,
        );
      }
    }

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

}
