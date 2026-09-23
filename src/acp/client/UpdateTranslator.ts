import type {
  ContentBlock,
  PlanEntry,
  PromptResponse,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";
import type { ConversationMessage, ToolCall } from "#src/services/harnesses/types";

/**
 * An external ACP agent's session, translated into Prism: every
 * `session/update` it sends becomes the events a Prism sub-agent loop emits
 * (which the orchestrator's telemetry forwards to the parent as
 * `sub_agent_*` events), and the turn is kept as a Prism transcript — the
 * shape a ReAct loop persists, so the sub-agent's conversation reads the
 * same and its last assistant message is its report.
 *
 * The reverse of src/acp/TurnTranslator.ts (Prism → ACP, the server side).
 * Pure bookkeeping around an `emit` callback: no I/O.
 *
 * | ACP update                         | Prism event                                  |
 * |------------------------------------|----------------------------------------------|
 * | `agent_message_chunk` (text)       | `chunk`                                      |
 * | `agent_message_chunk` (image)      | `image`                                      |
 * | `agent_message_chunk` (link)       | `chunk` with a Markdown link                 |
 * | `agent_thought_chunk`              | `thinking`                                   |
 * | `tool_call`                        | `tool_execution` `calling`                   |
 * | `tool_call_update` (content)       | `tool_output` (the new output)               |
 * | `tool_call_update` completed/failed| `tool_execution` `done` / `error`            |
 * | `plan`                             | `todo_update`                                |
 * | `usage_update` with a USD `cost`   | `usage_update` (`estimatedCost`)             |
 * | `notice`, `current_mode_update`    | `status` (a notice naming the agent)         |
 * | the prompt's stop reason           | `status` notices; open calls are closed      |
 *
 * `user_message_chunk` (an echo), `available_commands_update`,
 * `config_option_update`, `session_info_update` and anything newer are
 * not shown.
 */

export type PrismEvent = { type: string; [key: string]: unknown };
export type EmitPrismEvent = (event: PrismEvent) => void;

/** How much of a tool's output a result keeps. */
export const RESULT_CHARACTERS = 8_000;
/** How much of a tool's live output is streamed per update. */
export const OUTPUT_DELTA_CHARACTERS = 16_000;
/** A tool name shown for the call is cut to this. */
const TOOL_NAME_CHARACTERS = 120;

export interface ExternalAgentCost {
  amount: number;
  currency: string;
}

type ExternalToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** One tool call of the agent, as it has described it so far. */
export interface ExternalToolState {
  id: string;
  /** What Prism shows as the call's tool name: its programmatic name, else its title, else its kind. */
  name: string;
  title: string | null;
  kind: ToolKind | null;
  input: unknown;
  locations: string[];
  status: ExternalToolStatus;
  /** Its latest text output. */
  output: string;
  /** Its latest diffs, by path. */
  diffs: Array<{ path: string; oldText: string | null; newText: string }>;
  rawOutput: unknown;
  startedAt: number;
  /** The transcript entry (also in its assistant message's `toolCalls`). */
  toolCall: ToolCall;
  finished: boolean;
}

interface Segment {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function jsonOf(value: unknown, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  return truncate(json, limit);
}

/** The text a content block reads as. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return block.title || block.name || block.uri;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

/** A tool call's content as text: its messages and its terminals (diffs are kept apart). */
function contentText(content: readonly ToolCallContent[] | null | undefined): string {
  if (!content) return "";
  return content
    .map((entry) => {
      if (entry.type === "content") return blockText(entry.content);
      if (entry.type === "terminal") return `[terminal ${entry.terminalId}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function diffsOf(content: readonly ToolCallContent[] | null | undefined): ExternalToolState["diffs"] {
  return (content ?? []).flatMap((entry) =>
    entry.type === "diff" ? [{ path: entry.path, oldText: entry.oldText ?? null, newText: entry.newText }] : [],
  );
}

function locationPaths(locations: readonly ToolCallLocation[] | null | undefined): string[] {
  return (locations ?? []).map((location) => location.path).filter((path) => typeof path === "string" && path);
}

function isStatus(value: unknown): value is ExternalToolStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "failed";
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const PLAN_PRIORITIES = new Set(["high", "medium", "low"]);

export class UpdateTranslator {
  /** The latest cumulative session cost the agent reported, in its currency. */
  cost: ExternalAgentCost | null = null;
  /** The latest token usage the agent reported on a prompt's answer. */
  usage: Usage | null = null;
  /** Prompts sent so far in this run. */
  prompts = 0;
  /** Called with the dollars spent so far, each time the agent reports a cost in USD. */
  onCost: ((dollars: number) => void) | null = null;

  private readonly emit: EmitPrismEvent;
  private readonly agentLabel: string;
  private readonly now: () => number;
  private readonly tools = new Map<string, ExternalToolState>();
  private readonly transcript: ConversationMessage[] = [];
  private segment: Segment = { text: "", thinking: "", toolCalls: [] };
  private promptStartedAt = 0;
  private sawFirstOutput = false;
  private warnedCurrency: string | null = null;

  constructor({
    emit,
    agentLabel,
    now = Date.now,
  }: {
    emit: EmitPrismEvent;
    agentLabel: string;
    now?: () => number;
  }) {
    this.emit = emit;
    this.agentLabel = agentLabel;
    this.now = now;
  }

  /** The run's messages so far: each prompt, then what the agent answered — ReAct-shaped. */
  get messages(): ConversationMessage[] {
    return [...this.transcript, ...this.pendingSegmentMessage()];
  }

  /** Tool calls the agent made in this run, in order. */
  get toolCalls(): ToolCall[] {
    return [...this.tools.values()].map((state) => state.toolCall);
  }

  /** The cost in dollars, when the agent reported one in USD. */
  get costDollars(): number | null {
    if (!this.cost) return null;
    return this.cost.currency.toUpperCase() === "USD" ? this.cost.amount : null;
  }

  /** A tool call the agent announced (or that a permission request named). */
  tool(toolCallId: string): ExternalToolState | undefined {
    return this.tools.get(toolCallId);
  }

  /**
   * A prompt goes to the agent. With `record`, `text` joins the transcript
   * as a user message (a follow-up; the task itself is the caller's).
   */
  beginPrompt(text: string, { record = true }: { record?: boolean } = {}): void {
    this.flushSegment();
    if (record) this.transcript.push({ role: "user", content: text, timestamp: new Date(this.now()).toISOString() });
    this.prompts += 1;
    this.promptStartedAt = this.now();
    this.sawFirstOutput = false;
    this.emit({ type: "status", message: "iteration_progress", iteration: this.prompts, maxIterations: null });
  }

  /** The agent answered the prompt (or it ended without one: `response` null). */
  endPrompt(response: PromptResponse | null): void {
    if (response?.usage) this.usage = response.usage;
    const stopReason = response?.stopReason ?? null;
    if (stopReason === "cancelled") {
      this.closeOpenTools("failed", "Cancelled.");
    } else {
      this.closeOpenTools("completed", "The agent ended its turn without reporting this call's result.");
    }
    if (stopReason === "max_tokens") {
      this.notice(`${this.agentLabel} stopped at its output-token limit`);
    } else if (stopReason === "max_turn_requests") {
      this.notice(`${this.agentLabel} stopped at its own limit of model requests for one turn`);
    } else if (stopReason === "refusal") {
      this.notice(`${this.agentLabel} declined the request`);
    }
    this.flushSegment();
  }

  /** Close every call still open (a cancel, a crash): `failed` with `note` as the reason. */
  closeOpenTools(status: "completed" | "failed", note: string): void {
    for (const state of this.tools.values()) {
      if (state.finished) continue;
      if (!state.output && state.diffs.length === 0) state.output = note;
      state.status = status;
      this.finish(state);
    }
  }

  apply(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.message(update.content);
        return;
      case "agent_thought_chunk":
        this.thought(update.content);
        return;
      case "tool_call":
        this.toolUpdate(update, true);
        return;
      case "tool_call_update":
        this.toolUpdate(update, false);
        return;
      case "plan":
        this.plan(update.entries);
        return;
      case "usage_update":
        this.recordCost(update.cost ?? null);
        return;
      case "current_mode_update":
        this.notice(`${this.agentLabel} is now in its "${update.currentModeId}" mode`);
        return;
      case "notice": {
        const description = update.description ? ` — ${update.description}` : "";
        this.notice(`${this.agentLabel}: ${update.title}${description}`);
        return;
      }
      default:
        // user_message_chunk (an echo of the prompt), available_commands_update,
        // config_option_update, session_info_update, plan_update/plan_removed,
        // compaction_*, and anything a newer agent sends: nothing to show.
        return;
    }
  }

  /**
   * A call a permission request names: the state the stream described,
   * merged with what the request says (an agent may ask before it announces).
   */
  describe(toolCall: ToolCallUpdate): ExternalToolState {
    return this.toolUpdate({ ...toolCall }, false, { finish: false });
  }

  // ── Output ────────────────────────────────────────────────────

  private firstOutput(): void {
    if (this.sawFirstOutput) return;
    this.sawFirstOutput = true;
    const seconds = Math.max(0, (this.now() - this.promptStartedAt) / 1000);
    this.emit({ type: "status", message: "generation_started", timeToFirstToken: Math.round(seconds * 1000) / 1000 });
  }

  /** Text after the calls of this step starts the next step (an assistant message per step). */
  private startStepIfNeeded(): void {
    if (this.segment.toolCalls.length > 0) this.flushSegment();
  }

  private message(block: ContentBlock): void {
    if (block.type === "image") {
      this.firstOutput();
      this.emit({ type: "image", data: block.data, mimeType: block.mimeType });
      return;
    }
    const text =
      block.type === "resource_link"
        ? `[${(block.title || block.name || block.uri).replace(/[[\]]/g, "")}](${block.uri})`
        : blockText(block);
    if (!text) return;
    this.firstOutput();
    this.startStepIfNeeded();
    this.segment.text += text;
    this.emit({ type: "chunk", content: text });
  }

  private thought(block: ContentBlock): void {
    const text = blockText(block);
    if (!text) return;
    this.firstOutput();
    this.startStepIfNeeded();
    this.segment.thinking += text;
    this.emit({ type: "thinking", content: text });
  }

  private notice(message: string): void {
    this.emit({ type: "status", message });
  }

  // ── Tool calls ────────────────────────────────────────────────

  private argsOf(state: ExternalToolState): Record<string, unknown> {
    return {
      ...(state.title ? { title: state.title } : {}),
      ...(state.kind ? { kind: state.kind } : {}),
      ...(state.input !== undefined && state.input !== null ? { input: state.input } : {}),
      ...(state.locations.length > 0 ? { locations: state.locations } : {}),
    };
  }

  private resultOf(state: ExternalToolState): Record<string, unknown> {
    const output = truncate(state.output, RESULT_CHARACTERS);
    const raw =
      state.rawOutput !== undefined && state.rawOutput !== null
        ? typeof state.rawOutput === "string"
          ? truncate(state.rawOutput, RESULT_CHARACTERS)
          : jsonOf(state.rawOutput, RESULT_CHARACTERS)
        : "";
    if (state.status === "failed") {
      return { error: output || raw || "The call failed." };
    }
    return {
      ...(output ? { output } : raw ? { output: raw } : {}),
      ...(state.diffs.length > 0
        ? { edited: state.diffs.map((diff) => ({ path: diff.path, ...(diff.oldText === null ? { created: true } : {}) })) }
        : {}),
      ...(!output && !raw && state.diffs.length === 0 ? { status: "completed" } : {}),
    };
  }

  private toolUpdate(
    update: ToolCallUpdate & { title?: string | null },
    isAnnouncement: boolean,
    { finish = true }: { finish?: boolean } = {},
  ): ExternalToolState {
    const id = update.toolCallId;
    let state = this.tools.get(id);
    const isNew = !state;
    if (!state) {
      const name = clip(
        (update.name?.trim() || update.title?.trim() || update.kind || "tool").replace(/\s+/g, " "),
        TOOL_NAME_CHARACTERS,
      );
      const toolCall: ToolCall = { id, name, args: {} };
      state = {
        id,
        name,
        title: null,
        kind: null,
        input: undefined,
        locations: [],
        status: "pending",
        output: "",
        diffs: [],
        rawOutput: undefined,
        startedAt: this.now(),
        toolCall,
        finished: false,
      };
      this.tools.set(id, state);
    }
    if (update.title) state.title = update.title;
    if (update.kind) state.kind = update.kind;
    if (update.rawInput !== undefined) state.input = update.rawInput;
    if (update.locations) state.locations = locationPaths(update.locations);
    if (update.rawOutput !== undefined) state.rawOutput = update.rawOutput;
    const previousOutput = state.output;
    if (update.content) {
      state.output = contentText(update.content);
      const diffs = diffsOf(update.content);
      if (diffs.length > 0) state.diffs = diffs;
    }
    if (isStatus(update.status) && !state.finished) state.status = update.status;
    state.toolCall.args = this.argsOf(state);

    if (isNew) {
      this.firstOutput();
      this.startStepIfNeeded();
      this.segment.toolCalls.push(state.toolCall);
      this.emit({
        type: "tool_execution",
        status: "calling",
        tool: { id, name: state.name, args: state.toolCall.args },
        ...(state.title && state.title !== state.name ? { toolLabel: state.title } : {}),
        timestamp: state.startedAt,
      });
    } else if (!isAnnouncement && !state.finished && state.output !== previousOutput && state.output) {
      // Live output: what was added, or the whole output when it was replaced.
      const delta = state.output.startsWith(previousOutput)
        ? state.output.slice(previousOutput.length)
        : `${previousOutput ? "\n" : ""}${state.output}`;
      if (delta) {
        this.emit({
          type: "tool_output",
          toolCallId: id,
          name: state.name,
          event: "stdout",
          data: delta.slice(-OUTPUT_DELTA_CHARACTERS),
        });
      }
    }
    if (finish && !state.finished && (state.status === "completed" || state.status === "failed")) {
      this.finish(state);
    }
    return state;
  }

  private finish(state: ExternalToolState): void {
    state.finished = true;
    const result = this.resultOf(state);
    const durationMilliseconds = Math.max(0, this.now() - state.startedAt);
    Object.assign(state.toolCall, {
      args: this.argsOf(state),
      result,
      status: state.status === "failed" ? "error" : "done",
      durationMilliseconds,
    });
    this.emit({
      type: "tool_execution",
      status: state.status === "failed" ? "error" : "done",
      tool: { id: state.id, name: state.name, args: state.toolCall.args, result, durationMilliseconds },
    });
  }

  // ── Plan and cost ─────────────────────────────────────────────

  private plan(entries: readonly PlanEntry[]): void {
    const items = entries.map((entry, index) => ({
      id: index + 1,
      content: entry.content,
      status: (PLAN_STATUSES.has(entry.status) ? entry.status : "pending") as "pending" | "in_progress" | "completed",
      priority: (PLAN_PRIORITIES.has(entry.priority) ? entry.priority : "medium") as "high" | "medium" | "low",
    }));
    const count = (status: string) => items.filter((item) => item.status === status).length;
    this.emit({
      type: "todo_update",
      items,
      stats: {
        total: items.length,
        pending: count("pending"),
        in_progress: count("in_progress"),
        completed: count("completed"),
      },
    });
  }

  private recordCost(cost: { amount: number; currency: string } | null): void {
    if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0) return;
    this.cost = { amount: cost.amount, currency: cost.currency || "USD" };
    const dollars = this.costDollars;
    if (dollars === null) {
      if (this.warnedCurrency !== cost.currency) {
        this.warnedCurrency = cost.currency;
        this.notice(`${this.agentLabel} reports its cost in ${cost.currency}; Prism counts dollars, so its cost stays unknown`);
      }
      return;
    }
    this.emit({ type: "usage_update", usage: {}, estimatedCost: dollars });
    this.onCost?.(dollars);
  }

  // ── Transcript ────────────────────────────────────────────────

  private segmentMessage(segment: Segment): ConversationMessage | null {
    if (!segment.text && !segment.thinking && segment.toolCalls.length === 0) return null;
    return {
      role: "assistant",
      content: segment.text,
      ...(segment.thinking ? { thinking: segment.thinking } : {}),
      ...(segment.toolCalls.length > 0 ? { toolCalls: segment.toolCalls } : {}),
      timestamp: new Date(this.now()).toISOString(),
    };
  }

  private pendingSegmentMessage(): ConversationMessage[] {
    const message = this.segmentMessage(this.segment);
    return message ? [message] : [];
  }

  private flushSegment(): void {
    const message = this.segmentMessage(this.segment);
    if (message) this.transcript.push(message);
    this.segment = { text: "", thinking: "", toolCalls: [] };
  }
}
