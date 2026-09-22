import CompactionService, {
  type CompactionAttempt,
} from "./CompactionService.ts";
import type { ChatMessage } from "#src/types/admin";

// ────────────────────────────────────────────────────────────
// ContextShrinkStrategy — HOW a conversation over its threshold shrinks
// ────────────────────────────────────────────────────────────
// ContextPressureManager decides WHEN (threshold, deferral, order before
// truncation); this is the one place that decides HOW. Today every
// provider shrinks the same way: an LLM summary of everything older than
// the recency-protected window (CompactionService), persisted as a
// boundary so it is paid for once.
//
// Provider-native shrinking (Anthropic server-side context editing and
// compaction — prompt 10) plugs in here: select on the provider/model and
// return the same CompactionAttempt shape. Callers never branch on it.
// ────────────────────────────────────────────────────────────

export type ShrinkOptions = Parameters<typeof CompactionService.attemptCompaction>[1];

export async function shrinkContext(
  messages: ChatMessage[],
  options: ShrinkOptions,
): Promise<CompactionAttempt> {
  return CompactionService.attemptCompaction(messages, options);
}
