/**
 * SemanticStallDetector — behavioral-level stall detection for the
 * agentic loop.
 *
 * Monitors tool call patterns across iterations to detect when the
 * agent is making zero semantic progress — calling the same tools
 * with identical arguments in a cyclical or repetitive pattern.
 *
 * This is the behavioral complement to the streaming RepetitionDetector
 * (which catches token-level repetition within a single generation).
 * SemanticStallDetector operates at the iteration level, comparing
 * entire tool call sets across consecutive loop iterations.
 *
 * Detection modes:
 *   - Exact repeat: identical tool call set for N consecutive iterations
 *   - Cyclical: tool call set matches any previous set in a rolling
 *     window (agent alternating between 2-3 states)
 *   - Text repeat: identical text-only output for N consecutive iterations
 *
 * The detector is per-session (instantiated once per agentic loop run).
 */

import { createHash } from "crypto";
import type { ToolCall } from "#src/services/harnesses/types";
import { HARNESS } from "#src/constants";

export interface StallVerdict {
  isStalled: boolean;
  stallType: "none" | "exact_repeat" | "cyclical" | "text_repeat";
  consecutiveRepeats: number;
  repeatedTools?: string[];
}

interface IterationFingerprint {
  /** Deterministic hash of the sorted tool call fingerprints for this iteration. */
  toolSetHash: string;
  /** Individual tool names included in this iteration (for diagnostics). */
  toolNames: string[];
  /** Hash of text content for text-only iterations. */
  textHash?: string;
  /** Whether this iteration had tool calls. */
  hadToolCalls: boolean;
}

interface SemanticStallDetectorOptions {
  /** Number of consecutive exact-repeat iterations before flagging. Default: 3. */
  exactRepeatThreshold?: number;
  /** Number of cyclical matches in the rolling window before flagging. Default: 4. */
  cyclicalThreshold?: number;
  /** Size of the rolling window for cyclical detection. Default: 6. */
  rollingWindowSize?: number;
  /** Number of consecutive identical text-only iterations before flagging. Default: 3. */
  textRepeatThreshold?: number;
}

const DEFAULT_EXACT_REPEAT_THRESHOLD = HARNESS.DEFAULT_EXACT_REPEAT_THRESHOLD;
const DEFAULT_CYCLICAL_THRESHOLD = HARNESS.DEFAULT_CYCLICAL_THRESHOLD;
const DEFAULT_ROLLING_WINDOW_SIZE = HARNESS.DEFAULT_ROLLING_WINDOW_SIZE;
const DEFAULT_TEXT_REPEAT_THRESHOLD = HARNESS.DEFAULT_TEXT_REPEAT_THRESHOLD;

/** Empty tool set sentinel — iterations with no tool calls share this hash. */
const EMPTY_TOOL_SET_HASH = "__no_tools__";

/**
 * Compute a deterministic fingerprint for a single tool call.
 * Uses tool name + stable-sorted JSON of arguments to produce
 * a consistent hash regardless of argument insertion order.
 *
 * Exported for the DeviationRuleEngine's mid-stream stall rule, which
 * compares a just-streamed tool call against previous iterations' calls
 * using the same hashing so the two detectors can never disagree.
 */
export function computeToolCallFingerprint(toolCall: ToolCall): string {
  const stableArguments = stableStringify(toolCall.args);
  return createHash("sha256")
    .update(`${toolCall.name}::${stableArguments}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Produce a deterministic JSON string from an object by sorting keys
 * recursively. This ensures identical arguments produce identical
 * hashes regardless of property insertion order.
 */
function stableStringify(
  value: string | number | boolean | object | null | undefined | symbol,
): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const sortedKeys = Object.keys(
    value as Record<
      string,
      string | number | boolean | object | null | undefined | symbol
    >,
  ).sort();
  const entries = sortedKeys.map(
    (key) =>
      `${JSON.stringify(key)}:${stableStringify(
        (
          value as Record<
            string,
            string | number | boolean | object | null | undefined | symbol
          >
        )[key],
      )}`,
  );
  return "{" + entries.join(",") + "}";
}

/**
 * Compute a hash for the entire set of tool calls in an iteration.
 * Sorts individual fingerprints to ensure order-independence.
 */
function computeToolSetHash(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return EMPTY_TOOL_SET_HASH;

  const individualFingerprints = toolCalls
    .map((toolCall) => computeToolCallFingerprint(toolCall))
    .sort();

  return createHash("sha256")
    .update(individualFingerprints.join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compute a hash for text content (used for text-only stall detection).
 */
function computeTextHash(text: string): string {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) return "";
  return createHash("sha256")
    .update(normalizedText)
    .digest("hex")
    .slice(0, 16);
}

export default class SemanticStallDetector {
  private iterationHistory: IterationFingerprint[] = [];
  private readonly exactRepeatThreshold: number;
  private readonly cyclicalThreshold: number;
  private readonly rollingWindowSize: number;
  private readonly textRepeatThreshold: number;

  /** Whether a stall warning has already been injected (for escalation tracking). */
  private stallWarningIssued = false;
  /** Number of stalled iterations after the warning was issued. */
  private postWarningStallCount = 0;

  constructor(options?: SemanticStallDetectorOptions) {
    this.exactRepeatThreshold =
      options?.exactRepeatThreshold ?? DEFAULT_EXACT_REPEAT_THRESHOLD;
    this.cyclicalThreshold =
      options?.cyclicalThreshold ?? DEFAULT_CYCLICAL_THRESHOLD;
    this.rollingWindowSize =
      options?.rollingWindowSize ?? DEFAULT_ROLLING_WINDOW_SIZE;
    this.textRepeatThreshold =
      options?.textRepeatThreshold ?? DEFAULT_TEXT_REPEAT_THRESHOLD;
  }

  /**
   * Record an iteration's tool calls and/or text output and check for
   * behavioral stall patterns.
   *
   * Call this after each iteration completes (after tool execution results
   * are available, or after a text-only response is recorded).
   */
  recordIteration(
    toolCalls: ToolCall[],
    textContent?: string,
  ): StallVerdict {
    const fingerprint: IterationFingerprint = {
      toolSetHash: computeToolSetHash(toolCalls),
      toolNames: [...new Set(toolCalls.map((toolCall) => toolCall.name))],
      textHash: textContent ? computeTextHash(textContent) : undefined,
      hadToolCalls: toolCalls.length > 0,
    };

    this.iterationHistory.push(fingerprint);

    // Trim to rolling window size
    if (this.iterationHistory.length > this.rollingWindowSize) {
      this.iterationHistory = this.iterationHistory.slice(
        this.iterationHistory.length - this.rollingWindowSize,
      );
    }

    // Need at least 2 iterations to detect any pattern
    if (this.iterationHistory.length < 2) {
      return { isStalled: false, stallType: "none", consecutiveRepeats: 0 };
    }

    // Route based on whether this iteration had tool calls
    if (fingerprint.hadToolCalls) {
      // ── Check 1: Exact consecutive repeat ────────────────────
      const exactRepeatVerdict = this.checkExactRepeat(fingerprint);
      if (exactRepeatVerdict.isStalled) {
        this.trackPostWarningStall();
        return exactRepeatVerdict;
      }

      // ── Check 2: Cyclical pattern ────────────────────────────
      const cyclicalVerdict = this.checkCyclicalPattern(fingerprint);
      if (cyclicalVerdict.isStalled) {
        this.trackPostWarningStall();
        return cyclicalVerdict;
      }
    } else if (fingerprint.textHash) {
      // ── Check 3: Text-only repeat ────────────────────────────
      const textRepeatVerdict = this.checkTextRepeat(fingerprint);
      if (textRepeatVerdict.isStalled) {
        this.trackPostWarningStall();
        return textRepeatVerdict;
      }
    }

    return { isStalled: false, stallType: "none", consecutiveRepeats: 0 };
  }

  /** Reset the detector state. */
  reset(): void {
    this.iterationHistory = [];
    this.stallWarningIssued = false;
    this.postWarningStallCount = 0;
  }

  /** Mark that a stall warning has been injected into the conversation. */
  markWarningIssued(): void {
    this.stallWarningIssued = true;
    this.postWarningStallCount = 0;
  }

  /** Whether a stall warning was already issued. */
  get hasWarningBeenIssued(): boolean {
    return this.stallWarningIssued;
  }

  /** How many stalled iterations have occurred after the warning. */
  get postWarningStalls(): number {
    return this.postWarningStallCount;
  }

  /** Get the current history length (for diagnostics). */
  get historyLength(): number {
    return this.iterationHistory.length;
  }

  /**
   * Track stall continuation after a warning has been issued.
   */
  private trackPostWarningStall(): void {
    if (this.stallWarningIssued) {
      this.postWarningStallCount++;
    }
  }

  /**
   * Check if the last N iterations all have the same tool set hash
   * (exact consecutive repeat).
   */
  private checkExactRepeat(
    currentFingerprint: IterationFingerprint,
  ): StallVerdict {
    const history = this.iterationHistory;
    let consecutiveCount = 1;

    // Count backwards from the second-to-last entry
    for (let index = history.length - 2; index >= 0; index--) {
      if (history[index].toolSetHash === currentFingerprint.toolSetHash) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    if (consecutiveCount >= this.exactRepeatThreshold) {
      return {
        isStalled: true,
        stallType: "exact_repeat",
        consecutiveRepeats: consecutiveCount,
        repeatedTools: currentFingerprint.toolNames,
      };
    }

    return { isStalled: false, stallType: "none", consecutiveRepeats: 0 };
  }

  /**
   * Check for cyclical patterns — the current fingerprint matches
   * multiple previous iterations in the window, indicating the agent
   * is alternating between states (A → B → A → B).
   */
  private checkCyclicalPattern(
    currentFingerprint: IterationFingerprint,
  ): StallVerdict {
    const history = this.iterationHistory;

    // Count how many previous iterations in the window share this hash
    let matchCount = 0;
    const allMatchedToolNames = new Set<string>();

    // Start from the second-to-last (skip the current one we just pushed)
    for (let index = history.length - 2; index >= 0; index--) {
      if (history[index].toolSetHash === currentFingerprint.toolSetHash) {
        matchCount++;
        for (const toolName of history[index].toolNames) {
          allMatchedToolNames.add(toolName);
        }
      }
    }

    // matchCount doesn't include the current iteration, so total occurrences = matchCount + 1
    const totalOccurrences = matchCount + 1;

    if (totalOccurrences >= this.cyclicalThreshold) {
      return {
        isStalled: true,
        stallType: "cyclical",
        consecutiveRepeats: totalOccurrences,
        repeatedTools: [...allMatchedToolNames],
      };
    }

    return { isStalled: false, stallType: "none", consecutiveRepeats: 0 };
  }

  /**
   * Check for text-only stall — the agent is producing identical
   * text output across consecutive iterations with no tool calls.
   */
  private checkTextRepeat(
    currentFingerprint: IterationFingerprint,
  ): StallVerdict {
    const history = this.iterationHistory;
    let consecutiveCount = 1;

    for (let index = history.length - 2; index >= 0; index--) {
      const previous = history[index];
      if (
        !previous.hadToolCalls &&
        previous.textHash &&
        previous.textHash === currentFingerprint.textHash
      ) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    if (consecutiveCount >= this.textRepeatThreshold) {
      return {
        isStalled: true,
        stallType: "text_repeat",
        consecutiveRepeats: consecutiveCount,
      };
    }

    return { isStalled: false, stallType: "none", consecutiveRepeats: 0 };
  }
}
