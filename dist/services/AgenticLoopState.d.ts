import type { UsageAccumulator, DisplaySegment, ToolCall, AgenticLoopStateInit } from "./harnesses/types.ts";
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
    iterations: number;
    overallUsage: UsageAccumulator;
    overallFirstTokenTime: number | null;
    overallGenerationEnd: number | null;
    overallOutputCharacters: number;
    finalStreamedText: string;
    streamedThinking: string;
    streamedImages: string[];
    streamedToolCalls: ToolCall[];
    streamedAudioChunks: string[];
    audioSampleRate: number;
    lastRateLimits: Record<string, unknown> | null;
    displaySegments: DisplaySegment[];
    displayTextFragments: string[];
    displayThinkingFragments: string[];
    lastDisplaySegType: string | null;
    planModeActive: boolean;
    planModeText: string;
    originalMessageCount: number;
    toolErrorCounts: Map<string, number>;
    hwmOutputTokens: number;
    hwmInputTokens: number;
    hwmTotalTokens: number;
    hwmOutputCharacters: number;
    readonly PROGRESS_CHUNK_INTERVAL = 10;
    readonly PROGRESS_TIME_INTERVAL_MS = 500;
    lastProgressEmitTime: number;
    chunksSinceLastProgress: number;
    constructor({ originalMessageCount, planModeActive, }?: AgenticLoopStateInit);
    /** Get clean display segments (trimmed, empty-filtered) for DB persistence. */
    getCleanDisplayData(): {
        cleanSegments: DisplaySegment[];
        cleanTextFragments: string[];
        cleanThinkingFragments: string[];
    };
}
//# sourceMappingURL=AgenticLoopState.d.ts.map