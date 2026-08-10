import { STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import RepetitionDetector from "#src/services/RepetitionDetector";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { computeToolCallFingerprint } from "./SemanticStallDetector.ts";
import { HARNESS } from "#src/constants";

import type { ToolCall, AgenticOptions } from "../types.ts";

// ────────────────────────────────────────────────────────────
// DeviationRuleEngine — mid-stream deviation rules
// ────────────────────────────────────────────────────────────
// Port of oh-my-pi's "time-traveling stream rules": instead of letting
// a bad iteration COMPLETE and correcting afterwards, a deviation rule
// fires while the provider stream is still in flight. The harness then
// aborts the stream, injects the rule's reminder text as a system
// message, and regenerates the SAME iteration from the same message
// state (bounded — HARNESS.MAX_DEVIATION_RETRIES).
//
// Rules are data: a rule is a predicate over accumulated stream state
// plus a locale key for its reminder text. Repetition (token-level
// degeneration) and semantic stall (identical tool call about to be
// re-issued) are the two built-in rules; new rules are added to
// createDefaultDeviationRules without touching the harness.
// ────────────────────────────────────────────────────────────

const {
  REPETITION_TEMPERATURE_BUMP,
  REPETITION_PENALTY_BUMP,
  DEFAULT_EXACT_REPEAT_THRESHOLD,
  DEFAULT_ROLLING_WINDOW_SIZE,
} = HARNESS;

export const DEVIATION_RULE_IDS = {
  REPETITION: "repetition",
  SEMANTIC_STALL: "semantic-stall",
} as const;

/** What a rule reports when it fires. */
export interface DeviationFinding {
  /** Human-readable detail for logs. */
  detail: string;
  /** Interpolation variables for the rule's reminder locale key. */
  reminderVariables?: Record<string, string>;
}

/** Verdict handed to the harness — everything needed to abort + recover. */
export interface DeviationVerdict extends DeviationFinding {
  ruleId: string;
  /** Existing STATUS_MESSAGES value emitted on the status SSE event. */
  statusMessage: string;
  /** Locale key (PromptLocaleService) for the injected reminder body. */
  reminderLocaleKey: string;
}

export interface DeviationRule {
  id: string;
  /** Existing STATUS_MESSAGES value — never a new SSE event type. */
  statusMessage: string;
  /** PromptLocaleService key for the reminder body. */
  reminderLocaleKey: string;
  /** Reset per-pass state. Called at the start of every stream pass. */
  onPassStart?(): void;
  /** Evaluate an accumulated text/thinking chunk. */
  onTextChunk?(chunkText: string): DeviationFinding | null;
  /** Evaluate a fully parsed (not yet executed) streamed tool call. */
  onToolCall?(toolCall: ToolCall): DeviationFinding | null;
  /** Record a COMPLETED iteration's tool calls (cross-iteration rules). */
  onIterationComplete?(toolCalls: ToolCall[]): void;
  /** Optional sampling perturbation applied to retry passes. */
  perturbRetryOptions?(
    options: AgenticOptions,
    retryNumber: number,
  ): AgenticOptions;
}

/**
 * Built-in rules. Kept as a factory so each engine (one per harness run)
 * owns private detector state.
 */
export function createDefaultDeviationRules(): DeviationRule[] {
  // ── Rule 1: token-level repetition ─────────────────────────
  // Wraps the streaming RepetitionDetector (word n-gram frequency +
  // unique-ratio analysis over a sliding window).
  const repetitionDetector = new RepetitionDetector();
  const repetitionRule: DeviationRule = {
    id: DEVIATION_RULE_IDS.REPETITION,
    statusMessage: STATUS_MESSAGES.REPETITION_DETECTED,
    reminderLocaleKey: "harness.deviationRules.repetition",
    onPassStart() {
      repetitionDetector.reset();
    },
    onTextChunk(chunkText) {
      const verdict = repetitionDetector.append(chunkText);
      if (!verdict.isDegenerate) return null;
      const pattern = (verdict.pattern || "").slice(0, 80);
      return {
        detail:
          `degenerate repetition (metric=${verdict.metric}, ` +
          `confidence=${verdict.confidence.toFixed(2)}, pattern="${pattern}")`,
        reminderVariables: { pattern },
      };
    },
    perturbRetryOptions(options, retryNumber) {
      const currentTemperature =
        typeof options.temperature === "number" ? options.temperature : 0.7;
      return {
        ...options,
        temperature: Math.min(
          1.0,
          currentTemperature + REPETITION_TEMPERATURE_BUMP * retryNumber,
        ),
        repeatPenalty: 1.0 + REPETITION_PENALTY_BUMP * retryNumber,
      };
    },
  };

  // ── Rule 2: semantic stall (pre-emptive) ───────────────────
  // The post-hoc SemanticStallDetector compares completed iterations;
  // this rule catches the stall one step EARLIER — the moment the model
  // streams a tool call byte-identical (same fingerprint) to one it
  // already issued in each of the last N-1 iterations, i.e. the call
  // that would make it N consecutive repeats is cancelled before it
  // executes.
  const previousIterationFingerprints: Array<Set<string>> = [];
  const stallRule: DeviationRule = {
    id: DEVIATION_RULE_IDS.SEMANTIC_STALL,
    statusMessage: STATUS_MESSAGES.SEMANTIC_STALL_DETECTED,
    reminderLocaleKey: "harness.deviationRules.semanticStall",
    onToolCall(toolCall) {
      const requiredPreviousRepeats = DEFAULT_EXACT_REPEAT_THRESHOLD - 1;
      if (previousIterationFingerprints.length < requiredPreviousRepeats) {
        return null;
      }
      const fingerprint = computeToolCallFingerprint(toolCall);
      for (let offset = 1; offset <= requiredPreviousRepeats; offset++) {
        const iterationSet =
          previousIterationFingerprints[
            previousIterationFingerprints.length - offset
          ];
        if (!iterationSet.has(fingerprint)) return null;
      }
      return {
        detail:
          `tool "${toolCall.name}" about to repeat with identical arguments ` +
          `for the ${DEFAULT_EXACT_REPEAT_THRESHOLD}th consecutive iteration`,
        reminderVariables: { toolName: toolCall.name },
      };
    },
    onIterationComplete(toolCalls) {
      previousIterationFingerprints.push(
        new Set(
          toolCalls.map((toolCall) => computeToolCallFingerprint(toolCall)),
        ),
      );
      if (previousIterationFingerprints.length > DEFAULT_ROLLING_WINDOW_SIZE) {
        previousIterationFingerprints.shift();
      }
    },
  };

  return [repetitionRule, stallRule];
}

export default class DeviationRuleEngine {
  private readonly rules: DeviationRule[];

  constructor(rules?: DeviationRule[]) {
    this.rules = rules ?? createDefaultDeviationRules();
  }

  /** Reset per-pass rule state. Call at the start of every stream pass. */
  beginPass(): void {
    for (const rule of this.rules) rule.onPassStart?.();
  }

  /** Evaluate a streamed text/thinking chunk against all rules. */
  observeTextChunk(chunkText: string): DeviationVerdict | null {
    if (!chunkText) return null;
    for (const rule of this.rules) {
      const finding = rule.onTextChunk?.(chunkText);
      if (finding) return this.buildVerdict(rule, finding);
    }
    return null;
  }

  /** Evaluate a fully parsed streamed tool call against all rules. */
  observeToolCall(toolCall: ToolCall): DeviationVerdict | null {
    for (const rule of this.rules) {
      const finding = rule.onToolCall?.(toolCall);
      if (finding) return this.buildVerdict(rule, finding);
    }
    return null;
  }

  /** Feed a completed iteration's tool calls to cross-iteration rules. */
  recordCompletedIteration(toolCalls: ToolCall[]): void {
    for (const rule of this.rules) rule.onIterationComplete?.(toolCalls);
  }

  /** Localized reminder text for the verdict's rule. */
  buildReminder(verdict: DeviationVerdict, locale: string): string {
    return PromptLocaleService.get(
      locale,
      verdict.reminderLocaleKey,
      verdict.reminderVariables,
    );
  }

  /** Apply the firing rule's sampling perturbation to retry options. */
  perturbRetryOptions(
    ruleId: string,
    options: AgenticOptions,
    retryNumber: number,
  ): AgenticOptions {
    const rule = this.rules.find((candidate) => candidate.id === ruleId);
    return rule?.perturbRetryOptions?.(options, retryNumber) ?? options;
  }

  private buildVerdict(
    rule: DeviationRule,
    finding: DeviationFinding,
  ): DeviationVerdict {
    return {
      ...finding,
      ruleId: rule.id,
      statusMessage: rule.statusMessage,
      reminderLocaleKey: rule.reminderLocaleKey,
    };
  }
}
