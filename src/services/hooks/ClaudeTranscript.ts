import crypto from "node:crypto";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import { TOOLS_SERVICE_URL } from "#config";
import { TURN_INPUT } from "#src/constants";
import { traceHeaders } from "#src/services/Tracing";
import logger from "#src/utils/logger";
import { CLAUDE_TRANSCRIPT } from "#src/services/hooks/WorkspaceHookConstants";
import type { ToolCall, ToolResult } from "#src/services/harnesses/types";

/**
 * ClaudeTranscript — a conversation's turns as Claude Code JSONL, kept on
 * the machine the workspace is on, so a command hook that reads
 * `transcript_path` (a Stop hook looking for the last gate verdict, a
 * session log) works unchanged.
 *
 * Lines go through tools-service (`POST /agentic/transcripts/:id/append`,
 * body `{lines, root}`), which hands them to the workspace bridge serving
 * `root`, or appends them under its own tmp when it serves the root itself;
 * the answer is the file's path, which every later payload of the
 * conversation carries as `transcript_path` (null until it is known).
 *
 * What is written, and when (TurnHooks):
 *   - turn start: the prompt, as a `user` line with string content;
 *   - each tool batch: an `assistant` line (the pass's text, then a
 *     `tool_use` block per call), then a `user` line of `tool_result`
 *     blocks (text capped at 32 KB, `is_error` on a failed call);
 *   - the final answer, as an `assistant` text line, BEFORE the Stop hooks
 *     run — what Claude Code's Stop hooks find as the last message;
 *   - input the turn took in mid-way (a task notification, the user's
 *     update), as `user` string lines where it entered, before the next
 *     assistant line.
 * A sub-agent writes its own file (its conversation id), every line a
 * sidechain with its `agentId`, as Claude Code writes a subagent's.
 *
 * Appends of one conversation are chained, so lines land in the order they
 * were made. A failed append is logged and dropped: a transcript never
 * breaks a turn.
 */

export interface TranscriptTarget {
  /** The file's key: the conversation (a sub-agent's own id for a sub-agent run). */
  conversationId: string;
  /**
   * The registered root the append is routed by — the machine the workspace
   * is on. A worktree's turn routes by its checkout (worktrees live outside
   * every registered root).
   */
  root: string;
  /** Each line's `cwd`: the directory the turn works in (a worktree's path). Defaults to `root`. */
  cwd?: string | null;
  project?: string | null;
  username?: string | null;
  /** A sub-agent's id: its lines are a sidechain. */
  agentId?: string | null;
  /** The model the turn runs on, on assistant lines. */
  model?: string | null;
}

export interface TranscriptLine {
  type: "user" | "assistant";
  sessionId: string;
  timestamp: string;
  cwd: string;
  uuid: string;
  isSidechain: boolean;
  agentId?: string;
  message: Record<string, unknown>;
}

export interface TranscriptTransport {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

// ── Conversation state shared across turns ────────────────────

const rememberedPaths = new Map<string, string>();
const appendChains = new Map<string, Promise<unknown>>();
/** Conversations whose append failure was already logged at warn level. */
const warnedConversations = new Set<string>();

/** The transcript path of a conversation, once an append has returned it. */
export function transcriptPathFor(conversationId: string | null | undefined): string | null {
  return conversationId ? (rememberedPaths.get(conversationId) ?? null) : null;
}

function rememberPath(conversationId: string, transcriptPath: string): void {
  rememberedPaths.delete(conversationId);
  if (rememberedPaths.size >= CLAUDE_TRANSCRIPT.MAX_REMEMBERED_PATHS) {
    const oldest = rememberedPaths.keys().next().value;
    if (oldest !== undefined) rememberedPaths.delete(oldest);
  }
  rememberedPaths.set(conversationId, transcriptPath);
}

/** Test seam: forget every path and pending chain. */
export function _resetTranscriptsForTests(): void {
  rememberedPaths.clear();
  appendChains.clear();
  warnedConversations.clear();
}

// ── Lines ─────────────────────────────────────────────────────

function line(
  target: TranscriptTarget,
  type: TranscriptLine["type"],
  message: Record<string, unknown>,
): TranscriptLine {
  return {
    type,
    sessionId: target.conversationId,
    timestamp: new Date().toISOString(),
    cwd: target.cwd || target.root,
    uuid: crypto.randomUUID(),
    isSidechain: Boolean(target.agentId),
    ...(target.agentId ? { agentId: target.agentId } : {}),
    message,
  };
}

/** A user's words (the prompt, or input taken in mid-turn), as string content. */
export function userTextLine(target: TranscriptTarget, text: string): TranscriptLine {
  return line(target, "user", { role: "user", content: text });
}

/** The assistant's text and its tool calls, in Claude Code's content blocks. */
export function assistantLine(
  target: TranscriptTarget,
  text: string,
  toolCalls: readonly ToolCall[] = [],
): TranscriptLine {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const toolCall of toolCalls) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.args ?? {},
    });
  }
  return line(target, "assistant", {
    role: "assistant",
    ...(target.model ? { model: target.model } : {}),
    content,
  });
}

/** A tool result as the model read it — text as is, anything else as JSON — capped. */
export function toolResultText(
  result: unknown,
  maxChars: number = CLAUDE_TRANSCRIPT.MAX_TOOL_RESULT_CHARS,
): string {
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    try {
      text = JSON.stringify(result ?? null) ?? "null";
    } catch {
      text = String(result);
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars]` : text;
}

function failed(result: unknown): boolean {
  if (!result || typeof result !== "object") return result === undefined || result === null;
  const record = result as Record<string, unknown>;
  return record.success === false || typeof record.error === "string";
}

/** One `tool_result` block per call, in the calls' order. */
export function toolResultLine(
  target: TranscriptTarget,
  toolCalls: readonly ToolCall[],
  results: readonly ToolResult[],
): TranscriptLine {
  const byId = new Map(results.map((result) => [result.id, result]));
  return line(target, "user", {
    role: "user",
    content: toolCalls.map((toolCall) => {
      const outcome = byId.get(toolCall.id)?.result;
      return {
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: toolResultText(outcome),
        ...(failed(outcome) ? { is_error: true } : {}),
      };
    }),
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

/** The id of mid-turn input a message carries (TurnInputDrain marks every one). */
function turnInputIdOf(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "user") return null;
  const marker = record[TURN_INPUT.MESSAGE_KEY] as { id?: unknown } | undefined;
  return marker && typeof marker.id === "string" ? marker.id : null;
}

// ── Transport ─────────────────────────────────────────────────

/** POST the lines; resolves to the transcript's path, or the last known one on failure. */
async function postLines(
  target: TranscriptTarget,
  lines: TranscriptLine[],
  { baseUrl = TOOLS_SERVICE_URL, fetchImplementation = fetch }: TranscriptTransport = {},
): Promise<string | null> {
  const conversationId = target.conversationId;
  if (!baseUrl) return transcriptPathFor(conversationId);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...traceHeaders(),
  };
  if (target.project) headers[IDENTITY_HEADERS.project] = target.project;
  if (target.username) headers[IDENTITY_HEADERS.username] = target.username;
  try {
    const response = await fetchImplementation(
      `${baseUrl}${CLAUDE_TRANSCRIPT.APPEND_PATH_PREFIX}/${encodeURIComponent(conversationId)}/append`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ lines, root: target.root }),
        signal: AbortSignal.timeout(CLAUDE_TRANSCRIPT.APPEND_TIMEOUT_MILLISECONDS),
      },
    );
    const body = (await response.json().catch(() => null)) as { path?: unknown; error?: unknown } | null;
    if (!response.ok || typeof body?.path !== "string" || !body.path) {
      throw new Error(
        `tools-service answered ${response.status}${typeof body?.error === "string" ? `: ${body.error}` : ""}`,
      );
    }
    rememberPath(conversationId, body.path);
    warnedConversations.delete(conversationId);
    return body.path;
  } catch (appendError: unknown) {
    const text = `[ClaudeTranscript] Could not append ${lines.length} line(s) to the transcript of ${conversationId}: ${errorMessage(appendError)}`;
    if (warnedConversations.has(conversationId)) {
      logger.debug(text);
    } else {
      warnedConversations.add(conversationId);
      logger.warn(text);
    }
    return transcriptPathFor(conversationId);
  }
}

// ── One turn's writer ─────────────────────────────────────────

export class TurnTranscript {
  readonly target: TranscriptTarget;
  private readonly transport: TranscriptTransport;
  /** Mid-turn input already written (or already in the history when the turn opened). */
  private readonly writtenInputs = new Set<string>();
  /**
   * The text of the batch just written and the iteration it came from,
   * while nothing came after it. A reply that came with fire-and-forget
   * calls ends the turn in that same iteration with that same text: it is
   * the batch's line, not a second one.
   */
  private reply: { text: string; iteration: number | null } | null = null;
  private last: Promise<string | null> = Promise.resolve(null);

  constructor(target: TranscriptTarget, transport: TranscriptTransport = {}) {
    this.target = target;
    this.transport = transport;
  }

  /** The file's path, once an append has returned it. */
  get path(): string | null {
    return transcriptPathFor(this.target.conversationId);
  }

  /**
   * The turn's prompt — `null` for a turn re-driven after a restart, whose
   * prompt was written before it (the request then only learns the path).
   * Input already in `messages` belongs to earlier turns and is not written.
   */
  appendPrompt(
    prompt: string | null,
    messages: readonly unknown[] = [],
  ): Promise<string | null> {
    for (const message of messages) {
      const id = turnInputIdOf(message);
      if (id) this.writtenInputs.add(id);
    }
    return this.append(prompt && prompt.trim() ? [userTextLine(this.target, prompt)] : []);
  }

  /** A resolved tool batch: input taken in since the last line, the calls, their results. */
  appendBatch({
    text,
    toolCalls,
    results,
    messages,
    iteration = null,
  }: {
    text: string;
    toolCalls: readonly ToolCall[];
    results: readonly ToolResult[];
    messages?: readonly unknown[];
    /** The loop iteration of the pass that made the calls. */
    iteration?: number | null;
  }): Promise<string | null> {
    if (toolCalls.length === 0) return this.last;
    const lines = [
      ...this.inputLines(messages),
      assistantLine(this.target, text, toolCalls),
      toolResultLine(this.target, toolCalls, results),
    ];
    this.reply = text.trim() ? { text, iteration } : null;
    return this.append(lines);
  }

  /** The answer the turn is about to end with (input taken in first). */
  appendFinal(
    text: string,
    messages?: readonly unknown[],
    iteration: number | null = null,
  ): Promise<string | null> {
    const lines = this.inputLines(messages);
    const alreadyWritten =
      lines.length === 0 &&
      this.reply !== null &&
      this.reply.text === text &&
      this.reply.iteration === iteration;
    this.reply = null;
    if (text.trim() && !alreadyWritten) lines.push(assistantLine(this.target, text));
    return lines.length > 0 ? this.append(lines) : this.last;
  }

  /** Wait, at most `timeoutMilliseconds`, for every append made so far. Never rejects. */
  async flush(
    timeoutMilliseconds: number = CLAUDE_TRANSCRIPT.FLUSH_TIMEOUT_MILLISECONDS,
  ): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.last,
        new Promise<string | null>((resolve) => {
          timer = setTimeout(() => resolve(this.path), timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private inputLines(messages: readonly unknown[] | undefined): TranscriptLine[] {
    if (!Array.isArray(messages)) return [];
    const lines: TranscriptLine[] = [];
    for (const message of messages) {
      const id = turnInputIdOf(message);
      if (!id || this.writtenInputs.has(id)) continue;
      this.writtenInputs.add(id);
      const text = messageText((message as { content?: unknown }).content);
      if (text.trim()) lines.push(userTextLine(this.target, text));
    }
    if (lines.length > 0) this.reply = null;
    return lines;
  }

  /** Chain one append behind the conversation's previous one. */
  private append(lines: TranscriptLine[]): Promise<string | null> {
    // Nothing to write and the path known: no request.
    if (lines.length === 0 && this.path) return this.last;
    const key = this.target.conversationId;
    const previous = appendChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => postLines(this.target, lines, this.transport));
    appendChains.set(key, next);
    void next.finally(() => {
      if (appendChains.get(key) === next) appendChains.delete(key);
    });
    this.last = next;
    return next;
  }
}

/**
 * The writer for a turn, or null when it cannot keep one: no tools-service,
 * no workspace, or a conversation id the transcript route refuses.
 */
export function openTurnTranscript(
  turn: {
    conversationId?: string | null;
    agentConversationId?: string | null;
    parentAgentConversationId?: string | null;
    project?: string | null;
    username?: string | null;
    resolvedModel?: string | null;
  },
  workspace: { root: string | null; cwd?: string | null },
  transport: TranscriptTransport = {},
): TurnTranscript | null {
  const baseUrl = transport.baseUrl ?? TOOLS_SERVICE_URL;
  const conversationId = turn.conversationId;
  if (!baseUrl || !workspace.root || !conversationId) return null;
  if (!CLAUDE_TRANSCRIPT.CONVERSATION_ID_PATTERN.test(conversationId)) {
    logger.debug(`[ClaudeTranscript] Conversation id "${conversationId}" is not a transcript name — no transcript.`);
    return null;
  }
  return new TurnTranscript(
    {
      conversationId,
      root: workspace.root,
      cwd: workspace.cwd ?? workspace.root,
      project: turn.project ?? null,
      username: turn.username ?? null,
      agentId: turn.parentAgentConversationId ? (turn.agentConversationId ?? null) : null,
      model: turn.resolvedModel ?? null,
    },
    { ...transport, baseUrl },
  );
}
