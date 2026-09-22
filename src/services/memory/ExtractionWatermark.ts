import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import {
  COLLECTIONS,
  LOG_PREVIEW,
  MEMORY,
  NOTIFICATION_SOURCES,
  PROMPT_DELIMITERS,
} from "#src/constants";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// Memory-extraction watermark — the `memory:extract` diet
// ────────────────────────────────────────────────────────────
// Extraction runs after every response. It used to re-read the whole
// transcript every time (~11.6K input tokens a call, 14% of all spend in
// 2026-08). Now each extraction reads only the messages after the last
// one already extracted, plus a small fixed context window, and a span
// with (almost) nothing the user wrote makes no call at all.
//
// SCOPE. The watermark belongs to the transcript the model sees, which is
// not always one conversation: a platform bot (Lupos on Discord) opens a
// NEW conversation per reply and sends the channel's recent history as
// context, so 358 of 367 extractions over 30 days were first-and-only
// calls on their conversation. With MEMORY_EXTRACTION_CHANNEL_WATERMARK
// on, such a turn is keyed by its channel (`agentContext.platform/
// guildId/channelId`); every other turn — and a platform turn with the
// flag off, the default (see config.ts for the measurement) — by its
// conversation id. Both live in one small collection, so nothing that
// rewrites a conversation document (compaction, a PATCH, a rewind) can
// reset a watermark.
//
// IDENTITY. Persisted messages carry no id. A message is identified by
// what it says: a platform-issued id when the text embeds one (Discord's
// `<discord-message id="…">`, unique and stable across calls), else a hash
// of role + normalized text. Both `content` and `rawContent` are hashed
// because persistence SWAPS them on user messages (Finalizer
// swapMessageContent) — the in-memory copy extracted this turn and the
// copy the client sends back next turn share the pair, not the field. A
// repeated short reply ("Done.") is disambiguated by also matching the
// message before it (the anchor).
//
// WHEN THE WATERMARK IS NOT FOUND:
//   - a compaction summary is in the transcript → everything after it is
//     new (the watermark message was summarized away, so the whole kept
//     tail came after it). The summary itself is never extracted from.
//   - otherwise (history edited, window scrolled past it) → the whole
//     transcript, i.e. what every call read before the diet. Logged.
// ────────────────────────────────────────────────────────────

/** One user/assistant message as the extractor sees it. */
export interface TranscriptEntry {
  role: "user" | "assistant";
  /** Prompt text, truncated per message as before the diet. */
  text: string;
  /** Content-derived identities — platform ids first. */
  identities: string[];
  /** Characters the user actually wrote (0 for assistant or harness-injected turns). */
  authoredCharacters: number;
}

export interface ExtractionTranscript {
  entries: TranscriptEntry[];
  /** Index of the first entry after the latest compaction summary; -1 when there is none. */
  afterSummaryIndex: number;
}

/** Stored per scope; `memoryExtractedThroughMessageId` names the last extracted message. */
export interface ExtractionWatermark {
  memoryExtractedThroughMessageId: string;
  /** Every identity of that message (content and rawContent may have swapped). */
  throughMessageIdentities: string[];
  /** Identities of the message before it — disambiguates a repeated short message. */
  anchorMessageIdentities: string[];
  /** Latest platform-issued id at or before it (Discord), matched when the text drifted. */
  platformThroughMessageId: string | null;
}

export type SpanReason =
  | "first"
  | "watermark"
  | "platform-id"
  | "after-compaction"
  | "watermark-lost";

export interface ExtractionSpan {
  /** Already extracted — shown so the new span can be read in context. */
  context: TranscriptEntry[];
  /** Not yet extracted. */
  span: TranscriptEntry[];
  reason: SpanReason;
}

export interface WatermarkScope {
  key: string;
  project: string;
  agent: string;
  profileId: string;
  scope: string;
}

const PLATFORM_IDENTITY_PREFIX = "discord:";
// `id=` on the opening <discord-message> tag only — not author-id, not a
// <replying-to id=…> nested inside it.
const DISCORD_MESSAGE_ID_PATTERN = /<discord-message\b[^>]*?\sid="([^"]+)"/g;
const DISCORD_CONTENT_PATTERN = /<content>([\s\S]*?)<\/content>/g;
const TAG_PATTERN = /<[^>]+>/g;

/** Notification sources whose text the user wrote themselves. */
const USER_AUTHORED_NOTIFICATION_SOURCES = new Set<string>([
  NOTIFICATION_SOURCES.USER_UPDATE,
  NOTIFICATION_SOURCES.USER_ANSWER,
]);

interface TranscriptMessage {
  role?: unknown;
  content?: unknown;
  rawContent?: unknown;
  isCompactSummary?: unknown;
  _notificationSource?: unknown;
  [key: string]: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCompactionSummary(message: TranscriptMessage): boolean {
  if (message.isCompactSummary === true) return true;
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX)
  );
}

export function isPlatformIdentity(identity: string): boolean {
  return identity.startsWith(PLATFORM_IDENTITY_PREFIX);
}

/**
 * Identities of one message: every Discord message id its text embeds,
 * then a hash of role + normalized text for `content` and for `rawContent`.
 */
export function messageIdentities(message: TranscriptMessage): string[] {
  const role = String(message.role);
  const texts = [contentText(message.content), contentText(message.rawContent)]
    .map(normalize)
    .filter(Boolean);
  const identities: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(DISCORD_MESSAGE_ID_PATTERN)) {
      identities.push(`${PLATFORM_IDENTITY_PREFIX}${match[1]}`);
    }
  }
  for (const text of texts) {
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    identities.push(`${role}:${digest.slice(0, 24)}`);
  }
  return [...new Set(identities)];
}

/**
 * Characters of a user message that the user wrote: not a harness
 * notification (orchestrator, timer, scheduler…), not a context note, and
 * for a Discord message only the <content> — its envelope of ids,
 * authors and timestamps is not something anyone said.
 *
 * Of `content` and `rawContent` the shorter is the user's own text: the
 * other one wraps it (injected context, a <user-update> tag), and which
 * field holds which flips at persistence.
 */
export function authoredCharacters(message: TranscriptMessage): number {
  if (message.role !== "user") return 0;
  const source = message._notificationSource;
  if (
    typeof source === "string" &&
    !USER_AUTHORED_NOTIFICATION_SOURCES.has(source)
  ) {
    return 0;
  }
  const content = contentText(message.content);
  if (content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)) return 0;
  const text = [content, contentText(message.rawContent)]
    .filter((candidate) => candidate.trim())
    .reduce(
      (shortest, candidate) =>
        !shortest || candidate.length < shortest.length ? candidate : shortest,
      "",
    );
  if (text.includes("<discord-message")) {
    const spoken = [...text.matchAll(DISCORD_CONTENT_PATTERN)]
      .map((match) => match[1])
      .join(" ");
    return normalize(spoken || text.replace(TAG_PATTERN, " ")).length;
  }
  return normalize(text).length;
}

/**
 * The user/assistant messages an extraction can read, in order. Messages
 * without text (tool-call-only assistant turns) are dropped, as before;
 * a compaction summary is dropped and remembered as a boundary.
 */
export function buildExtractionTranscript(
  messages: TranscriptMessage[],
): ExtractionTranscript {
  const entries: TranscriptEntry[] = [];
  let afterSummaryIndex = -1;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (isCompactionSummary(message)) {
      afterSummaryIndex = entries.length;
      continue;
    }
    const content = contentText(message.content);
    if (!content.trim()) continue;
    entries.push({
      role: message.role,
      text:
        content.length > LOG_PREVIEW.LONG
          ? content.slice(0, LOG_PREVIEW.LONG) + "..."
          : content,
      identities: messageIdentities(message),
      authoredCharacters: authoredCharacters(message),
    });
  }
  return { entries, afterSummaryIndex };
}

function intersects(identities: string[], wanted: Set<string>): boolean {
  return identities.some((identity) => wanted.has(identity));
}

/** Index of the watermark message in `entries`, latest match first; -1 when absent. */
function locateWatermark(
  entries: TranscriptEntry[],
  watermark: ExtractionWatermark,
): { index: number; reason: "watermark" | "platform-id" } | null {
  const through = new Set(watermark.throughMessageIdentities || []);
  const anchor = new Set(watermark.anchorMessageIdentities || []);
  for (let index = entries.length - 1; index >= 0; index--) {
    const identities = entries[index].identities;
    if (!intersects(identities, through)) continue;
    const platformHit = identities.some(
      (identity) => through.has(identity) && isPlatformIdentity(identity),
    );
    if (platformHit || anchor.size === 0) return { index, reason: "watermark" };
    if (index > 0 && intersects(entries[index - 1].identities, anchor)) {
      return { index, reason: "watermark" };
    }
  }
  const platformId = watermark.platformThroughMessageId;
  if (platformId) {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].identities.includes(platformId)) {
        return { index, reason: "platform-id" };
      }
    }
  }
  return null;
}

/** Split the transcript into what was already extracted and what was not. */
export function selectExtractionSpan(
  transcript: ExtractionTranscript,
  watermark: ExtractionWatermark | null,
  contextEntries: number = MEMORY.EXTRACTION_CONTEXT_ENTRIES,
): ExtractionSpan {
  const { entries, afterSummaryIndex } = transcript;
  if (!watermark) return { context: [], span: entries, reason: "first" };

  const located = locateWatermark(entries, watermark);
  if (located) {
    const start = located.index + 1;
    return {
      context: entries.slice(Math.max(0, start - contextEntries), start),
      span: entries.slice(start),
      reason: located.reason,
    };
  }
  if (afterSummaryIndex !== -1) {
    return {
      context: [],
      span: entries.slice(afterSummaryIndex),
      reason: "after-compaction",
    };
  }
  return { context: [], span: entries, reason: "watermark-lost" };
}

/** Sum of user-written characters in a span — the "is it trivial" measure. */
export function spanAuthoredCharacters(span: TranscriptEntry[]): number {
  return span.reduce((total, entry) => total + entry.authoredCharacters, 0);
}

/** The watermark that marks every entry of `transcript` as extracted; null when empty. */
export function watermarkThroughEnd(
  transcript: ExtractionTranscript,
): ExtractionWatermark | null {
  const { entries } = transcript;
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  let platformThroughMessageId: string | null = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const platformIds = entries[index].identities.filter(isPlatformIdentity);
    if (platformIds.length > 0) {
      platformThroughMessageId = platformIds[platformIds.length - 1];
      break;
    }
  }
  return {
    memoryExtractedThroughMessageId: last.identities[0],
    throughMessageIdentities: last.identities,
    anchorMessageIdentities:
      entries.length > 1 ? entries[entries.length - 2].identities : [],
    platformThroughMessageId,
  };
}

/**
 * The extraction scope of a turn: its platform channel when the caller sent
 * one (a bot that opens a conversation per reply) and channel scoping is
 * on, else its conversation. Null when the turn has neither — it then
 * reads its whole transcript.
 */
export function resolveWatermarkScope({
  project,
  agent,
  profileId,
  conversationId,
  agentContext,
  channelScope,
}: {
  project: string;
  agent: string;
  profileId: string;
  conversationId?: string | null;
  agentContext?: unknown;
  channelScope: boolean;
}): WatermarkScope | null {
  let scope: string | null = null;
  if (channelScope && agentContext && typeof agentContext === "object") {
    const { platform, guildId, channelId } = agentContext as Record<
      string,
      unknown
    >;
    const channel =
      typeof channelId === "string" || typeof channelId === "number"
        ? String(channelId)
        : "";
    if (typeof platform === "string" && platform && channel) {
      const guild =
        typeof guildId === "string" || typeof guildId === "number"
          ? String(guildId)
          : "direct";
      scope = `channel:${platform}:${guild}:${channel}`;
    }
  }
  if (!scope && conversationId) scope = `conversation:${conversationId}`;
  if (!scope) return null;
  return {
    key: [project, agent, profileId, scope].join("|"),
    project,
    agent,
    profileId,
    scope,
  };
}

function watermarkCollection() {
  return MongoWrapper.getCollection(
    MONGO_DB_NAME,
    COLLECTIONS.MEMORY_EXTRACTION_WATERMARKS,
  );
}

let expiryIndexRequested = false;

/** Once per process: expire watermarks nobody has advanced in a while. */
function ensureExpiryIndex(
  collection: NonNullable<ReturnType<typeof watermarkCollection>>,
): void {
  if (expiryIndexRequested || typeof collection.createIndex !== "function") {
    return;
  }
  expiryIndexRequested = true;
  collection
    .createIndex(
      { updatedAt: 1 },
      {
        expireAfterSeconds: MEMORY.EXTRACTION_WATERMARK_TTL_DAYS * 24 * 60 * 60,
      },
    )
    .catch((error: unknown) => {
      logger.warn(
        `[ExtractionWatermark] expiry index creation failed: ${errorMessage(error)}`,
      );
    });
}

/**
 * Persistence for watermarks. Best-effort in both directions: a failed read
 * degrades to reading the whole transcript (pre-diet behaviour), a failed
 * write to re-reading this span next time. Neither ever throws.
 *
 * Two extractions racing on one scope (two Discord replies seconds apart)
 * both read the old watermark and the last writer wins. That re-reads an
 * overlap; it never skips a message, which is why the write happens only
 * after a successful call rather than before it.
 */
export const ExtractionWatermarkStore = {
  async read(scope: WatermarkScope): Promise<ExtractionWatermark | null> {
    try {
      const collection = watermarkCollection();
      if (!collection) return null;
      const document = (await collection.findOne({
        _id: scope.key,
      } as never)) as (ExtractionWatermark & Record<string, unknown>) | null;
      if (!document?.memoryExtractedThroughMessageId) return null;
      return {
        memoryExtractedThroughMessageId:
          document.memoryExtractedThroughMessageId,
        throughMessageIdentities: document.throughMessageIdentities || [],
        anchorMessageIdentities: document.anchorMessageIdentities || [],
        platformThroughMessageId: document.platformThroughMessageId || null,
      };
    } catch (error: unknown) {
      logger.warn(
        `[ExtractionWatermark] read failed for ${scope.scope}: ${errorMessage(error)}`,
      );
      return null;
    }
  },

  async write(
    scope: WatermarkScope,
    watermark: ExtractionWatermark,
  ): Promise<void> {
    try {
      const collection = watermarkCollection();
      if (!collection) return;
      ensureExpiryIndex(collection);
      const now = new Date();
      await collection.updateOne(
        { _id: scope.key } as never,
        {
          $set: { ...watermark, updatedAt: now },
          $setOnInsert: {
            project: scope.project,
            agent: scope.agent,
            profileId: scope.profileId,
            scope: scope.scope,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error: unknown) {
      logger.warn(
        `[ExtractionWatermark] write failed for ${scope.scope}: ${errorMessage(error)}`,
      );
    }
  },
};
