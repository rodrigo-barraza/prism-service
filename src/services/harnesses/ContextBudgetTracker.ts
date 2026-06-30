import {
  estimateTokens,
  getTotalInputTokens,
} from "../../utils/CostCalculator.ts";
import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../../constants/TokenBudgetDefaults.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../utils/logger.ts";
import type { EmitFunction } from "./types.ts";
import type { TokenUsage } from "../../types/admin.ts";

/**
 * Serializable snapshot of the context budget at a point in time.
 * Persisted on the conversation document and streamed to the client.
 */
export interface ContextBudgetSnapshot {
  contextWindow: number;
  messageTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  safetyMarginTokens: number;
  totalInputTokens: number;
  availableOutputTokens: number;
  requestedOutputTokens?: number;
  isClamped: boolean;
  toolCount: number;
  source: "estimated" | "reported";
  lastReportedInputTokens?: number;
  calibrationRatio?: number;
}

/**
 * ContextBudgetTracker — tracks and emits context window budget data
 * throughout an agentic loop execution.
 *
 * Two-phase approach:
 *   1. Pre-request: Emits heuristic-based estimates (source: "estimated")
 *   2. Post-response: Re-emits with real provider-reported input tokens
 *      (source: "reported") and computes a calibration ratio for future
 *      heuristic estimates.
 *
 * The calibration ratio is computed as `realInputTokens / estimatedInputTokens`
 * from the first provider usage response, then applied to subsequent heuristic
 * estimates before real data arrives. This progressively improves accuracy
 * as the agentic loop runs multiple iterations.
 */
export default class ContextBudgetTracker {
  private readonly emit: EmitFunction;
  private contextWindow: number;
  private calibrationRatio: number | null = null;
  private lastSnapshot: ContextBudgetSnapshot | null = null;

  // Cached static components (stable across iterations)
  private systemPromptTokensEstimate = 0;
  private toolSchemaTokensEstimate = 0;
  private toolCount = 0;

  constructor(emit: EmitFunction, contextWindow: number) {
    this.emit = emit;
    this.contextWindow = contextWindow;
  }

  /**
   * Compute and emit a pre-request budget estimate using heuristics.
   * Called by `clampOutputTokens` before each provider stream.
   *
   * Returns the clamped maxTokens value (or the original if no clamping needed).
   */
  computeAndEmitEstimate(
    estimatedMessageTokens: number,
    systemPromptText: string,
    toolSchemas: unknown[],
    requestedMaxTokens: number | undefined,
  ): {
    clampedMaxTokens: number | undefined;
    adjustedInput: number;
    availableForOutput: number;
  } {
    this.systemPromptTokensEstimate = estimateTokens(systemPromptText);
    this.toolSchemaTokensEstimate =
      toolSchemas.length > 0
        ? estimateTokens(JSON.stringify(toolSchemas))
        : 0;
    this.toolCount = toolSchemas.length;

    // Apply calibration ratio to the heuristic estimate if we have one
    const calibratedMessageTokens = this.calibrationRatio !== null
      ? Math.ceil(estimatedMessageTokens * this.calibrationRatio)
      : estimatedMessageTokens;

    const totalEstimatedInput =
      calibratedMessageTokens +
      this.systemPromptTokensEstimate +
      this.toolSchemaTokensEstimate;

    const safetyMargin = Math.ceil(
      totalEstimatedInput * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
    );
    const adjustedInput = totalEstimatedInput + safetyMargin;
    const availableForOutput = this.contextWindow - adjustedInput;

    const snapshot: ContextBudgetSnapshot = {
      contextWindow: this.contextWindow,
      messageTokens: calibratedMessageTokens,
      systemPromptTokens: this.systemPromptTokensEstimate,
      toolSchemaTokens: this.toolSchemaTokensEstimate,
      safetyMarginTokens: safetyMargin,
      totalInputTokens: adjustedInput,
      availableOutputTokens: Math.max(availableForOutput, 0),
      requestedOutputTokens: requestedMaxTokens,
      isClamped: requestedMaxTokens
        ? requestedMaxTokens > availableForOutput
        : false,
      toolCount: this.toolCount,
      source: this.calibrationRatio !== null ? "reported" : "estimated",
      ...(this.calibrationRatio !== null && {
        calibrationRatio: this.calibrationRatio,
      }),
    };

    this.lastSnapshot = snapshot;
    this.emitSnapshot(snapshot);

    // Compute clamped output
    let clampedMaxTokens = requestedMaxTokens;
    if (
      requestedMaxTokens &&
      requestedMaxTokens > availableForOutput
    ) {
      clampedMaxTokens = Math.max(
        availableForOutput,
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
      );
    }

    return { clampedMaxTokens, adjustedInput, availableForOutput };
  }

  /**
   * Record real provider-reported usage after a stream completes.
   * Re-emits the budget with actual input token counts and establishes
   * the calibration ratio for future estimates.
   */
  recordRealUsage(
    usage: TokenUsage | null | undefined,
    estimatedMessageTokensForThisPass: number,
  ): void {
    if (!usage) return;

    const realInputTokens = getTotalInputTokens(usage);
    if (realInputTokens <= 0) return;

    // Compute calibration ratio from the raw estimated message tokens
    // vs the real total input (which includes system prompt + tools).
    // We compare the full estimated input vs full real input to get
    // the overall calibration factor.
    const fullEstimatedInput =
      estimatedMessageTokensForThisPass +
      this.systemPromptTokensEstimate +
      this.toolSchemaTokensEstimate;

    if (fullEstimatedInput > 0) {
      this.calibrationRatio = realInputTokens / fullEstimatedInput;
      logger.info(
        `[ContextBudgetTracker] Calibration: estimated=${fullEstimatedInput}, ` +
          `real=${realInputTokens}, ratio=${this.calibrationRatio.toFixed(3)}`,
      );
    }

    // Re-compute the budget with real numbers
    const safetyMargin = Math.ceil(
      realInputTokens * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
    );
    const adjustedInput = realInputTokens + safetyMargin;
    const availableForOutput = this.contextWindow - adjustedInput;

    // Decompose the real input into components using the ratio of estimates
    const estimatedTotal =
      estimatedMessageTokensForThisPass +
      this.systemPromptTokensEstimate +
      this.toolSchemaTokensEstimate;

    const realMessageTokens =
      estimatedTotal > 0
        ? Math.round(
            (estimatedMessageTokensForThisPass / estimatedTotal) *
              realInputTokens,
          )
        : realInputTokens;
    const realSystemPromptTokens =
      estimatedTotal > 0
        ? Math.round(
            (this.systemPromptTokensEstimate / estimatedTotal) *
              realInputTokens,
          )
        : 0;
    const realToolSchemaTokens =
      estimatedTotal > 0
        ? Math.round(
            (this.toolSchemaTokensEstimate / estimatedTotal) *
              realInputTokens,
          )
        : 0;

    const requestedOutputTokens = this.lastSnapshot?.requestedOutputTokens;

    const snapshot: ContextBudgetSnapshot = {
      contextWindow: this.contextWindow,
      messageTokens: realMessageTokens,
      systemPromptTokens: realSystemPromptTokens,
      toolSchemaTokens: realToolSchemaTokens,
      safetyMarginTokens: safetyMargin,
      totalInputTokens: adjustedInput,
      availableOutputTokens: Math.max(availableForOutput, 0),
      requestedOutputTokens,
      isClamped: requestedOutputTokens
        ? requestedOutputTokens > availableForOutput
        : false,
      toolCount: this.toolCount,
      source: "reported",
      lastReportedInputTokens: realInputTokens,
      calibrationRatio: this.calibrationRatio ?? undefined,
    };

    this.lastSnapshot = snapshot;
    this.emitSnapshot(snapshot);
  }

  /** Get the latest budget snapshot for persistence. */
  getSnapshot(): ContextBudgetSnapshot | null {
    return this.lastSnapshot;
  }

  /** Update the context window size (e.g. after runtime discovery). */
  updateContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
  }

  /** Get the current calibration ratio (for logging/diagnostics). */
  getCalibrationRatio(): number | null {
    return this.calibrationRatio;
  }

  private emitSnapshot(snapshot: ContextBudgetSnapshot): void {
    this.emit({
      type: SERVER_SENT_EVENT_TYPES.CONTEXT_BUDGET,
      ...snapshot,
    });
  }
}
