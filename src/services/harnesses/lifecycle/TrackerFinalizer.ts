import SessionGenerationTracker from "../../SessionGenerationTracker.ts";
import type { PassState } from "../types.ts";

/**
 * TrackerFinalizer — per-pass SessionGenerationTracker finalization.
 *
 * After each LLM stream completes, the harness must:
 *   1. Report output token count to the tracker
 *   2. Report input token count (with promptTokens fallback)
 *   3. Mark the request as complete
 *
 * This ~15-line block was duplicated identically across ReActHarness,
 * TreeOfThoughtHarness, and VisionLanguageHarness.
 *
 * Returns `finalInputTokens` so callers can pass it to KVCacheReporter.
 */

/**
 * Finalize the SessionGenerationTracker for a completed pass.
 *
 * Updates token counts and marks the request as complete.
 * Returns the resolved input token count for downstream diagnostics.
 */
export function finalizePassTracker(
  pass: PassState,
  passRequestId: string,
): { finalInputTokens: number } {
  if (pass.usage.outputTokens > 0) {
    SessionGenerationTracker.update(passRequestId, {
      outputTokens: pass.usage.outputTokens,
    });
  }

  const finalInputTokens =
    pass.usage.inputTokens || pass.usage.promptTokens || 0;
  if (finalInputTokens > 0) {
    SessionGenerationTracker.update(passRequestId, {
      inputTokens: finalInputTokens,
    });
  }

  SessionGenerationTracker.complete(passRequestId);

  return { finalInputTokens };
}
