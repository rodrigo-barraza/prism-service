import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { NOTIFICATION_SOURCES, PROMPT_DELIMITERS } from "#src/constants";
import { LOCAL_TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { ASYNC_TASK_TOOL_NAMES } from "#src/services/AsyncTaskConstants";
import {
  externalOriginOfMessage,
  type ExternalOrigin,
} from "#src/services/external/ExternalInput";

// ────────────────────────────────────────────────────────────
// Memory provenance — where a memory came from, and how far to trust it
// ────────────────────────────────────────────────────────────
// Memories are extracted from every conversation, web pages and MCP
// results included, and injected into later sessions. Persistent memory
// poisoning (PMPA, arXiv 2609.13889) plants an instruction in a page the
// agent reads, lets extraction turn it into a "fact", and collects it in
// the next session: 55–82% cross-session success on harness agents.
//
// The defence is decided at WRITE time, which costs nothing on normal
// traffic (read-time rerankers cost 4.4 points, arXiv 2609.22818):
//   - every message a memory can be drawn from carries a provenance;
//   - a memory takes the LOWEST trust among the messages it drew on;
//   - an `untrusted` memory is stored quarantined — never injected, listed
//     for the user to Accept or Reject — until a later user message says
//     the same thing (MemoryService.store's corroboration).
//
// TAINT. Tool results never reach the extractor directly (the transcript
// is user/assistant text), so poison arrives in the assistant's words. An
// assistant message written after untrusted input is therefore untrusted
// itself: once a web page, an MCP result, a sub-agent report or an async
// task's output is in the loop, every later assistant message is tainted by
// it. A compaction summary that folded untrusted input carries that taint
// forward (`_inputProvenance`), so a summary cannot launder it.
// ────────────────────────────────────────────────────────────

export type MemoryTrust = "user" | "derived" | "untrusted";

export type MemorySource =
  | "user"
  | "assistant"
  | "web"
  | "subagent"
  | `tool:${string}`
  | `mcp:${string}`;

/** One thing a memory was drawn from. Ids and labels only — never message text. */
export interface MemorySourceRef {
  source: MemorySource;
  trust: MemoryTrust;
  conversationId?: string | null;
  /** The message's stored id, when it has one. */
  messageId?: string;
  toolCallId?: string;
  /** A memory this one was built from (consolidation). */
  memoryId?: string;
  /** A URL or a platform message id. */
  detail?: string;
}

export interface MemoryProvenance {
  source: MemorySource;
  trust: MemoryTrust;
  sourceRefs: MemorySourceRef[];
}

/** Source and trust without refs — what a compaction summary carries forward. */
export type ProvenanceLabel = Pick<MemoryProvenance, "source" | "trust">;

const TRUST_RANK: Record<MemoryTrust, number> = {
  untrusted: 0,
  derived: 1,
  user: 2,
};

/** Refs kept per memory — enough to trace it, bounded so a long span cannot bloat a document. */
export const MAX_SOURCE_REFS = 16;

/** What a memory written before provenance existed is treated as. */
export const LEGACY_PROVENANCE: ProvenanceLabel = {
  source: "assistant",
  trust: "derived",
};

export function isMemoryTrust(value: unknown): value is MemoryTrust {
  return value === "user" || value === "derived" || value === "untrusted";
}

export function isMemorySource(value: unknown): value is MemorySource {
  if (typeof value !== "string" || !value) return false;
  return (
    value === "user" ||
    value === "assistant" ||
    value === "web" ||
    value === "subagent" ||
    /^(tool|mcp):[^\s]+$/.test(value)
  );
}

/** Trust as stored, legacy documents (no field) counting as `derived`. */
export function trustOf(document: { trust?: unknown } | null | undefined): MemoryTrust {
  return isMemoryTrust(document?.trust) ? document.trust : LEGACY_PROVENANCE.trust;
}

export function sourceOf(document: { source?: unknown } | null | undefined): MemorySource {
  return isMemorySource(document?.source) ? document.source : LEGACY_PROVENANCE.source;
}

/** True when `candidate` is strictly less trusted than `current`. */
export function isLowerTrust(candidate: MemoryTrust, current: MemoryTrust): boolean {
  return TRUST_RANK[candidate] < TRUST_RANK[current];
}

/** The write-time policy: an untrusted memory waits for review. */
export function shouldQuarantine(provenance: ProvenanceLabel): boolean {
  return provenance.trust === "untrusted";
}

function refKey(ref: MemorySourceRef): string {
  return JSON.stringify([
    ref.source,
    ref.trust,
    ref.conversationId ?? null,
    ref.messageId ?? null,
    ref.toolCallId ?? null,
    ref.memoryId ?? null,
    ref.detail ?? null,
  ]);
}

/** Refs de-duplicated in order, lowest trust kept first when the cap bites. */
export function mergeSourceRefs(...lists: MemorySourceRef[][]): MemorySourceRef[] {
  const seen = new Set<string>();
  const merged: MemorySourceRef[] = [];
  for (const list of lists) {
    for (const ref of list) {
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ref);
    }
  }
  if (merged.length <= MAX_SOURCE_REFS) return merged;
  return [...merged]
    .sort((first, second) => TRUST_RANK[first.trust] - TRUST_RANK[second.trust])
    .slice(0, MAX_SOURCE_REFS);
}

/**
 * The provenance of something built from `parts`: the lowest trust among
 * them and that part's source, with every part's refs. Never more trusted
 * than its least trusted part — which is what makes consolidation unable
 * to raise trust. An empty list yields `fallback`.
 */
export function combineProvenance(
  parts: MemoryProvenance[],
  fallback: ProvenanceLabel = LEGACY_PROVENANCE,
): MemoryProvenance {
  if (parts.length === 0) return { ...fallback, sourceRefs: [] };
  let lowest = parts[0];
  for (const part of parts.slice(1)) {
    if (isLowerTrust(part.trust, lowest.trust)) lowest = part;
  }
  return {
    source: lowest.source,
    trust: lowest.trust,
    sourceRefs: mergeSourceRefs(...parts.map((part) => part.sourceRefs)),
  };
}

/** A stored memory's own provenance, legacy fields defaulted. */
export function provenanceOfDocument(document: {
  id?: unknown;
  source?: unknown;
  trust?: unknown;
  sourceRefs?: unknown;
}): MemoryProvenance {
  const source = sourceOf(document);
  const trust = trustOf(document);
  const storedRefs = Array.isArray(document.sourceRefs)
    ? (document.sourceRefs as MemorySourceRef[]).filter(
        (ref) => ref && isMemoryTrust(ref.trust) && isMemorySource(ref.source),
      )
    : [];
  const selfRef: MemorySourceRef[] =
    typeof document.id === "string" ? [{ source, trust, memoryId: document.id }] : [];
  return { source, trust, sourceRefs: mergeSourceRefs(selfRef, storedRefs) };
}

// ── Tools ───────────────────────────────────────────────────

/** Tools that return pages, search results or browser content from the open web. */
const WEB_CONTENT_TOOLS = new Set<string>([
  TOOL_NAMES.READ_WEB_PAGE,
  TOOL_NAMES.READ_URL,
  TOOL_NAMES.GET_WEB_CONTENT,
  TOOL_NAMES.WEB_CONTENT,
  TOOL_NAMES.SEARCH_WEB,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.SEARCH_WEB_PREVIEW,
  TOOL_NAMES.WEB_SEARCH_PREVIEW,
  TOOL_NAMES.GOOGLE_SEARCH,
  TOOL_NAMES.CONTROL_BROWSER,
  "execute_browser_script",
  "search_news",
  "get_market_news",
  "read_rss_feed",
  TOOL_NAMES.GET_WIKIPEDIA_SUMMARY,
]);

/**
 * Tools that return free text a third party wrote — mail, messages, forum
 * posts, video descriptions. Untrusted like the web, labelled by tool.
 */
const THIRD_PARTY_TEXT_TOOLS = new Set<string>([
  "read_email",
  "search_email",
  "list_sms_messages",
  "search_discord_messages",
  "search_reddit",
  "get_reddit_subreddit_feed",
  "get_reddit_subreddit_wiki_page",
  "get_reddit_user_history",
  "get_youtube_video",
  "search_youtube",
  "get_github_trending",
]);

/**
 * Tools that return what a sub-agent (or a background task) wrote: its
 * output is another model's words, which may carry a page it read — the same
 * external input a completion notice carries (external/ExternalInput).
 */
const SUB_AGENT_OUTPUT_TOOLS = new Set<string>([
  ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS,
  TOOL_NAMES.GET_SUBAGENT_OUTPUT,
]);

const MCP_PREFIX = "mcp__";

/** `mcp__<server>__<tool>` → `<server>`; null for any other name. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const delimiter = rest.indexOf("__");
  return delimiter > 0 ? rest.slice(0, delimiter) : rest || null;
}

/**
 * read_untrusted returns a reader's JSON, not the source's text — but the
 * JSON's strings were chosen by whoever wrote the source, so it is exactly
 * as untrusted, and labelled by what it read (ReaderSource).
 */
function readUntrustedProvenance(args?: Record<string, unknown> | null): ProvenanceLabel {
  const resource = args?.resource;
  if (resource && typeof resource === "object") {
    return toolResultProvenance(TOOL_NAMES.READ_MCP_RESOURCE, resource as Record<string, unknown>);
  }
  const tool = args?.tool as { name?: unknown; arguments?: unknown } | null | undefined;
  if (tool && typeof tool.name === "string" && tool.name !== LOCAL_TOOL_NAMES.READ_UNTRUSTED) {
    const inner = toolResultProvenance(
      tool.name,
      tool.arguments && typeof tool.arguments === "object"
        ? (tool.arguments as Record<string, unknown>)
        : null,
    );
    return { source: inner.source, trust: "untrusted" };
  }
  if (typeof args?.url === "string") return { source: "web", trust: "untrusted" };
  return { source: `tool:${LOCAL_TOOL_NAMES.READ_UNTRUSTED}`, trust: "untrusted" };
}

/** Where a tool's result comes from, and how far its text can be trusted. */
export function toolResultProvenance(
  toolName: string | null | undefined,
  args?: Record<string, unknown> | null,
): ProvenanceLabel {
  const name = toolName || "unknown";
  const server = mcpServerOf(name);
  if (server) return { source: `mcp:${server}`, trust: "untrusted" };
  if (name === TOOL_NAMES.READ_MCP_RESOURCE) {
    // The tool's parameter is `server_name`; `serverName` is the older spelling.
    const named = [args?.server_name, args?.serverName].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return { source: `mcp:${named || "resource"}`, trust: "untrusted" };
  }
  if (name === LOCAL_TOOL_NAMES.READ_UNTRUSTED) return readUntrustedProvenance(args);
  if (WEB_CONTENT_TOOLS.has(name)) return { source: "web", trust: "untrusted" };
  if (THIRD_PARTY_TEXT_TOOLS.has(name)) return { source: `tool:${name}`, trust: "untrusted" };
  if (SUB_AGENT_OUTPUT_TOOLS.has(name)) return { source: "subagent", trust: "untrusted" };
  return { source: `tool:${name}`, trust: "derived" };
}

/** Tools whose output is written by someone other than the user, the agent or the workspace. */
export function isExternalContentTool(toolName: string | null | undefined): boolean {
  return toolResultProvenance(toolName).trust === "untrusted";
}

// ── Messages ────────────────────────────────────────────────

/** The fields a provenance walk reads from a loop, display or persisted message. */
export interface ProvenanceMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  id?: unknown;
  tool_call_id?: unknown;
  toolCalls?: unknown;
  isCompactSummary?: unknown;
  _notificationSource?: unknown;
  _inputProvenance?: unknown;
  [key: string]: unknown;
}

/** Notification sources that deliver someone else's output into the loop as a user message. */
const UNTRUSTED_NOTIFICATION_SOURCES: Record<string, MemorySource> = {
  [NOTIFICATION_SOURCES.ORCHESTRATOR]: "subagent",
  [NOTIFICATION_SOURCES.SUB_AGENT_PROGRESS]: "subagent",
  // The goal verifier quotes tool results (a web read among them) back
  // into the loop: another model's output, like a sub-agent's.
  [NOTIFICATION_SOURCES.GOAL_VERIFIER]: "subagent",
  // A background task's output is a tool result whose tool the message no
  // longer names — it may have been a web read.
  [NOTIFICATION_SOURCES.ASYNC_TASK]: `tool:${NOTIFICATION_SOURCES.ASYNC_TASK}`,
  [NOTIFICATION_SOURCES.BACKGROUND_TASK]: `tool:${NOTIFICATION_SOURCES.BACKGROUND_TASK}`,
};

/** Notification sources whose text the user wrote. */
const USER_NOTIFICATION_SOURCES = new Set<string>([
  NOTIFICATION_SOURCES.USER_UPDATE,
  NOTIFICATION_SOURCES.USER_ANSWER,
]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

function isCompactionSummary(message: ProvenanceMessage): boolean {
  return (
    message.isCompactSummary === true ||
    (message.role === "user" &&
      contentText(message.content).startsWith(PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX))
  );
}

function storedMessageId(message: ProvenanceMessage): string | undefined {
  return typeof message.id === "string" && message.id ? message.id : undefined;
}

function withRef(label: ProvenanceLabel, ref: Omit<MemorySourceRef, "source" | "trust">): MemoryProvenance {
  return { ...label, sourceRefs: [{ source: label.source, trust: label.trust, ...ref }] };
}

/**
 * An external input's source as memory names it: a sub-agent, an MCP
 * server by name, or the tool-like channel it came through.
 */
export function externalInputSource(origin: ExternalOrigin): MemorySource {
  if (origin.source === "subagent") return "subagent";
  if (origin.source === "mcp") {
    const server = origin.sender?.replace(/[^A-Za-z0-9._-]/g, "");
    return `mcp:${server || "server"}`;
  }
  return `tool:${origin.source}`;
}

/** A user-role message's own provenance: the user, the harness, or someone else's output. */
function userMessageLabel(message: ProvenanceMessage): ProvenanceLabel {
  // Input from outside the conversation, whatever else it carries.
  const external = externalOriginOfMessage(message);
  if (external) return { source: externalInputSource(external), trust: "untrusted" };
  const notification =
    typeof message._notificationSource === "string" ? message._notificationSource : null;
  if (notification) {
    if (USER_NOTIFICATION_SOURCES.has(notification)) return { source: "user", trust: "user" };
    const untrustedSource = UNTRUSTED_NOTIFICATION_SOURCES[notification];
    if (untrustedSource) return { source: untrustedSource, trust: "untrusted" };
    // Timers, the scheduler: the harness speaking, not the user.
    return { source: "assistant", trust: "derived" };
  }
  if (contentText(message.content).startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)) {
    return { source: "assistant", trust: "derived" };
  }
  return { source: "user", trust: "user" };
}

function carriedLabel(value: unknown): ProvenanceLabel | null {
  const label = value as Partial<ProvenanceLabel> | null | undefined;
  if (!label || !isMemoryTrust(label.trust) || !isMemorySource(label.source)) return null;
  return { source: label.source, trust: label.trust };
}

function urlOf(args: unknown): string | undefined {
  const url = (args as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" && url ? url.slice(0, 500) : undefined;
}

/**
 * The provenance of each message's own text, index-aligned with `messages`
 * (null for messages no memory is drawn from: tool results, system
 * messages, compaction summaries). See TAINT above. Works on the loop's
 * messages (results inside `assistant.toolCalls`) and on the persisted
 * shape (separate `role: "tool"` messages) alike.
 */
export function annotateMessageProvenance(
  messages: ProvenanceMessage[],
  { conversationId = null }: { conversationId?: string | null } = {},
): Array<MemoryProvenance | null> {
  let taint: MemoryProvenance | null = null;
  const absorb = (input: MemoryProvenance) => {
    if (input.trust !== "untrusted") return;
    taint = taint ? combineProvenance([taint, input]) : input;
  };

  return messages.map((message): MemoryProvenance | null => {
    const messageId = storedMessageId(message);
    if (message.role === "user") {
      if (isCompactionSummary(message)) {
        const carried = carriedLabel(message._inputProvenance);
        if (carried) absorb(withRef(carried, { conversationId, messageId }));
        return null;
      }
      const own = withRef(userMessageLabel(message), { conversationId, messageId });
      absorb(own);
      return own;
    }
    if (message.role === "assistant") {
      const current = taint as MemoryProvenance | null;
      const own: MemoryProvenance = current
        ? {
            source: current.source,
            trust: current.trust,
            sourceRefs: mergeSourceRefs(current.sourceRefs, [
              { source: "assistant", trust: current.trust, conversationId, messageId },
            ]),
          }
        : withRef({ source: "assistant", trust: "derived" }, { conversationId, messageId });
      // The text came before these calls ran; their results taint what follows.
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
        const label = toolResultProvenance(
          typeof toolCall?.name === "string" ? toolCall.name : null,
          toolCall?.args as Record<string, unknown> | undefined,
        );
        absorb(
          withRef(label, {
            conversationId,
            messageId,
            toolCallId: typeof toolCall?.id === "string" ? toolCall.id : undefined,
            detail: urlOf(toolCall?.args),
          }),
        );
      }
      return own;
    }
    if (message.role === "tool") {
      absorb(
        withRef(toolResultProvenance(typeof message.name === "string" ? message.name : null), {
          conversationId,
          toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
        }),
      );
    }
    return null;
  });
}

/**
 * The least trusted input anywhere in the loop — what text the model writes
 * next is derived from. Null when every input came from the user, the agent
 * or the workspace.
 */
export function untrustedInputProvenance(
  messages: ProvenanceMessage[] | null | undefined,
  options: { conversationId?: string | null } = {},
): MemoryProvenance | null {
  if (!messages?.length) return null;
  // A trailing assistant probe reads the taint after every message.
  const annotated = annotateMessageProvenance([...messages, { role: "assistant" }], options);
  const probe = annotated[annotated.length - 1];
  return probe && probe.trust === "untrusted" ? probe : null;
}

/**
 * What `save_memory` writes when the model calls it: the agent's own words,
 * as tainted as the loop it is running in.
 */
export function agentWriteProvenance(
  messages: ProvenanceMessage[] | null | undefined,
  options: { conversationId?: string | null } = {},
): MemoryProvenance {
  const taint = untrustedInputProvenance(messages, options);
  if (taint) return taint;
  return withRef(
    { source: "assistant", trust: "derived" },
    { conversationId: options.conversationId ?? null },
  );
}

// ── Corroboration ───────────────────────────────────────────

/**
 * Cosine similarity at which a user-sourced memory is a CANDIDATE to
 * corroborate a quarantined one (MemoryService.store). Only a candidate:
 * embeddings barely separate "freeze starts 2026-10-05" from "…2026-11-05",
 * so promotion also needs `restates`. Measured live 2026-09-22 with
 * gemini-embedding-2-preview: the same fact reworded by the user 0.847,
 * unrelated memories 0.61–0.65.
 */
export const CORROBORATION_CANDIDATE_THRESHOLD = 0.8;

/** English function words; other languages only make the check stricter, never looser. */
const STOPWORDS = new Set([
  "about", "after", "also", "been", "before", "being", "does", "every", "from",
  "have", "into", "just", "like", "more", "must", "only", "over", "should",
  "that", "their", "them", "then", "there", "these", "they", "this", "user",
  "very", "what", "when", "where", "which", "will", "with", "would", "your",
]);

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const CJK = /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HIRAGANA_ONLY = /^\p{Script=Hiragana}+$/u;

/**
 * Tokens that pin a claim down: a run of ASCII letters, digits and code
 * punctuation that holds a digit or code punctuation — a date, a version,
 * a URL, a command. ASCII runs, so "2026-10-05から" still yields the date.
 */
function specificTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9._/:|$@=`~+#%-]+/g) || [])
    .map((token) => token.replace(/^[.:-]+|[.,:;!?-]+$/g, ""))
    .filter((token) => token.length > 1 && (/\d/.test(token) || /[/:_|$@=`]|\w\.\w/.test(token)));
}

/**
 * The content words of a text, as comparison keys, in any language:
 * words from Intl.Segmenter; CJK words of two or more characters whole
 * (hiragana-only ones are particles and endings); other words of four or
 * more letters by their first five — enough that "starting" meets "starts"
 * and "congelación" meets "congelamiento". Digits are specificTokens' job.
 */
function contentKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const { segment, isWordLike } of WORDS.segment(text.toLowerCase())) {
    if (!isWordLike || /^\p{N}+$/u.test(segment)) continue;
    if (CJK.test(segment)) {
      if (segment.length >= 2) keys.add(segment);
      continue;
    }
    if (HIRAGANA_ONLY.test(segment)) continue;
    if (segment.length < 4 || STOPWORDS.has(segment)) continue;
    keys.add(segment.slice(0, 5));
  }
  return keys;
}

/**
 * True when `statement` (what the user said) restates `claim` (what an
 * untrusted source said): every specific token of the claim — a date, a
 * number, a URL, a command — appears in the statement, and at least half of
 * the claim's content words do, in whatever language (contentKeys). Embedding similarity only nominates a
 * candidate; this is what stops a user's "the freeze starts 2026-10-05"
 * from vouching for a page's "the freeze starts 2026-11-05".
 */
export function restates(claim: string, statement: string): boolean {
  const said = statement.toLowerCase();
  if (!specificTokens(claim).every((token) => said.includes(token))) return false;
  const claimed = contentKeys(claim);
  if (claimed.size === 0) return true;
  const saidKeys = contentKeys(statement);
  let agreed = 0;
  for (const key of claimed) if (saidKeys.has(key)) agreed++;
  return agreed / claimed.size >= 0.5;
}

// ── Attribution backstop ────────────────────────────────────

const PHRASE_WORDS = 5;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function phrases(text: string): Set<string> {
  const tokens = words(text);
  const result = new Set<string>();
  for (let index = 0; index + PHRASE_WORDS <= tokens.length; index++) {
    result.add(tokens.slice(index, index + PHRASE_WORDS).join(" "));
  }
  return result;
}

/**
 * True when `memoryText` repeats a five-word phrase that appears in
 * `untrustedText` and in none of `citedTexts`. A memory claiming to come
 * from the user's words cannot quote a page the user never wrote — this
 * catches an extraction that cites the wrong message, whether by mistake
 * or because the page told it to.
 */
export function quotesUncitedText(
  memoryText: string,
  untrustedText: string,
  citedTexts: string[],
): boolean {
  const untrusted = phrases(untrustedText);
  if (untrusted.size === 0) return false;
  const cited = new Set<string>();
  for (const text of citedTexts) for (const phrase of phrases(text)) cited.add(phrase);
  for (const phrase of phrases(memoryText)) {
    if (untrusted.has(phrase) && !cited.has(phrase)) return true;
  }
  return false;
}
