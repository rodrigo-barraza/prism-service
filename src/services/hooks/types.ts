import type { ObjectId } from "mongodb";

/**
 * Configurable lifecycle hooks — the user-facing analogue of Claude Code's
 * hooks (https://code.claude.com/docs/en/hooks).
 *
 * `AgentHooks` is the in-process kernel: code registers handlers against
 * five internal events. That kernel is untouched by this module. What was
 * missing is the *declarative* half — a way for a user to attach behavior to
 * the loop without editing TypeScript and redeploying.
 *
 * The split this module maintains:
 *   - Config speaks Claude Code's event names (`PreToolUse`, `Stop`, …), so
 *     the published hooks documentation reads as a spec for this feature.
 *   - The kernel keeps prism's internal names (`beforeToolCall`, …), which
 *     have live call sites and tests. `INTERNAL_EVENT_BY_HOOK_EVENT` is the
 *     only place the two vocabularies meet.
 */

/** User-facing event names. Mirrors Claude Code's hook event vocabulary. */
export const HOOK_EVENTS = {
  /** Once per conversation session — see `HookSessionTracker`. */
  SESSION_START: "SessionStart",
  /** Once per turn (every agentic run), before the first model call. */
  TURN_START: "TurnStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  /**
   * A standing instruction reached the model: PRISM.md, a workspace file or
   * always-on rule, or a pinned rule at turn start; a glob-scoped workspace
   * rule after the batch that touched a matching file.
   */
  INSTRUCTIONS_LOADED: "InstructionsLoaded",
  /** The turn runs a different model from the conversation's last turn. */
  PRE_MODEL_SWITCH: "PreModelSwitch",
  POST_MODEL_SWITCH: "PostModelSwitch",
  /** Before the permission layers — rules, mode, human — see the call. */
  PRE_TOOL_USE: "PreToolUse",
  /** Just before a human is asked to approve a call. */
  PERMISSION_REQUEST: "PermissionRequest",
  /** A call was denied by a rule, the classifier, a hook, or the user. */
  PERMISSION_DENIED: "PermissionDenied",
  POST_TOOL_USE: "PostToolUse",
  POST_TOOL_USE_FAILURE: "PostToolUseFailure",
  /** A whole batch resolved; the next model call has not been made. */
  POST_TOOL_BATCH: "PostToolBatch",
  /** The model answered without tool calls. Awaited; `block` continues. */
  STOP: "Stop",
  /** The turn ended on an error (usually the provider's). */
  STOP_FAILURE: "StopFailure",
  /** The user pressed Stop. */
  INTERRUPT: "Interrupt",
  SUBAGENT_START: "SubagentStart",
  SUBAGENT_STOP: "SubagentStop",
  PRE_COMPACT: "PreCompact",
  POST_COMPACT: "PostCompact",
  /** A human is actually being asked something (after the gate decided). */
  NOTIFICATION: "Notification",
  TURN_END: "TurnEnd",
  /** The session went idle (or the service is shutting down). */
  SESSION_END: "SessionEnd",
  ERROR: "Error",
} as const;

export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];

export const HOOK_EVENT_NAMES = Object.values(HOOK_EVENTS) as HookEventName[];

/**
 * Config event name → `AgentHooks` internal event name.
 *
 * `PreToolUse` and `Stop` deliberately do NOT share the built-ins' events:
 * `beforeToolCall` runs after the human approved (it is where the tier
 * re-check lives), and `afterResponse` runs inside finalize, after
 * the answer was persisted. A configured hook on either must run earlier —
 * before the approval gate, and before the turn is allowed to end — so each
 * has its own internal event fired at that earlier seam.
 */
export const INTERNAL_EVENT_BY_HOOK_EVENT = {
  [HOOK_EVENTS.SESSION_START]: "sessionStart",
  [HOOK_EVENTS.TURN_START]: "turnStart",
  [HOOK_EVENTS.USER_PROMPT_SUBMIT]: "userPromptSubmit",
  [HOOK_EVENTS.INSTRUCTIONS_LOADED]: "instructionsLoaded",
  [HOOK_EVENTS.PRE_MODEL_SWITCH]: "preModelSwitch",
  [HOOK_EVENTS.POST_MODEL_SWITCH]: "postModelSwitch",
  [HOOK_EVENTS.PRE_TOOL_USE]: "preToolUse",
  [HOOK_EVENTS.PERMISSION_REQUEST]: "permissionRequest",
  [HOOK_EVENTS.PERMISSION_DENIED]: "permissionDenied",
  [HOOK_EVENTS.POST_TOOL_USE]: "afterToolCall",
  [HOOK_EVENTS.POST_TOOL_USE_FAILURE]: "afterToolCallFailure",
  [HOOK_EVENTS.POST_TOOL_BATCH]: "postToolBatch",
  [HOOK_EVENTS.STOP]: "stop",
  [HOOK_EVENTS.STOP_FAILURE]: "stopFailure",
  [HOOK_EVENTS.INTERRUPT]: "interrupt",
  [HOOK_EVENTS.SUBAGENT_START]: "subagentStart",
  [HOOK_EVENTS.SUBAGENT_STOP]: "subagentStop",
  [HOOK_EVENTS.PRE_COMPACT]: "preCompact",
  [HOOK_EVENTS.POST_COMPACT]: "postCompact",
  [HOOK_EVENTS.NOTIFICATION]: "notification",
  [HOOK_EVENTS.TURN_END]: "turnEnd",
  [HOOK_EVENTS.SESSION_END]: "sessionEnd",
  [HOOK_EVENTS.ERROR]: "onError",
} as const;

/**
 * Events whose matcher is tested against a tool call — its name, or its name
 * and arguments in the `Tool(argPattern)` form (see `HookMatcher`).
 */
export const TOOL_MATCHED_EVENTS: HookEventName[] = [
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.PERMISSION_REQUEST,
  HOOK_EVENTS.PERMISSION_DENIED,
  HOOK_EVENTS.POST_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_USE_FAILURE,
];

/**
 * Events whose matcher is tested against one payload field instead of a tool,
 * after Claude Code (a `StopFailure` hook matching `rate_limit`, a
 * `SessionStart` hook matching `startup`). Every event in neither table
 * refuses a matcher at write time: there is nothing for it to narrow.
 */
export const MATCHER_FIELD_BY_EVENT: Partial<Record<HookEventName, string>> = {
  [HOOK_EVENTS.SESSION_START]: "source",
  [HOOK_EVENTS.SESSION_END]: "reason",
  [HOOK_EVENTS.NOTIFICATION]: "notification_type",
  [HOOK_EVENTS.STOP_FAILURE]: "error_type",
  [HOOK_EVENTS.PRE_MODEL_SWITCH]: "to_model",
  [HOOK_EVENTS.POST_MODEL_SWITCH]: "to_model",
  [HOOK_EVENTS.INSTRUCTIONS_LOADED]: "instruction_type",
  [HOOK_EVENTS.SUBAGENT_START]: "agent",
  [HOOK_EVENTS.SUBAGENT_STOP]: "agent",
};

/** Can this event's hooks carry a non-empty matcher? */
export function eventAcceptsMatcher(event: HookEventName): boolean {
  return TOOL_MATCHED_EVENTS.includes(event) || event in MATCHER_FIELD_BY_EVENT;
}

/**
 * Events whose refusal is honoured. A deny on any other event is ignored and
 * logged. What "refusal" means is per event: `PreToolUse` and
 * `PermissionRequest` refuse the call, `UserPromptSubmit` and
 * `PreModelSwitch` refuse the turn, and `Stop` refuses to let the turn END —
 * its `decision: "block"` makes the agent continue.
 */
export const BLOCKING_EVENTS: HookEventName[] = [
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.USER_PROMPT_SUBMIT,
  HOOK_EVENTS.PERMISSION_REQUEST,
  HOOK_EVENTS.PRE_MODEL_SWITCH,
  HOOK_EVENTS.STOP,
];

/**
 * Security gates: an unreadable verdict from a model-backed handler on one of
 * these is a deny, not "no opinion" (see `PromptHookHandler`). Deliberately
 * narrower than `BLOCKING_EVENTS` — failing closed on `Stop` would force a
 * continuation on every garbled reply, and on `PreModelSwitch` would refuse
 * the whole turn.
 */
export const FAIL_CLOSED_EVENTS: HookEventName[] = [
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.USER_PROMPT_SUBMIT,
  HOOK_EVENTS.PERMISSION_REQUEST,
];

/** Events whose `additionalContext` reaches the model. */
export const CONTEXT_EVENTS: HookEventName[] = [
  HOOK_EVENTS.USER_PROMPT_SUBMIT,
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_BATCH,
  HOOK_EVENTS.STOP,
];

export const HOOK_HANDLER_TYPES = {
  PROMPT: "prompt",
  HTTP: "http",
  MCP_TOOL: "mcp_tool",
  COMMAND: "command",
  AGENT: "agent",
} as const;

export type HookHandlerType =
  (typeof HOOK_HANDLER_TYPES)[keyof typeof HOOK_HANDLER_TYPES];

/**
 * Ask a model — auto mode's classifier (permissions/AutoModeClassifier) is
 * the built-in LLM-in-the-loop verdict; this is that, generalized over a
 * user-supplied template.
 */
export interface PromptHookHandlerConfig {
  type: typeof HOOK_HANDLER_TYPES.PROMPT;
  /** Template. `$ARGUMENTS` expands to the hook payload as JSON. */
  prompt: string;
  provider?: string;
  model?: string;
}

/** POST the payload somewhere and read a decision out of the response. */
export interface HttpHookHandlerConfig {
  type: typeof HOOK_HANDLER_TYPES.HTTP;
  url: string;
  headers?: Record<string, string>;
}

/** Call a tool on an already-connected MCP server. */
export interface McpToolHookHandlerConfig {
  type: typeof HOOK_HANDLER_TYPES.MCP_TOOL;
  server: string;
  tool: string;
  /** Values support `${path}` substitution against the hook payload. */
  input?: Record<string, unknown>;
}

/** What a `command` hook's timeout means for the action it gates. */
export const COMMAND_TIMEOUT_BEHAVIORS = ["fail_open", "fail_closed"] as const;
export type CommandTimeoutBehavior = (typeof COMMAND_TIMEOUT_BEHAVIORS)[number];

/**
 * Run a shell command with the payload on stdin (Claude Code's `command`
 * handler). Executed by tools-service in its dedicated hooks directory — see
 * `CommandHookHandler` for the exit-code contract and the privilege note.
 */
export interface CommandHookHandlerConfig {
  type: typeof HOOK_HANDLER_TYPES.COMMAND;
  command: string;
  /**
   * `fail_open` (the default) treats a timeout like any other handler
   * failure — no decision. `fail_closed` turns a timeout on a blocking event
   * into a block, for a command that IS the security gate.
   */
  timeoutBehavior?: CommandTimeoutBehavior;
}

/**
 * Experimental. A no-tools verifier sub-agent: the hook's prompt, the payload
 * AND the recent transcript, answered by the conversation's own model unless
 * one is named.
 */
export interface AgentHookHandlerConfig {
  type: typeof HOOK_HANDLER_TYPES.AGENT;
  prompt: string;
  provider?: string;
  model?: string;
}

export type HookHandlerConfig =
  | PromptHookHandlerConfig
  | HttpHookHandlerConfig
  | McpToolHookHandlerConfig
  | CommandHookHandlerConfig
  | AgentHookHandlerConfig;

/** Stored shape. Scoped `{project, username, agent}` like `agent_rules`. */
export interface ConfiguredHookDocument {
  _id?: ObjectId;
  id: string;
  project: string;
  username: string;
  /** `null` applies the hook to every agent in the scope. */
  agent: string | null;
  name: string;
  description: string;
  event: HookEventName;
  /**
   * Empty, `*`, or absent matches everything. Alphanumerics plus `_ - , |` and
   * spaces are an exact name or a `|`/`,`-separated list. `Tool(argPattern)`
   * also tests the call's arguments. Anything else is an unanchored regex.
   * Same rules as Claude Code's matcher syntax, plus the argument form of its
   * permission rules.
   */
  matcher: string;
  handler: HookHandlerConfig;
  enabled: boolean;
  /**
   * Run in the background: the action that fired the hook never waits for
   * it and cannot be blocked or rewritten by it. Whatever `additionalContext`
   * or `systemMessage` it returns is delivered through the TurnInputMailbox
   * at the running turn's next boundary. Absent on documents written before
   * the field existed, which is `false`.
   */
  async?: boolean;
  timeoutMilliseconds: number;
  /**
   * HMAC key for `http` handlers, generated on create. Lets a receiver verify
   * the request really came from prism rather than anything else that can
   * reach its URL. Returned once at creation and projected out of reads,
   * matching `webhook_subscriptions`.
   */
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a hook handler may return. A subset of Claude Code's hook output
 * contract — the fields that have somewhere to land in this architecture.
 * Omitted deliberately: `suppressOutput` and `terminalSequence` (no terminal),
 * and the elicitation/worktree families (no equivalent surface).
 */
export interface HookDecision {
  /** `false` aborts the run. Honored on blocking events only. */
  continue?: boolean;
  stopReason?: string;
  /** Surfaced to the user as a `status` SSE event. Never seen by the model. */
  systemMessage?: string;
  /** Injected into the conversation so the model sees it. */
  additionalContext?: string;

  /** `PreToolUse`. `ask` routes into the existing ApprovalGate. */
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  /** `PreToolUse` — rewrite the arguments before the tool runs. */
  updatedInput?: Record<string, unknown>;
  /** `PostToolUse` — rewrite the result before the model sees it. */
  updatedToolOutput?: unknown;

  /**
   * `block` is the generic refusal (on `Stop`: keep going). `allow`/`deny`
   * is the `PermissionRequest` vocabulary, equivalent to
   * `permissionDecision`.
   */
  decision?: "block" | "allow" | "deny";
  reason?: string;
  /** `PermissionRequest` — shown on deny. An alias of `reason`. */
  message?: string;
}

/** The payload every handler receives, mirroring Claude Code's hook input. */
export interface HookPayload {
  hook_event_name: HookEventName;
  session_id: string;
  agent_conversation_id: string;
  project: string;
  username: string;
  agent: string | null;
  cwd: string | null;
  /** Present on sub-agent runs, absent on the top-level loop. */
  parent_agent_conversation_id?: string;
  /** Tool events. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_output?: unknown;
  tool_error?: string;
  /** `UserPromptSubmit`. */
  prompt?: string;
  /** `Stop` / `TurnEnd`. */
  response_text?: string;
  /** `Stop` — the answer the agent is trying to end the turn with. */
  last_assistant_message?: string;
  /** `Stop` — true when this stop follows a continuation a Stop hook forced. */
  stop_hook_active?: boolean;
  /** Compaction events. */
  pre_compact_token_count?: number;
  post_compact_token_count?: number;
  /** `Notification`. */
  notification_type?: string;
  notification_message?: string;
  /** `Error`. */
  error_message?: string;
  [key: string]: unknown;
}

/**
 * Guards against a hook that spawns work whose tool calls fire hooks. Compared
 * against `HOOKS.MAX_DEPTH`; a handler running at or past the ceiling is
 * skipped rather than executed.
 */
export const HOOK_DEPTH_CONTEXT_KEY = "_hookDepth";
