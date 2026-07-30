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
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  POST_TOOL_USE_FAILURE: "PostToolUseFailure",
  STOP: "Stop",
  SUBAGENT_START: "SubagentStart",
  SUBAGENT_STOP: "SubagentStop",
  PRE_COMPACT: "PreCompact",
  POST_COMPACT: "PostCompact",
  NOTIFICATION: "Notification",
  SESSION_END: "SessionEnd",
  ERROR: "Error",
} as const;

export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];

export const HOOK_EVENT_NAMES = Object.values(HOOK_EVENTS) as HookEventName[];

/**
 * Config event name → `AgentHooks` internal event name.
 *
 * Four of these map onto events that already existed and already fire.
 * The rest name events this feature adds to the kernel and wires to seams
 * that previously had no hook call at all.
 */
export const INTERNAL_EVENT_BY_HOOK_EVENT = {
  [HOOK_EVENTS.SESSION_START]: "sessionStart",
  [HOOK_EVENTS.USER_PROMPT_SUBMIT]: "userPromptSubmit",
  [HOOK_EVENTS.PRE_TOOL_USE]: "beforeToolCall",
  [HOOK_EVENTS.POST_TOOL_USE]: "afterToolCall",
  [HOOK_EVENTS.POST_TOOL_USE_FAILURE]: "afterToolCallFailure",
  [HOOK_EVENTS.STOP]: "afterResponse",
  [HOOK_EVENTS.SUBAGENT_START]: "subagentStart",
  [HOOK_EVENTS.SUBAGENT_STOP]: "subagentStop",
  [HOOK_EVENTS.PRE_COMPACT]: "preCompact",
  [HOOK_EVENTS.POST_COMPACT]: "postCompact",
  [HOOK_EVENTS.NOTIFICATION]: "notification",
  [HOOK_EVENTS.SESSION_END]: "sessionEnd",
  [HOOK_EVENTS.ERROR]: "onError",
} as const;

/**
 * Events whose matcher is tested against a tool name. Every other event
 * ignores its matcher (there is nothing meaningful to match against), which
 * the route layer rejects at write time rather than silently accepting.
 */
export const TOOL_MATCHED_EVENTS: HookEventName[] = [
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_USE_FAILURE,
];

/** Events that can block. A deny on any other event is ignored and logged. */
export const BLOCKING_EVENTS: HookEventName[] = [
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.USER_PROMPT_SUBMIT,
];

export const HOOK_HANDLER_TYPES = {
  PROMPT: "prompt",
  HTTP: "http",
  MCP_TOOL: "mcp_tool",
} as const;

export type HookHandlerType =
  (typeof HOOK_HANDLER_TYPES)[keyof typeof HOOK_HANDLER_TYPES];

/**
 * Ask a model. The strongest precedent in the codebase — `CriticGate` is
 * already an LLM-in-the-loop `decide` hook; this is that, generalized over a
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

export type HookHandlerConfig =
  | PromptHookHandlerConfig
  | HttpHookHandlerConfig
  | McpToolHookHandlerConfig;

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
   * spaces are an exact name or a `|`/`,`-separated list. Anything else is an
   * unanchored regex. Same rules as Claude Code's matcher syntax.
   */
  matcher: string;
  handler: HookHandlerConfig;
  enabled: boolean;
  timeoutMilliseconds: number;
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

  /** Generic block, for events without a permission vocabulary. */
  decision?: "block";
  reason?: string;
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
  /** `Stop` / `SessionEnd`. */
  response_text?: string;
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
