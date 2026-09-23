import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { PROMPT_DELIMITERS } from "#src/constants";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { pristineOf } from "./MessageLineage.ts";
import { isStoredMessageId, newMessageId } from "#src/services/conversation/messageIds";
import type { ProvenanceLabel } from "#src/services/memory/MemoryProvenance";

// ────────────────────────────────────────────────────────────
// CompactionBoundary — a summary that is paid for once
// ────────────────────────────────────────────────────────────
// A compaction summary used to live only inside the loop that made it:
// the Finalizer drops it at persistence, the client sends the full
// history next turn, and a conversation past the threshold paid for a
// fresh summary on EVERY turn.
//
// Now the latest summary is persisted on the conversation document as a
// boundary: { summary, throughMessageId, … }. Loading the next turn
// replaces every message up to and including `throughMessageId` with the
// summary (system → summary → the messages after the boundary). The
// persisted transcript itself is untouched — the boundary is a view.
//
// Messages are addressed by their `id` — the one server-minted id every
// persisted message carries (conversation/messageIds.ts), the same one
// rewind and fork address. It survives the round trip the client makes
// (persist → displayMessages → client → next request body). A boundary
// anchored in the CURRENT turn names a provisional id the loop gives the
// message; appendMessages mints the real one and re-points the boundary
// (followMintedAnchor). A served-only `legacy-<index>` id is never named.
//
// Falls back to today's behaviour (full history, re-summarized if still
// over the threshold) whenever the boundary cannot be trusted:
//   - the document has none (legacy, or cleared by a PATCH that rewrote
//     the messages — an edit or delete inside the summarized span);
//   - its message is not in the history (rewound/pruned, deleted, or a
//     client that sent a truncated history).
// ────────────────────────────────────────────────────────────

export interface CompactionBoundary {
  /** The summary text (with its recovery index) that stands in for the covered span. */
  summary: string;
  /** `id` of the last message the summary covers. */
  throughMessageId: string;
  createdAt: string;
  /** The utility model that wrote the summary. */
  provider: string;
  model: string;
  /** chars/4 size of the history before and after this compaction. */
  tokensBefore: number;
  tokensAfter: number;
  /**
   * The least trusted input the summary folded, when that was untrusted (a
   * web page, an MCP result…). The summary may repeat it, so what the agent
   * writes after it stays tainted for memory provenance.
   */
  inputProvenance?: ProvenanceLabel | null;
}

interface BoundaryMessage {
  role: string;
  content?: unknown;
  toolCalls?: Array<{ id?: string | null }> | unknown;
  tool_call_id?: string | null;
  id?: unknown;
  isCompactSummary?: boolean;
  compactionThroughMessageId?: string;
  _alreadyPersisted?: boolean;
  _isPlanningInjection?: boolean;
  _isIdentityPrompt?: boolean;
  [key: string]: unknown;
}

export function isCompactionBoundary(value: unknown): value is CompactionBoundary {
  const boundary = value as Partial<CompactionBoundary> | null | undefined;
  return (
    !!boundary &&
    typeof boundary.summary === "string" &&
    boundary.summary.length > 0 &&
    typeof boundary.throughMessageId === "string" &&
    boundary.throughMessageId.length > 0
  );
}

/**
 * appendMessages mints a fresh id for every message it appends, replacing
 * whatever id the message came with — including the provisional id
 * resolveBoundaryAnchorId gave a current-turn anchor. A boundary persisted
 * in the same append follows its message to the minted id. `before` and
 * `minted` are the appended messages before and after minting (same order).
 */
export function followMintedAnchor<T>(
  boundary: T,
  before: ReadonlyArray<object>,
  minted: ReadonlyArray<object>,
): T {
  if (!isCompactionBoundary(boundary)) return boundary;
  const index = before.findIndex(
    (message) => (message as { id?: unknown }).id === boundary.throughMessageId,
  );
  const mintedId = index >= 0 ? (minted[index] as { id?: unknown } | undefined)?.id : undefined;
  if (typeof mintedId !== "string" || mintedId === boundary.throughMessageId) return boundary;
  return { ...boundary, throughMessageId: mintedId };
}

/**
 * A message the Finalizer persists and the client sends back — the only
 * kind a boundary can name. Mirrors the persistence filters
 * (sanitizeMessagesForPersistence, expandToolCallsForPersistence).
 */
function isAddressable(message: BoundaryMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.isCompactSummary === true) return false;
  if (message._isPlanningInjection === true || message._isIdentityPrompt === true) return false;
  const content = typeof message.content === "string" ? message.content : "";
  if (
    message.role === "user" &&
    (content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX) ||
      content.startsWith(PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX))
  ) {
    return false;
  }
  const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  if (message.role === "assistant" && !content.trim() && !hasToolCalls) return false;
  return true;
}

/**
 * The `id` a boundary covering `droppedSpan` should name: the newest
 * addressable message in the span. A message of the current turn has no
 * stored id yet — it gets a provisional one now (on its verbatim original
 * too, so the Finalizer appends it with that id and appendMessages can
 * re-point the boundary at the id it mints). A message persisted before
 * ids existed (served as `legacy-<index>`) cannot be named: returns null
 * and the boundary is not persisted (the next turn re-summarizes, as
 * before, until the span reaches newer messages). A summary from an
 * earlier boundary stands for that boundary's message.
 */
export function resolveBoundaryAnchorId(droppedSpan: BoundaryMessage[]): string | null {
  for (let index = droppedSpan.length - 1; index >= 0; index--) {
    const viewMessage = droppedSpan[index];
    const message = pristineOf(viewMessage);
    if (message.isCompactSummary === true) {
      return typeof message.compactionThroughMessageId === "string"
        ? message.compactionThroughMessageId
        : null;
    }
    if (!isAddressable(message)) continue;
    if (isStoredMessageId(message.id)) return message.id;
    if (message._alreadyPersisted === true) return null;
    const provisionalId = newMessageId();
    message.id = provisionalId;
    viewMessage.id = provisionalId;
    return provisionalId;
  }
  return null;
}

export interface CompactionSummaryMessage {
  role: "user";
  content: string;
  isCompactSummary: true;
  compactionThroughMessageId?: string;
  /** Untrusted input the summary folded (CompactionBoundary.inputProvenance). */
  _inputProvenance?: ProvenanceLabel;
  [key: string]: unknown;
}

/** The synthetic message a summary is injected as (never persisted — isCompactSummary). */
export function buildCompactionSummaryMessage(
  summary: string,
  throughMessageId: string | null,
  inputProvenance: ProvenanceLabel | null = null,
): CompactionSummaryMessage {
  return {
    role: "user",
    content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${summary}`,
    isCompactSummary: true,
    ...(throughMessageId && { compactionThroughMessageId: throughMessageId }),
    ...(inputProvenance && { _inputProvenance: inputProvenance }),
  };
}

export interface AppliedCompactionBoundary<T> {
  messages: T[];
  applied: boolean;
  /** Why the boundary was (not) applied — for the load-path log line. */
  reason: string;
}

/**
 * Fold a loaded history at its boundary: leading system messages, then the
 * summary, then every message after `throughMessageId`. Works on both the
 * display shape the client sends (tool results inside assistant.toolCalls)
 * and the raw persisted shape (separate role:"tool" messages — the anchor's
 * own results are folded with it). Pure; returns the input unchanged when
 * the boundary does not apply.
 */
export function applyCompactionBoundary<T extends object>(
  messages: T[],
  boundary: CompactionBoundary | null | undefined,
): AppliedCompactionBoundary<T> {
  if (!boundary) return { messages, applied: false, reason: "no boundary" };
  if (!isCompactionBoundary(boundary)) {
    return { messages, applied: false, reason: "malformed boundary" };
  }
  const history = messages as unknown as BoundaryMessage[];
  let anchorIndex = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].id === boundary.throughMessageId) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) {
    return {
      messages,
      applied: false,
      reason: `boundary message ${boundary.throughMessageId} is not in the history (rewound, deleted or never sent)`,
    };
  }

  const anchor = history[anchorIndex];
  const anchorCallIds = new Set(
    (Array.isArray(anchor.toolCalls) ? anchor.toolCalls : [])
      .map((toolCall: { id?: string | null }) => toolCall?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  let tailStart = anchorIndex + 1;
  while (
    tailStart < history.length &&
    history[tailStart].role === "tool" &&
    (anchorCallIds.size === 0 ||
      anchorCallIds.has(history[tailStart].tool_call_id as string))
  ) {
    tailStart++;
  }

  let leadingSystemCount = 0;
  while (
    leadingSystemCount < anchorIndex &&
    history[leadingSystemCount].role === "system"
  ) {
    leadingSystemCount++;
  }

  const folded = [
    ...messages.slice(0, leadingSystemCount),
    buildCompactionSummaryMessage(
      boundary.summary,
      boundary.throughMessageId,
      boundary.inputProvenance ?? null,
    ) as unknown as T,
    ...messages.slice(tailStart),
  ];
  return {
    messages: folded,
    applied: true,
    reason: `summary replaces ${tailStart - leadingSystemCount} message(s) through ${boundary.throughMessageId}`,
  };
}

export interface CompactionState {
  boundary: CompactionBoundary | null;
  /**
   * real ÷ chars/4 input ratio the conversation's last turn measured
   * (its persisted contextBudget) — calibrates the next turn's first
   * compaction-trigger estimate (ContextBudgets.estimateRequestInputTokens).
   */
  calibrationRatio: number | null;
}

/** The compaction state carried by a loaded conversation document. */
export function readCompactionState(document: unknown): CompactionState {
  const fields = (document || {}) as {
    compaction?: unknown;
    contextBudget?: { calibrationRatio?: unknown } | null;
  };
  const ratio = fields.contextBudget?.calibrationRatio;
  return {
    boundary: isCompactionBoundary(fields.compaction) ? fields.compaction : null,
    calibrationRatio:
      typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : null,
  };
}

/**
 * Read a conversation's boundary and calibration. Fail-open: any read error
 * means "nothing known" — the turn then loads the full history, exactly as
 * before.
 */
export async function loadCompactionState(
  conversationId: string,
  project: string,
  username: string,
  collection: string,
): Promise<CompactionState> {
  try {
    const document = await MongoWrapper.getCollection(MONGO_DB_NAME, collection).findOne(
      { id: conversationId, project, username },
      { projection: { compaction: 1, "contextBudget.calibrationRatio": 1 } },
    );
    return readCompactionState(document);
  } catch (error: unknown) {
    logger.warn(
      `[CompactionBoundary] Could not read the boundary of ${conversationId} — loading full history: ${errorMessage(error)}`,
    );
    return { boundary: null, calibrationRatio: null };
  }
}
