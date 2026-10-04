// ────────────────────────────────────────────────────────────
// Generated media — an assistant reply that is not text
// ────────────────────────────────────────────────────────────
// Persistence drops an assistant message with no text and no tool calls:
// an intermediate loop pass that produced nothing. A reply whose output
// is an image or audio is not one of those. Gemini image models answer
// with an image and no text, and before this check every such image was
// dropped at finalize — the chat showed it, a reopened conversation had
// only the user's prompt.
//
// The chat already shows such a message (prepareDisplayMessages keeps
// images and audio), so a compaction boundary may name it too
// (CompactionBoundary.isAddressable).
// ────────────────────────────────────────────────────────────

interface MessageWithMedia {
  images?: unknown;
  audio?: unknown;
  [key: string]: unknown;
}

function isPresent(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** Whether a message carries generated images or audio. */
export function carriesGeneratedMedia(message: MessageWithMedia): boolean {
  return isPresent(message.images) || isPresent(message.audio);
}
