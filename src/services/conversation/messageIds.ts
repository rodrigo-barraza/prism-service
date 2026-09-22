import { randomUUID } from "node:crypto";

// ────────────────────────────────────────────────────────────
// Stable message ids — the anchor for rewind and fork
// ────────────────────────────────────────────────────────────
// The client never sees the raw persisted array: it is served
// `displayMessages`, where role:"tool" messages are merged into their
// assistant message and empty stubs are dropped. A display index is
// therefore NOT a raw index, so rewind/fork address messages by id.
//
// - Every message appended through ConversationService.appendMessages
//   gets a fresh server-minted id (a client-supplied id is replaced, so a
//   resent message object can never duplicate an existing id).
// - A PATCH that replaces messages keeps the ids it is given and mints
//   the missing ones.
// - Messages persisted before ids existed are served with a derived id,
//   `legacy-<raw index>`, which resolveMessageIndex() maps back. It is
//   stable for as long as nothing before it is removed — the client
//   re-fetches after every mutation anyway.
// - A compaction boundary names the last message its summary covers by
//   this same id (compact/CompactionBoundary.ts); one minted mid-turn is
//   provisional until appendMessages re-points it (followMintedAnchor).
// ────────────────────────────────────────────────────────────

const LEGACY_PREFIX = "legacy-";

interface IdentifiedMessage {
  id?: unknown;
  [key: string]: unknown;
}

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

/** A persisted, server-minted id — not a served-only `legacy-` one. */
export function isStoredMessageId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !id.startsWith(LEGACY_PREFIX);
}

/** The id a message persisted before ids existed is served under. */
export function legacyMessageId(rawIndex: number): string {
  return `${LEGACY_PREFIX}${rawIndex}`;
}

/** Fresh ids for messages about to be appended. */
export function mintMessageIds<T extends object>(messages: T[]): T[] {
  return messages.map((message) => ({ ...message, id: newMessageId() }));
}

/**
 * Keep valid stored ids, mint the missing ones, and re-mint duplicates and
 * served-only legacy ids — for a PATCH that replaces the whole array.
 */
export function ensureMessageIds<T extends object>(messages: T[]): T[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    const id = (message as IdentifiedMessage).id;
    if (isStoredMessageId(id) && !seen.has(id)) {
      seen.add(id);
      return message;
    }
    const minted = newMessageId();
    seen.add(minted);
    return { ...message, id: minted };
  });
}

/** Attach the served id to every raw message (stored id, else the legacy index id). */
export function withServedMessageIds<T extends object>(messages: T[]): T[] {
  return messages.map((message, index) =>
    isStoredMessageId((message as IdentifiedMessage).id)
      ? message
      : { ...message, id: legacyMessageId(index) },
  );
}

/** The served id of the raw message at `index`. */
export function servedMessageId(message: object | undefined, index: number): string | null {
  if (!message) return null;
  const id = (message as IdentifiedMessage).id;
  return isStoredMessageId(id) ? id : legacyMessageId(index);
}

/** Resolve a served id against the raw persisted array; -1 when unknown. */
export function resolveMessageIndex(messages: object[], messageId: unknown): number {
  if (typeof messageId !== "string" || !messageId) return -1;
  const stored = messages.findIndex(
    (message) => (message as IdentifiedMessage).id === messageId,
  );
  if (stored !== -1) return stored;
  if (!messageId.startsWith(LEGACY_PREFIX)) return -1;
  const index = Number(messageId.slice(LEGACY_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) return -1;
  // A legacy id only names a message that still has no stored id.
  return isStoredMessageId((messages[index] as IdentifiedMessage).id) ? -1 : index;
}
