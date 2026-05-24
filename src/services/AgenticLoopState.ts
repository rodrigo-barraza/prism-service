import { createUsageAccumulator } from "../utils/CostCalculator.ts";
import type {
  UsageAccumulator,
  DisplaySegment,
  ToolCall,
  AgenticLoopStateInit,
} from "./harnesses/types.ts";

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
  // round-trips for proper rendering on session restore.
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

  // ── Error budget tracking ───────────────────────────────
  toolErrorCounts: Map<string, number>;

  // ── High-water marks ────────────────────────────────────
  // Token counts emitted to the frontend must be monotonically
  // non-decreasing. These prevent dips at iteration boundaries.
  hwmOutputTokens: number;
  hwmInputTokens: number;
  hwmTotalTokens: number;
  hwmOutputCharacters: number;

  // ── Progress emission throttling ────────────────────────
  readonly PROGRESS_CHUNK_INTERVAL = 10;
  readonly PROGRESS_TIME_INTERVAL_MS = 500;
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
    this.audioSampleRate = 24000;
    this.lastRateLimits = null;

    this.displaySegments = [];
    this.displayTextFragments = [];
    this.displayThinkingFragments = [];
    this.lastDisplaySegType = null;

    this.planModeActive = planModeActive;
    this.planModeText = "";

    this.originalMessageCount = originalMessageCount;

    this.toolErrorCounts = new Map();

    this.hwmOutputTokens = 0;
    this.hwmInputTokens = 0;
    this.hwmTotalTokens = 0;
    this.hwmOutputCharacters = 0;

    this.lastProgressEmitTime = 0;
    this.chunksSinceLastProgress = 0;
  }

  /** Get clean display segments (trimmed, empty-filtered) for DB persistence. */
  getCleanDisplayData() {
    const cleanSegments: DisplaySegment[] = [];
    const cleanTextFragments: string[] = [];
    const cleanThinkingFragments: string[] = [];

    for (const segment of this.displaySegments) {
      if (segment.type === "text") {
        const trimmed = this.displayTextFragments[segment.fragmentIndex]?.trim();
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
