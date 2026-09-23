import { isAbsolute, resolve } from "node:path";
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import {
  PROTOCOL_VERSION,
  type ApprovalRequiredEvent,
  type ErrorEvent,
  type PlanProposalEvent,
  type TurnEvent,
  type TurnEventOf,
  type UserQuestionEvent,
} from "#src/protocol/events";

/**
 * One Prism turn, translated into ACP: every `TurnEvent` of the turn's
 * stream becomes the `session/update`s an ACP client renders, and the
 * events that need an answer from a person — a tool approval, a plan, a
 * question — become interactions the agent asks the client about.
 *
 * Pure bookkeeping: no I/O, so the whole mapping is unit-testable from a
 * recorded transcript. What it maps:
 *
 * | Prism event                                     | ACP                                      |
 * |-------------------------------------------------|------------------------------------------|
 * | `chunk` / `thinking`                            | `agent_message_chunk` / `agent_thought_chunk` |
 * | `image` (with data), `citations`, `webSearchResult` | `agent_message_chunk` (image / resource_link) |
 * | `tool_execution`, `toolCall`, `sub_agent_tool_execution` | `tool_call`, then `tool_call_update`s |
 * | `tool_output`, `sub_agent_tool_output`          | the tool call's `content` (its output tail) |
 * | `executableCode` + `codeExecutionResult`        | an `execute` tool call                   |
 * | `sub_agent_status` spawned / complete / failed  | a tool call per sub-agent                |
 * | `approval_required`, `plan_proposal`, `user_question` | an interaction (see PrismAcpAgent)  |
 * | `approval_decided`                              | the tool call's status; closes an open request |
 * | `todo_update` / `plan_proposal` steps           | `plan`                                   |
 * | `permission_mode`                               | `current_mode_update`                    |
 * | `context_budget` + `usage_update`               | `usage_update` (context used/size, cost) |
 * | `refusal`, `status` iteration_limit_reached, `done`, `error` | the turn's outcome (stop reason) |
 */

export type TurnInteraction =
  | { kind: "approval"; event: ApprovalRequiredEvent; toolCall: ToolCallUpdate }
  | { kind: "plan"; event: PlanProposalEvent; toolCall: ToolCallUpdate }
  | { kind: "question"; event: UserQuestionEvent }
  /** A pending call was decided (here or elsewhere): withdraw any open request for it. */
  | { kind: "decided"; toolCallId: string };

export interface TranslatedEvent {
  updates: SessionUpdate[];
  interaction?: TurnInteraction;
}

export interface TurnOutcome {
  /** `done` arrived: the turn finished and is persisted. */
  done: boolean;
  error: ErrorEvent | null;
  refusal: boolean;
  iterationLimit: boolean;
  /** The Prism conversation the turn ran in, as the stream named it. */
  conversationId: string | null;
  /** The turn's cumulative cost so far (USD), when reported. */
  turnCost: number | null;
  /** The newest `seq` seen — where a `/ws/chat` subscription picks up without repeats. */
  lastSeq: number | null;
}

interface ToolState {
  id: string;
  name: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  output: string;
}

/** How much of a tool's live output a tool call shows (its tail). */
export const TOOL_OUTPUT_TAIL_CHARACTERS = 16_000;
/** How much of a tool's result a tool call shows. */
export const TOOL_RESULT_CHARACTERS = 8_000;

const PATH_ARGUMENTS = ["path", "file_path", "filePath", "filename", "source", "destination", "target_path", "notebook_path"];

/** The ACP tool kind of a Prism tool, from its name. */
export function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (/(enter|exit)_plan_mode|switch_mode/.test(lower)) return "switch_mode";
  if (/fetch|read_url|web_page|browse|http_request|scrape/.test(lower)) return "fetch";
  if (/search|grep|find_|glob/.test(lower)) return "search";
  if (/^(delete|remove)_/.test(lower)) return "delete";
  if (/^(move|rename)_/.test(lower)) return "move";
  if (/^(write|edit|create_file|apply_patch|replace|patch|str_replace|multi_edit|insert)/.test(lower)) return "edit";
  if (/^(execute|run|shell|bash)/.test(lower)) return "execute";
  if (/^(read|list|get|view|describe)_/.test(lower)) return "read";
  if (/think|todo|brief/.test(lower)) return "think";
  return "other";
}

/** The file locations a call touches, absolute (ACP requires it) — relative paths resolve against the workspace. */
export function toolLocations(args: Record<string, unknown>, workspaceRoot: string | null): ToolCallLocation[] {
  const locations: ToolCallLocation[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 4096) return;
    if (isAbsolute(value)) locations.push({ path: value });
    else if (workspaceRoot) locations.push({ path: resolve(workspaceRoot, value) });
  };
  for (const key of PATH_ARGUMENTS) add(args[key]);
  if (Array.isArray(args.paths)) args.paths.slice(0, 10).forEach(add);
  return locations.slice(0, 10);
}

function textContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

function fenced(text: string, language = ""): string {
  const fence = text.includes("```") ? "~~~~" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/** A tool result as tool-call content: text as-is, anything else as JSON. */
export function resultContent(result: unknown): ToolCallContent[] {
  if (result === undefined || result === null) return [];
  if (typeof result === "string") return [textContent(truncate(result, TOOL_RESULT_CHARACTERS))];
  let json: string;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    json = String(result);
  }
  return [textContent(fenced(truncate(json, TOOL_RESULT_CHARACTERS), "json"))];
}

function isFailedResult(result: unknown): boolean {
  return !!result && typeof result === "object" && "error" in result && !!(result as { error?: unknown }).error;
}

/**
 * An approval's diff preview. A whole new file becomes an ACP diff (it has no
 * old text); anything else stays a unified diff, because a hunk is not a file.
 */
function previewContent(preview: ApprovalRequiredEvent["preview"], workspaceRoot: string | null): ToolCallContent[] {
  if (!preview) return [];
  const path = isAbsolute(preview.path) ? preview.path : workspaceRoot ? resolve(workspaceRoot, preview.path) : null;
  if (preview.isNewFile && !preview.isTruncated && path) {
    const added = preview.diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return [{ type: "diff", path, oldText: null, newText: added.join("\n") }];
  }
  return [textContent(fenced(preview.diff, "diff"))];
}

export class TurnTranslator {
  readonly outcome: TurnOutcome = {
    done: false,
    error: null,
    refusal: false,
    iterationLimit: false,
    conversationId: null,
    turnCost: null,
    lastSeq: null,
  };

  private readonly workspaceRoot: string | null;
  private readonly tools = new Map<string, ToolState>();
  private readonly linkedSources = new Set<string>();
  private readonly log: (message: string) => void;
  private anonymousTools = 0;
  private codeRuns = 0;
  private contextWindow: number | null = null;
  private contextUsed: number | null = null;
  private readonly costBeforeTurn: number;

  constructor({
    workspaceRoot,
    costBeforeTurn = 0,
    log = () => {},
  }: { workspaceRoot: string | null; costBeforeTurn?: number; log?: (message: string) => void }) {
    this.workspaceRoot = workspaceRoot;
    this.costBeforeTurn = costBeforeTurn;
    this.log = log;
  }

  /** The session's cumulative cost after this turn, when the turn reported one. */
  get sessionCost(): number | null {
    return this.outcome.turnCost === null ? null : this.costBeforeTurn + this.outcome.turnCost;
  }

  translate(event: TurnEvent): TranslatedEvent {
    if (typeof event.seq === "number" && (this.outcome.lastSeq === null || event.seq > this.outcome.lastSeq)) {
      this.outcome.lastSeq = event.seq;
    }
    switch (event.type) {
      case "hello":
        if (event.protocolVersion > PROTOCOL_VERSION) {
          this.log(
            `[protocol] prism-service speaks protocol v${event.protocolVersion}; this ACP server knows v${PROTOCOL_VERSION}`,
          );
        }
        return { updates: [] };
      case "user_message":
        if (event.conversationId) this.outcome.conversationId = event.conversationId;
        return { updates: [] };
      case "chunk":
        return this.text("agent_message_chunk", event.content);
      case "thinking":
        return this.text("agent_thought_chunk", event.content);
      case "image":
        if (!event.data) return { updates: [] };
        return {
          updates: [
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: event.data, mimeType: event.mimeType ?? "image/png" },
            },
          ],
        };
      case "citations":
        return this.links(event.sources);
      case "webSearchResult":
        return this.links(event.results);
      case "refusal":
        this.outcome.refusal = true;
        return event.explanation ? this.text("agent_message_chunk", `\n\n(Refused: ${event.explanation})`) : { updates: [] };
      case "executableCode":
        return this.codeRun(event);
      case "codeExecutionResult":
        return this.codeResult(event);
      case "tool_execution":
        return this.toolEvent(event.tool.id, event.tool.name, event.status, event.tool.args, event.tool.result, event.toolLabel);
      case "toolCall":
        return this.providerToolCall(event);
      case "sub_agent_tool_execution":
        return this.toolEvent(
          event.tool.id === null ? null : `${event.subAgentId}/${event.tool.id}`,
          event.tool.name,
          event.status,
          event.tool.args,
          event.tool.result,
          undefined,
          event.subAgentDescription,
        );
      case "tool_output":
        return this.toolOutput(event.toolCallId, event.name, event.event, event.data);
      case "sub_agent_tool_output":
        return this.toolOutput(
          event.toolCallId === null ? null : `${event.subAgentId}/${event.toolCallId}`,
          event.name,
          event.event,
          event.data,
        );
      case "sub_agent_status":
        return this.subAgent(event);
      case "approval_required":
        return this.approval(event);
      case "approval_decided":
        return this.decided(event);
      case "plan_proposal":
        return this.planProposal(event);
      case "user_question":
        return { updates: [], interaction: { kind: "question", event } };
      case "todo_update":
        return {
          updates: [
            {
              sessionUpdate: "plan",
              entries: event.items.map(
                (item): PlanEntry => ({ content: item.content, priority: item.priority, status: item.status }),
              ),
            },
          ],
        };
      case "permission_mode":
        return { updates: [{ sessionUpdate: "current_mode_update", currentModeId: event.mode }] };
      case "context_budget":
        this.contextWindow = event.contextWindow;
        this.contextUsed = event.totalInputTokens;
        return this.usage();
      case "usage_update":
        // A background operation (`operation` set) bills separately; the turn's
        // own running total is the one without it.
        if (event.operation) return { updates: [] };
        if (typeof event.estimatedCost === "number") this.outcome.turnCost = event.estimatedCost;
        return this.usage();
      case "status":
        if (event.message === "iteration_limit_reached") this.outcome.iterationLimit = true;
        return { updates: [] };
      case "done":
        this.outcome.done = true;
        if (event.conversationId) this.outcome.conversationId = event.conversationId;
        if (event.refusal) this.outcome.refusal = true;
        if (typeof event.estimatedCost === "number") this.outcome.turnCost = event.estimatedCost;
        return this.finishOpenTools("completed");
      case "error":
        this.outcome.error = event;
        return this.finishOpenTools("failed");
      default:
        // audio, turn_input, goal_update, brief_update, task_notification,
        // conversation_state_update, memory_consolidation_complete, subscribed:
        // nothing an ACP client renders.
        return { updates: [] };
    }
  }

  /** The tool call a permission request refers to, announced if the stream never did. */
  private ensureTool(
    key: string | null,
    name: string,
    args: Record<string, unknown>,
    label?: string,
    prefix?: string,
  ): { state: ToolState; announce: SessionUpdate | null } {
    const id = key ?? `${name}#${this.anonymousTools}`;
    const existing = this.tools.get(id);
    if (existing) return { state: existing, announce: null };
    if (key === null) this.anonymousTools += 1;
    const title = `${prefix ? `${prefix}: ` : ""}${label || name}`;
    const state: ToolState = { id, name, title, kind: toolKind(name), status: "pending", output: "" };
    this.tools.set(id, state);
    return {
      state,
      announce: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title,
        name,
        kind: state.kind,
        status: "pending",
        rawInput: args,
        locations: toolLocations(args, this.workspaceRoot),
      },
    };
  }

  private text(sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", text: string): TranslatedEvent {
    if (!text) return { updates: [] };
    return { updates: [{ sessionUpdate, content: { type: "text", text } }] };
  }

  private links(sources: Array<{ url?: string; title?: string }>): TranslatedEvent {
    const blocks: ContentBlock[] = [];
    for (const source of sources) {
      if (!source.url || this.linkedSources.has(source.url)) continue;
      this.linkedSources.add(source.url);
      blocks.push({ type: "resource_link", uri: source.url, name: source.title || source.url });
    }
    return { updates: blocks.map((content) => ({ sessionUpdate: "agent_message_chunk", content })) };
  }

  private codeRun(event: TurnEventOf<"executableCode">): TranslatedEvent {
    this.codeRuns += 1;
    const id = `code-execution-${this.codeRuns}`;
    this.tools.set(id, { id, name: "code_execution", title: "Code execution", kind: "execute", status: "in_progress", output: "" });
    return {
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "Code execution",
          name: "code_execution",
          kind: "execute",
          status: "in_progress",
          rawInput: { code: event.code, language: event.language },
          content: [textContent(fenced(event.code, event.language.toLowerCase()))],
        },
      ],
    };
  }

  private codeResult(event: TurnEventOf<"codeExecutionResult">): TranslatedEvent {
    const id = `code-execution-${this.codeRuns}`;
    const state = this.tools.get(id);
    if (!state) return { updates: [] };
    state.status = /ok|success/i.test(event.outcome) ? "completed" : "failed";
    return {
      updates: [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: state.status,
          rawOutput: { output: event.output, outcome: event.outcome },
          content: [textContent(fenced(truncate(event.output, TOOL_RESULT_CHARACTERS)))],
        },
      ],
    };
  }

  private toolEvent(
    key: string | null,
    name: string,
    status: "streaming" | "calling" | "done" | "error",
    args: Record<string, unknown>,
    result: unknown,
    label?: string,
    prefix?: string,
  ): TranslatedEvent {
    // A null id names no call: follow the newest open call of that name.
    const resolvedKey = key ?? this.newestOpenTool(name);
    const { state, announce } = this.ensureTool(resolvedKey, name, args, label, prefix);
    const updates: SessionUpdate[] = announce ? [announce] : [];
    if (status === "streaming") return { updates };

    const update: ToolCallUpdate = { toolCallId: state.id };
    if (label && `${prefix ? `${prefix}: ` : ""}${label}` !== state.title) {
      state.title = `${prefix ? `${prefix}: ` : ""}${label}`;
      update.title = state.title;
    }
    if (status === "calling") {
      state.status = "in_progress";
      Object.assign(update, {
        status: "in_progress",
        rawInput: args,
        locations: toolLocations(args, this.workspaceRoot),
      });
    } else {
      const failed = status === "error" || isFailedResult(result);
      state.status = failed ? "failed" : "completed";
      const content = resultContent(result);
      Object.assign(update, {
        status: state.status,
        ...(result !== undefined ? { rawOutput: result } : {}),
        ...(content.length > 0
          ? { content }
          : state.output
            ? { content: [textContent(fenced(state.output))] }
            : {}),
      });
    }
    updates.push({ sessionUpdate: "tool_call_update", ...update });
    return { updates };
  }

  private newestOpenTool(name: string): string | null {
    let newest: string | null = null;
    for (const state of this.tools.values()) {
      if (state.name === name && (state.status === "pending" || state.status === "in_progress")) newest = state.id;
    }
    return newest;
  }

  private providerToolCall(event: TurnEventOf<"toolCall">): TranslatedEvent {
    const name = event.name || "tool";
    const finished = event.result !== undefined || /done|complete|success|error|fail/i.test(event.status ?? "");
    const failed = /error|fail/i.test(event.status ?? "") || isFailedResult(event.result);
    return this.toolEvent(event.id, name, finished ? (failed ? "error" : "done") : "calling", event.args, event.result);
  }

  private toolOutput(
    key: string | null,
    name: string,
    kind: "start" | "stdout" | "stderr" | "exit",
    data: string | undefined,
  ): TranslatedEvent {
    if ((kind !== "stdout" && kind !== "stderr") || !data) return { updates: [] };
    const id = key ?? this.newestOpenTool(name);
    const state = id ? this.tools.get(id) : undefined;
    if (!state) return { updates: [] };
    state.output = (state.output + data).slice(-TOOL_OUTPUT_TAIL_CHARACTERS);
    return {
      updates: [
        { sessionUpdate: "tool_call_update", toolCallId: state.id, content: [textContent(fenced(state.output))] },
      ],
    };
  }

  private subAgent(event: TurnEventOf<"sub_agent_status">): TranslatedEvent {
    const id = `sub-agent/${event.subAgentId}`;
    switch (event.message) {
      case "spawned": {
        if (this.tools.has(id)) return { updates: [] };
        const title = `Sub-agent: ${event.description}`;
        this.tools.set(id, { id, name: "sub_agent", title, kind: "other", status: "in_progress", output: "" });
        return {
          updates: [
            {
              sessionUpdate: "tool_call",
              toolCallId: id,
              title,
              name: "sub_agent",
              kind: "other",
              status: "in_progress",
              rawInput: {
                description: event.description,
                ...(event.model ? { model: event.model } : {}),
                ...(event.provider ? { provider: event.provider } : {}),
              },
            },
          ],
        };
      }
      case "complete":
      case "failed": {
        const state = this.tools.get(id);
        if (!state) return { updates: [] };
        state.status = event.message === "complete" ? "completed" : "failed";
        const summary =
          event.message === "complete"
            ? `Finished in ${(event.durationMilliseconds / 1000).toFixed(1)} s with ${event.toolCount} tool call${event.toolCount === 1 ? "" : "s"}.`
            : `Failed: ${event.error}`;
        return {
          updates: [{ sessionUpdate: "tool_call_update", toolCallId: id, status: state.status, content: [textContent(summary)] }],
        };
      }
      case "merge_back": {
        if (!this.tools.has(id)) return { updates: [] };
        const { mergeBack } = event;
        const detail =
          mergeBack.status === "conflict"
            ? `Its changes conflict with the workspace; they are kept on branch ${mergeBack.branch}${mergeBack.conflictingFiles?.length ? ` (${mergeBack.conflictingFiles.join(", ")})` : ""}.`
            : `Its changes could not be merged back${mergeBack.error ? `: ${mergeBack.error}` : ""}; branch ${mergeBack.branch}.`;
        return { updates: [{ sessionUpdate: "tool_call_update", toolCallId: id, content: [textContent(detail)] }] };
      }
      default:
        return { updates: [] };
    }
  }

  private approval(event: ApprovalRequiredEvent): TranslatedEvent {
    const key = event.subAgentId ? `${event.subAgentId}/${event.toolCallId}` : event.toolCallId;
    const { state, announce } = this.ensureTool(
      key,
      event.toolCall.name,
      event.toolCall.args,
      undefined,
      event.subAgentDescription,
    );
    state.status = "pending";
    const content = previewContent(event.preview, this.workspaceRoot);
    const reasons = [event.reason, event.protectedPath ? `Protected path: ${event.protectedPath}` : null].filter(
      (reason): reason is string => !!reason,
    );
    const toolCall: ToolCallUpdate = {
      toolCallId: state.id,
      title: state.title,
      kind: state.kind,
      status: "pending",
      rawInput: event.toolCall.args,
      locations: toolLocations(event.toolCall.args, this.workspaceRoot),
      ...(content.length > 0 || reasons.length > 0
        ? { content: [...reasons.map((reason) => textContent(reason)), ...content] }
        : {}),
    };
    return { updates: announce ? [announce] : [], interaction: { kind: "approval", event, toolCall } };
  }

  private decided(event: TurnEventOf<"approval_decided">): TranslatedEvent {
    const key = event.subAgentId ? `${event.subAgentId}/${event.toolCallId}` : event.toolCallId;
    const state = this.tools.get(key);
    const interaction: TurnInteraction = { kind: "decided", toolCallId: key };
    if (!state) return { updates: [], interaction };
    if (event.decision === "allow") {
      state.status = "in_progress";
      return { updates: [{ sessionUpdate: "tool_call_update", toolCallId: key, status: "in_progress" }], interaction };
    }
    state.status = "failed";
    return {
      updates: [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: key,
          status: "failed",
          content: [textContent(`Denied${event.reason ? `: ${event.reason}` : "."}`)],
        },
      ],
      interaction,
    };
  }

  private planProposal(event: PlanProposalEvent): TranslatedEvent {
    const plan: SessionUpdate = {
      sessionUpdate: "plan",
      entries: event.steps.map((step): PlanEntry => ({ content: step, priority: "medium", status: "pending" })),
    };
    if (event.autoApproved) return { updates: [plan] };
    const id = event.toolCallId;
    const title = "Proposed plan";
    this.tools.set(id, { id, name: "plan", title, kind: "switch_mode", status: "pending", output: "" });
    const toolCall: ToolCallUpdate = {
      toolCallId: id,
      title,
      kind: "switch_mode",
      status: "pending",
      content: [textContent(event.plan)],
    };
    return {
      updates: [
        plan,
        { sessionUpdate: "tool_call", toolCallId: id, title, kind: "switch_mode", status: "pending", content: [textContent(event.plan)] },
      ],
      interaction: { kind: "plan", event, toolCall },
    };
  }

  private usage(): TranslatedEvent {
    if (this.contextWindow === null || this.contextUsed === null) return { updates: [] };
    const cost = this.sessionCost;
    return {
      updates: [
        {
          sessionUpdate: "usage_update",
          used: this.contextUsed,
          size: this.contextWindow,
          ...(cost !== null ? { cost: { amount: cost, currency: "USD" } } : {}),
        },
      ],
    };
  }

  /** At the end of a turn, close the calls the stream left open. */
  private finishOpenTools(status: "completed" | "failed"): TranslatedEvent {
    const updates: SessionUpdate[] = [];
    for (const state of this.tools.values()) {
      if (state.status !== "pending" && state.status !== "in_progress") continue;
      // A sub-agent still running when the turn ends works on in the
      // background; its report arrives as a later turn's input.
      if (state.id.startsWith("sub-agent/") && status === "completed") continue;
      state.status = status;
      updates.push({ sessionUpdate: "tool_call_update", toolCallId: state.id, status });
    }
    return { updates };
  }

  /** Mark every open call as stopped (the turn was cancelled). */
  cancelOpenTools(): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    for (const state of this.tools.values()) {
      if (state.status !== "pending" && state.status !== "in_progress") continue;
      state.status = "failed";
      updates.push({ sessionUpdate: "tool_call_update", toolCallId: state.id, status: "failed", content: [textContent("Cancelled.")] });
    }
    return updates;
  }
}
