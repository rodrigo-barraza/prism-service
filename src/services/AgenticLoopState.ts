import {
  createUsageAccumulator,
  getTotalInputTokens,
} from "#src/utils/CostCalculator";
import type {
  UsageAccumulator,
  DisplaySegment,
  ToolCall,
  AgenticLoopStateInit,
  PassState,
  ConversationMessage,
} from "./harnesses/types.ts";
import type { ProviderInputBaseline } from "#src/services/compact/ContextBudgets";
import type { CompactionBoundary } from "#src/services/compact/CompactionBoundary";
import type { TokenUsage } from "#src/types/admin";
import { MEDIA } from "#src/constants";
import type { ModelRefusal } from "./harnesses/types.ts";
import type { AnthropicThinkingBlock } from "#src/types/admin";
interface CriteriaScores {
  correctness: number;
  risk: number;
  efficiency: number;
  completeness: number;
}

/**
 * AgenticLoopState — encapsulates all mutable accumulated state
 * for an agentic loop execution.
 *
 * Harness implementations populate this during `run()` and the
 * finalization logic reads from it to persist and emit results.
 *
 * Separating state from logic makes it possible for different
 * harnesses to share finalization, progress emission, and DB
 * persistence code without inheritance coupling.
 */
export default class AgenticLoopState {
  // ── Iteration tracking ──────────────────────────────────
  iterations: number;

  // ── Usage / cost accumulation ────────────────────────────
  overallUsage: UsageAccumulator;
  overallFirstTokenTime: number | null;
  overallGenerationEnd: number | null;
  overallOutputCharacters: number;

  // ── Streamed content ────────────────────────────────────
  finalStreamedText: string;
  streamedThinking: string;
  streamedImages: string[];
  streamedToolCalls: ToolCall[];
  streamedAudioChunks: string[];
  audioSampleRate: number;
  lastRateLimits: Record<string, unknown> | null;

  // ── Display segment tracking ────────────────────────────
  // Mirrors the client-side contentSegments system so the
  // interleaving order (thinking ↔ tools ↔ text) survives DB
  // round-trips for proper rendering on conversation restore.
  displaySegments: DisplaySegment[];
  displayTextFragments: string[];
  displayThinkingFragments: string[];
  lastDisplaySegType: string | null;

  // ── Plan mode ───────────────────────────────────────────
  planModeActive: boolean;
  planModeText: string;

  // ── Message management ──────────────────────────────────
  // Track the initial message count so we can slice only NEW
  // messages for DB persistence. The client sends the full
  // history; we must not re-append already-persisted messages.
  originalMessageCount: number;

  // ── Compaction tracking ─────────────────────────────────
  // Set when LLM-powered auto-compaction fires during the loop.
  compactionPerformed: boolean;
  preCompactTokenCount: number | null;
  postCompactTokenCount: number | null;
  /**
   * Model-invoked compaction request (compact_context tool directive).
   * Consumed and cleared by ContextPressureManager at the next boundary.
   */
  compactionRequested: boolean;
  /**
   * Iteration at which the last behavioral-stall warning was issued —
   * suppresses compaction for the following few iterations
   * (CompactionDeferralGuard).
   */
  lastStallWarningIteration: number | null;
  /**
   * The latest model call's provider-reported input (cache included) and the
   * chars/4 size of the messages it carried — the compaction trigger's
   * baseline (ContextBudgets.estimateRequestInputTokens).
   */
  providerInputBaseline: ProviderInputBaseline | null;
  /** The boundary of this turn's latest compaction — persisted by the Finalizer. */
  compactionBoundary: CompactionBoundary | null;
  /**
   * Why summarization did not (or could not) keep this iteration under
   * budget — set by ContextPressureManager, logged by ContextWindowManager
   * if lossy truncation has to run.
   */
  truncationReason: string | null;

  // ── Turn transcript (lifecycle/TurnTranscript.ts) ───────
  /**
   * Every message this turn produced, verbatim and in order — recorded
   * before anything shrinks the loop's message array, so compaction,
   * offload and truncation of the CURRENT run never reach persistence.
   * Null until the first context-pressure boundary.
   */
  turnTranscript: ConversationMessage[] | null;
  /** Originals already classified by the transcript (recorded or not part of the turn). */
  turnTranscriptSeen: WeakSet<object>;

  // ── Provider-native state of the FINAL pass (OpenAI Responses) ──
  // response.id, assistant message phase and unpaired reasoning items of
  // the pass that produced the final text — stamped on the final assistant
  // message by finalize() so the next turn replays them. Reset at the start
  // of every pass (response.created) so a tool-batch pass never leaks into
  // the final message; mid-history messages take theirs from the pass.
  phase?: "commentary" | "final_answer" | null;
  reasoningItems?: Array<{ id: string; summary: Array<{ type: string; text: string }>; encrypted_content?: string }>;
  providerResponseId?: string;
  responsesEffort?: string;
  geminiParts?: import("#src/types/admin").GeminiReplayPart[];
  citations?: import("#src/types/admin").MessageCitations;
  /** Anthropic thinking blocks of the final pass (reset with each pass). */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** Set when a safety classifier declined the turn; stored on the final message. */
  refusal?: ModelRefusal;

  // ── Turn input (TurnInputMailbox) ───────────────────────
  /** Entries injected into this turn at loop boundaries (steering, answers, completions). */
  turnInputApplied: number;
  /**
   * A DETACHED_WORK directive was seen: background work is running while
   * this turn continues. Read at loop end to bump pendingBackgroundTasks
   * when the turn finishes before the work does.
   */
  detachedWorkDispatched: boolean;
  /**
   * `additionalContext` from configured hooks (PreToolUse, PostToolUse,
   * PostToolBatch) collected during a tool batch, injected as one
   * <hook-context> message after the batch's results.
   */
  pendingHookContext: string[];
  /** Consecutive continuations Stop hooks have forced (capped). */
  stopHookContinuations: number;

  // ── Error budget tracking ───────────────────────────────
  toolErrorCounts: Map<string, number>;

  // ── Pending request-log writes ──────────────────────────
  // logIteration's per-iteration request-log writes are fire-and-forget;
  // finalize() awaits them (allSettled) before conversation persistence so
  // the requests-collection rollup sees every iteration of this turn.
  pendingRequestLogWrites: Promise<unknown>[];

  // ── Conversation outcome ───────────────────────────
  // Set by harnesses before finalization to indicate how the
  // conversation ended. Used by afterResponse hooks (e.g. AWM) to
  // gate actions that should only run on successful completions.
  // Persisted on the conversation document by the Finalizer.
  conversationOutcome:
    | "completed"
    | "exhausted"
    | "budget_exhausted"
    | "plan_rejected"
    | "error"
    | "aborted"
    | "refused";
  /** Spend at the moment the cost cap stopped the loop (null = no stop). */
  costBudgetStop: { spentDollars: number; maxCostDollars: number } | null;

  // ── Branch tracking (TreeOfThought) ─────────────────────
  branchesExplored: number;
  branchesBacktracked: number;
  proactiveBacktracks: number;
  selectedBranchScores: number[];
  frontierCandidates: Array<{
    pass: PassState;
    score: number;
    branchIndex: number;
    criteriaScores: CriteriaScores;
  }>;

  // ── High-water marks ────────────────────────────────────
  // Token counts emitted to the frontend must be monotonically
  // non-decreasing. These prevent dips at iteration boundaries.
  hwmOutputTokens: number;
  hwmInputTokens: number;
  hwmTotalTokens: number;
  hwmOutputCharacters: number;
  hwmEstimatedCost: number;

  // ── Accumulated phase durations ──────────────────────────
  // Sum of all per-pass thinking/content durations, passed to
  // the finalizer for the done event and DB persistence.
  overallThinkingDurationSeconds: number;
  overallContentDurationSeconds: number;

  // ── Progress emission throttling ────────────────────────
  readonly PROGRESS_CHUNK_INTERVAL = 10;
  readonly PROGRESS_TIME_INTERVAL_MILLISECONDS = 500;
  lastProgressEmitTime: number;
  chunksSinceLastProgress: number;

  constructor({
    originalMessageCount = 0,
    planModeActive = false,
  }: AgenticLoopStateInit = {}) {
    this.iterations = 0;

    this.overallUsage = createUsageAccumulator();
    this.overallFirstTokenTime = null;
    this.overallGenerationEnd = null;
    this.overallOutputCharacters = 0;

    this.finalStreamedText = "";
    this.streamedThinking = "";
    this.streamedImages = [];
    this.streamedToolCalls = [];
    this.streamedAudioChunks = [];
    this.audioSampleRate = MEDIA.LOOP_STATE_AUDIO_SAMPLE_RATE_HZ;
    this.lastRateLimits = null;

    this.displaySegments = [];
    this.displayTextFragments = [];
    this.displayThinkingFragments = [];
    this.lastDisplaySegType = null;

    this.planModeActive = planModeActive;
    this.planModeText = "";

    this.originalMessageCount = originalMessageCount;

    this.compactionPerformed = false;
    this.preCompactTokenCount = null;
    this.postCompactTokenCount = null;
    this.compactionRequested = false;
    this.lastStallWarningIteration = null;
    this.providerInputBaseline = null;
    this.compactionBoundary = null;
    this.truncationReason = null;

    this.turnTranscript = null;
    this.turnTranscriptSeen = new WeakSet();

    this.turnInputApplied = 0;
    this.detachedWorkDispatched = false;
    this.pendingHookContext = [];
    this.stopHookContinuations = 0;

    this.toolErrorCounts = new Map();
    this.pendingRequestLogWrites = [];
    this.conversationOutcome = "completed";
    this.costBudgetStop = null;

    this.branchesExplored = 0;
    this.branchesBacktracked = 0;
    this.proactiveBacktracks = 0;
    this.selectedBranchScores = [];
    this.frontierCandidates = [];

    this.hwmOutputTokens = 0;
    this.hwmInputTokens = 0;
    this.hwmTotalTokens = 0;
    this.hwmOutputCharacters = 0;
    this.hwmEstimatedCost = 0;

    this.overallThinkingDurationSeconds = 0;
    this.overallContentDurationSeconds = 0;

    this.lastProgressEmitTime = 0;
    this.chunksSinceLastProgress = 0;
  }

  /**
   * Record a finished model call's reported input as the next trigger
   * baseline. Calls that report no input keep the previous baseline.
   */
  recordProviderInput(
    usage: TokenUsage | null | undefined,
    sentMessageTokens: number,
  ): void {
    const inputTokens = getTotalInputTokens(usage);
    if (inputTokens <= 0) return;
    this.providerInputBaseline = {
      inputTokens,
      messageTokens: sentMessageTokens,
    };
  }

  /** Get clean display segments (trimmed, empty-filtered) for DB persistence. */
  getCleanDisplayData() {
    const cleanSegments: DisplaySegment[] = [];
    const cleanTextFragments: string[] = [];
    const cleanThinkingFragments: string[] = [];

    for (const segment of this.displaySegments) {
      if (segment.type === "text") {
        const trimmed =
          this.displayTextFragments[segment.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({
          type: "text",
          fragmentIndex: cleanTextFragments.length,
        });
        cleanTextFragments.push(trimmed);
      } else if (segment.type === "thinking") {
        const trimmed =
          this.displayThinkingFragments[segment.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({
          type: "thinking",
          fragmentIndex: cleanThinkingFragments.length,
        });
        cleanThinkingFragments.push(trimmed);
      } else {
        cleanSegments.push(segment); // tools segments pass through
      }
    }

    return { cleanSegments, cleanTextFragments, cleanThinkingFragments };
  }
}
