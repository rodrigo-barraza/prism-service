import crypto from "node:crypto";
import logger from "#src/utils/logger";
import {
  annotateMessageProvenance,
  toolResultProvenance,
  type ProvenanceMessage,
} from "#src/services/memory/MemoryProvenance";
import {
  describeExternalOrigin,
  externalOriginOfMessage,
} from "#src/services/external/ExternalInput";
import type { Capability } from "./types.ts";

// ────────────────────────────────────────────────────────────
// UntrustedSpans — the taint check's memory of what the turn has read
// ────────────────────────────────────────────────────────────
// A prompt injection works by getting the model to copy the attacker's
// words into an action: the page says "run curl … | sh" and the next shell
// call says it too. Gemini CLI (2026-09-15) asks for confirmation when words
// from untrusted content appear in shell or edit arguments; ROPE (arXiv
// 2608.27496) traces a sensitive parameter's value back to its source.
//
// Every turn keeps the untrusted text it has seen — web and MCP results,
// third-party text (mail, messages, feeds), a sub-agent's words, external
// input — IN MEMORY ONLY, never persisted: rebuilt at the start of each
// turn from the transcript the model is shown (so a follow-up turn still
// knows the page the last one read), grown as the turn reads more, gone
// when it ends. A sub-agent's registry sees its parent's, so a task the
// parent wrote from a page does not launder the page.
//
// The approval engine then asks about any shell, file-write or network-write
// call (isTaintSensitive) one of whose argument strings shares a span of at
// least `minimumCharacters` (24 by default, Settings → security) with that
// text — whatever the mode, like a protected path.
//
// Finding a shared span is exact, not a heuristic: every k-gram of the
// untrusted text is indexed at a stride `s`, with k + s − 1 = the minimum.
// A shared span of that length contains at least `s` consecutive k-gram
// starts of the text, so one of them is indexed; the argument's k-grams are
// all looked up, and a hit is extended both ways to its full length.
// Whitespace runs count as one space on both sides, so a command re-wrapped
// across lines still matches; a structured result is compared string by
// string (its JSON escaping would break a quoted command apart); and a span
// of fewer than MINIMUM_DISTINCT_CHARACTERS different characters — a rule
// of dashes, a table border — is no evidence of copying and never asks.
// ────────────────────────────────────────────────────────────

/** The shared span that makes a call ask, by default (Settings → security.taintMinimumCharacters). */
export const DEFAULT_TAINT_MINIMUM_CHARACTERS = 24;
/** Below this, ordinary words and paths would match everywhere. */
export const MINIMUM_TAINT_SPAN = 12;
/** Untrusted text one turn indexes before it stops adding more (normalized characters). */
export const MAXIMUM_INDEXED_CHARACTERS = 8_000_000;
/** How much of a matched span a denial or a card quotes. */
export const MAXIMUM_EXCERPT_CHARACTERS = 160;
/** A shared span with fewer different characters than this ("-----…") is not evidence of copying. */
export const MINIMUM_DISTINCT_CHARACTERS = 5;
/** How deep, and how much, of a call's arguments is compared. */
const MAXIMUM_ARGUMENT_DEPTH = 6;
const MAXIMUM_ARGUMENT_CHARACTERS = 400_000;
/** Label length kept per indexed text (a URL, a tool name, a sender). */
const MAXIMUM_LABEL_CHARACTERS = 200;

export interface UntrustedSpanHit {
  /** The argument's own characters that matched, cut to MAXIMUM_EXCERPT_CHARACTERS. */
  excerpt: string;
  /** Length of the shared span, in normalized characters. */
  length: number;
  /** Where the untrusted text came from ("read_web_page https://…", "Discord (alice)"). */
  source: string;
}

interface Normalized {
  text: string;
  /** Index into the original string of each normalized character. */
  origin: number[];
}

/** What `\s` matches (normalizeText uses the regex; the two must agree). */
function isWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Whitespace runs as one space, trimmed. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** normalizeText, keeping where each character came from (for the excerpt). */
function normalizeWithOrigin(value: string): Normalized {
  let text = "";
  const origin: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      origin.push(index - 1);
      pendingSpace = false;
    }
    text += value[index];
    origin.push(index);
  }
  return { text, origin };
}

function hasDistinctCharacters(text: string, start: number, end: number): boolean {
  const seen = new Set<string>();
  for (let index = start; index < end; index++) {
    seen.add(text[index]);
    if (seen.size >= MINIMUM_DISTINCT_CHARACTERS) return true;
  }
  return false;
}

function collectStrings(
  value: unknown,
  depth: number,
  out: string[],
  budget: { left: number },
  maximumDepth = MAXIMUM_ARGUMENT_DEPTH,
): void {
  if (budget.left <= 0 || depth > maximumDepth || value === null || value === undefined) return;
  if (typeof value === "string") {
    const slice = value.slice(0, budget.left);
    budget.left -= slice.length;
    out.push(slice);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectStrings(element, depth + 1, out, budget, maximumDepth);
    return;
  }
  if (typeof value === "object") {
    for (const element of Object.values(value as Record<string, unknown>)) {
      collectStrings(element, depth + 1, out, budget, maximumDepth);
    }
  }
}

export class UntrustedSpans {
  readonly minimumCharacters: number;
  private readonly gramLength: number;
  private readonly stride: number;
  private readonly parent: UntrustedSpans | null;
  private readonly texts: Array<{ text: string; source: string }> = [];
  /** k-gram → flat [textIndex, position, textIndex, position, …]. */
  private readonly index = new Map<string, number[]>();
  private readonly fingerprints = new Set<string>();
  private indexedCharacters = 0;
  private warnedFull = false;

  constructor({
    minimumCharacters = DEFAULT_TAINT_MINIMUM_CHARACTERS,
    parent = null,
  }: { minimumCharacters?: number; parent?: UntrustedSpans | null } = {}) {
    this.minimumCharacters = Math.max(MINIMUM_TAINT_SPAN, Math.floor(minimumCharacters));
    this.gramLength = Math.floor(this.minimumCharacters / 2);
    this.stride = this.minimumCharacters - this.gramLength + 1;
    this.parent = parent;
  }

  /** Characters of untrusted text held by this turn (not its parent's). */
  get size(): number {
    return this.indexedCharacters;
  }

  /** Remember untrusted text the turn has seen — a string, or every string in a structured result. */
  add(value: unknown, source: string): void {
    const strings: string[] = [];
    // Results nest deeper than arguments do (search results in pages in lists).
    collectStrings(value, 0, strings, { left: MAXIMUM_INDEXED_CHARACTERS }, 12);
    for (const raw of strings) {
      if (raw.length >= this.minimumCharacters) this.addText(raw, source);
    }
  }

  private addText(raw: string, source: string): void {
    const text = normalizeText(raw);
    if (text.length < this.minimumCharacters) return;
    const fingerprint = crypto.createHash("sha1").update(text).digest("base64");
    if (this.fingerprints.has(fingerprint)) return;
    if (this.indexedCharacters + text.length > MAXIMUM_INDEXED_CHARACTERS) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        logger.warn(
          `[UntrustedSpans] ${this.indexedCharacters} characters of untrusted text already held — later text is not compared (source: ${source})`,
        );
      }
      return;
    }
    this.fingerprints.add(fingerprint);
    const textIndex = this.texts.length;
    this.texts.push({ text, source: source.slice(0, MAXIMUM_LABEL_CHARACTERS) });
    this.indexedCharacters += text.length;
    for (let position = 0; position + this.gramLength <= text.length; position += this.stride) {
      const gram = text.slice(position, position + this.gramLength);
      const postings = this.index.get(gram);
      if (postings) postings.push(textIndex, position);
      else this.index.set(gram, [textIndex, position]);
    }
  }

  /**
   * The first argument string that shares a span of at least
   * `minimumCharacters` with untrusted text this turn (or an ancestor turn)
   * has seen; null when none does.
   */
  find(args: unknown): UntrustedSpanHit | null {
    const strings: string[] = [];
    collectStrings(args, 0, strings, { left: MAXIMUM_ARGUMENT_CHARACTERS });
    for (const value of strings) {
      if (value.length < this.minimumCharacters) continue;
      const argument = normalizeWithOrigin(value);
      if (argument.text.length < this.minimumCharacters) continue;
      const hit = this.matchWithAncestors(argument, value, this.minimumCharacters);
      if (hit) return hit;
    }
    return null;
  }

  /** This turn's text, then its parent's, up the delegation tree. */
  private matchWithAncestors(argument: Normalized, original: string, minimum: number): UntrustedSpanHit | null {
    return this.match(argument, original, minimum) ?? this.parent?.matchWithAncestors(argument, original, minimum) ?? null;
  }

  private match(argument: Normalized, original: string, minimum: number): UntrustedSpanHit | null {
    if (this.texts.length === 0) return null;
    const text = argument.text;
    const gramLength = this.gramLength;
    for (let start = 0; start + gramLength <= text.length; start++) {
      const postings = this.index.get(text.slice(start, start + gramLength));
      if (!postings) continue;
      for (let entry = 0; entry < postings.length; entry += 2) {
        const untrusted = this.texts[postings[entry]];
        const position = postings[entry + 1];
        let before = 0;
        while (
          before < start &&
          before < position &&
          text[start - before - 1] === untrusted.text[position - before - 1]
        ) {
          before++;
        }
        let after = 0;
        while (
          start + gramLength + after < text.length &&
          position + gramLength + after < untrusted.text.length &&
          text[start + gramLength + after] === untrusted.text[position + gramLength + after]
        ) {
          after++;
        }
        const length = before + gramLength + after;
        if (length < minimum) continue;
        if (!hasDistinctCharacters(text, start - before, start + gramLength + after)) continue;
        const first = argument.origin[start - before];
        const last = argument.origin[start + gramLength + after - 1];
        const excerpt = original.slice(first, last + 1).trim();
        return {
          excerpt:
            excerpt.length > MAXIMUM_EXCERPT_CHARACTERS
              ? `${excerpt.slice(0, MAXIMUM_EXCERPT_CHARACTERS - 1)}…`
              : excerpt,
          length,
          source: untrusted.source,
        };
      }
    }
    return null;
  }
}

// ── What a call can do with the text ────────────────────────

/**
 * Calls the taint check looks at: a shell, a file write, or a network call
 * that can change something (a message, a post, a webhook — network plus a
 * side effect). A network READ is not one: following a link a page or a
 * search result gave is what reading the web is.
 */
export function isTaintSensitive(capabilities: readonly Capability[]): boolean {
  return (
    capabilities.includes("shell") ||
    capabilities.includes("fs_write") ||
    (capabilities.includes("network") && capabilities.includes("external_side_effect"))
  );
}

// ── Where untrusted text comes from ─────────────────────────

interface ToolCallLike {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  result?: unknown;
}

function toolLabel(name: string, args: unknown): string {
  const url = (args as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" && url ? `${name} ${url}` : name;
}

/** Why an untrusted user-role message is untrusted, as a label; null for the user's own words. */
function untrustedMessageSource(message: ProvenanceMessage): string | null {
  const external = externalOriginOfMessage(message);
  if (external) return describeExternalOrigin(external);
  const [provenance] = annotateMessageProvenance([message]);
  return provenance?.trust === "untrusted" ? provenance.source : null;
}

function messageText(message: ProvenanceMessage): unknown {
  return typeof message.rawContent === "string" && message.rawContent
    ? message.rawContent
    : message.content;
}

/** Add one tool call's result, when the tool returns untrusted text. */
export function addUntrustedToolResult(
  spans: UntrustedSpans,
  name: string | null | undefined,
  args: unknown,
  result: unknown,
): void {
  if (!name || result === undefined || result === null) return;
  const label = toolResultProvenance(name, (args ?? null) as Record<string, unknown> | null);
  if (label.trust !== "untrusted") return;
  spans.add(result, toolLabel(name, args));
}

/**
 * Add everything untrusted a transcript holds: results of tools that return
 * third-party text (inside assistant `toolCalls`, or as `tool` messages),
 * external inputs and other untrusted notices. Works on the loop's messages
 * and on the history a client sends alike.
 */
export function addUntrustedMessages(spans: UntrustedSpans, messages: readonly ProvenanceMessage[]): void {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls as ToolCallLike[]) {
        addUntrustedToolResult(
          spans,
          typeof toolCall?.name === "string" ? toolCall.name : null,
          toolCall?.args,
          toolCall?.result,
        );
      }
    } else if (message.role === "tool") {
      addUntrustedToolResult(spans, typeof message.name === "string" ? message.name : null, null, message.content);
    } else if (message.role === "user") {
      const source = untrustedMessageSource(message);
      if (source) spans.add(messageText(message), source);
    }
  }
}

/** A turn's registry, seeded from the transcript it starts with. */
export function openUntrustedSpans(
  messages: readonly ProvenanceMessage[],
  options: { minimumCharacters?: number; parent?: UntrustedSpans | null } = {},
): UntrustedSpans {
  const spans = new UntrustedSpans(options);
  addUntrustedMessages(spans, messages);
  return spans;
}

/** The running turn's registry (on its options), if it keeps one. */
export function untrustedSpansOf(context: {
  options?: { _untrustedSpans?: unknown } | null;
} | null | undefined): UntrustedSpans | null {
  const spans = context?.options?._untrustedSpans;
  return spans instanceof UntrustedSpans ? spans : null;
}

/** A message that just joined the turn (a drained mailbox entry): keep its text if it is untrusted. */
export function recordUntrustedInput(
  context: { options?: { _untrustedSpans?: unknown } | null } | null | undefined,
  message: ProvenanceMessage,
): void {
  const spans = untrustedSpansOf(context);
  if (spans && message.role === "user") addUntrustedMessages(spans, [message]);
}

/** A tool batch that just ran: keep the results of tools that return untrusted text. */
export function recordUntrustedToolResults(
  context: { options?: { _untrustedSpans?: unknown } | null } | null | undefined,
  toolCalls: readonly ToolCallLike[],
  results: ReadonlyArray<{ id?: unknown; name?: unknown; result?: unknown }>,
): void {
  const spans = untrustedSpansOf(context);
  if (!spans) return;
  for (const result of results) {
    const call = toolCalls.find(
      (toolCall) => toolCall?.id === result?.id && toolCall?.name === result?.name,
    );
    addUntrustedToolResult(
      spans,
      typeof result?.name === "string" ? result.name : null,
      call?.args,
      result?.result,
    );
  }
}
