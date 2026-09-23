import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { HOOKS } from "#src/constants";
import {
  BLOCKING_EVENTS,
  HOOK_EVENTS,
  HOOK_HANDLER_TYPES,
} from "#src/services/hooks/types";
import type {
  CommandHookHandlerConfig,
  ConfiguredHookDocument,
  HookDecision,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import type { TransformedHookResult } from "#src/services/AgentHooks";
import type { LLMProvider } from "#src/services/harnesses/types";
import type { HookTranscriptEntry } from "#src/services/hooks/buildPayload";
import runPromptHook from "#src/services/hooks/handlers/PromptHookHandler";
import runHttpHook from "#src/services/hooks/handlers/HttpHookHandler";
import runMcpToolHook from "#src/services/hooks/handlers/McpToolHookHandler";
import runCommandHook, {
  commandTimeoutDecision,
} from "#src/services/hooks/handlers/CommandHookHandler";
import runAgentHook from "#src/services/hooks/handlers/AgentHookHandler";

/**
 * HookRunner — the one place a configured hook actually executes.
 *
 * Everything hostile about this feature converges here. A hook is user
 * config that runs *inside* the agentic loop, so each of these bounds is
 * load-bearing rather than decorative:
 *
 *   - **Depth.** A hook can call a model, that model can call a tool, and
 *     that tool call fires `PreToolUse` again. Left alone that is unbounded
 *     recursion with an LLM in each frame. Runs at or past `HOOKS.MAX_DEPTH`
 *     skip instead of executing.
 *   - **Time.** Every handler is raced against a clamped deadline *and*
 *     handed the matching abort signal. Both, because a handler that ignores
 *     its signal would otherwise hold the loop open past the deadline.
 *   - **Size.** Payloads in and messages out are capped, so a 40 MB tool
 *     result can't become a 40 MB prompt or a 40 MB SSE frame.
 *   - **Blast radius.** Nothing thrown by a handler escapes. A broken hook
 *     degrades to "no decision", never to a failed turn.
 *
 * The other half of the module is `normalizeDecision`, which translates
 * Claude Code's hook-output vocabulary into the `{isApproved, …}` shape
 * `AgentHooks` already merges. That translation is where the rule "a deny on
 * an event that cannot block is ignored" lives — `SessionEnd` has no seam to
 * refuse anything at, so a deny there is a config mistake, and silently
 * honoring it in some future refactor would be far worse than logging it.
 *
 * Note on module shape: the handler modules import `pickHookDecision` and
 * `HookHandlerResult` from here while this module imports their entry points.
 * The cycle is function-level only — neither side touches the other during
 * module evaluation — so ESM's live bindings resolve it cleanly. The
 * decision vocabulary belongs with the dispatcher that consumes it.
 */

/**
 * What a handler hands back: a decision, plus out-of-band failure reporting.
 *
 * The underscore-prefixed fields never reach `AgentHooks` — `normalizeDecision`
 * drops them. They exist so a caller can distinguish "the hook ran and had no
 * opinion" from "the hook could not run", which matters when deciding whether
 * a `PreToolUse` gate actually gated anything.
 */
export interface HookHandlerResult extends HookDecision {
  /** The handler could not complete. Non-blocking: treated as no decision. */
  _handlerFailed?: boolean;
  /** Stable code describing the failure. */
  _reason?: string;
}

/** Every field a hook may return. Anything else in the JSON is discarded. */
export const HOOK_DECISION_FIELDS = [
  "continue",
  "stopReason",
  "systemMessage",
  "additionalContext",
  "permissionDecision",
  "permissionDecisionReason",
  "updatedInput",
  "updatedToolOutput",
  "decision",
  "reason",
  "message",
] as const;

const PERMISSION_DECISIONS = new Set(["allow", "deny", "ask"]);
const GENERIC_DECISIONS = new Set(["block", "allow", "deny"]);

/**
 * Payload keys that survive truncation. These identify *which* event fired
 * and for whom; a handler that loses them can't do anything useful, whereas
 * losing an oversized `tool_output` merely costs it detail.
 */
const PROTECTED_PAYLOAD_KEYS = new Set([
  "hook_event_name",
  "session_id",
  "agent_conversation_id",
  "project",
  "username",
  "agent",
  "cwd",
  "parent_agent_conversation_id",
  "tool_name",
  "tool_use_id",
]);

export interface HookRunOptions {
  /** Current nesting depth. A hook running at `HOOKS.MAX_DEPTH` is skipped. */
  hookDepth?: number;
  /** Caller abort (user stop / request teardown), combined with the deadline. */
  signal?: AbortSignal;
  /** Live provider from the agentic context, preferred by `prompt` handlers. */
  provider?: LLMProvider;
  providerName?: string;
  /** Model to use when the hook does not name one. */
  model?: string;
  /** HMAC secret for `http` handlers, when the stored hook carries one. */
  secret?: string;
  /** Identity for background-LLM cost accounting on `prompt` handlers. */
  project?: string;
  username?: string;
  agent?: string | null;
  requestId?: string;
  traceId?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
  /** Recent conversation, for `agent` verifiers. */
  transcript?: HookTranscriptEntry[];
}

// ─── Serialization ────────────────────────────────────────────────────────────

/** `JSON.stringify` that survives circular references and throwing getters. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, nested: unknown) => {
        if (typeof nested === "bigint") return nested.toString();
        if (nested && typeof nested === "object") {
          if (seen.has(nested as object)) return "[circular]";
          seen.add(nested as object);
        }
        return nested;
      }) ?? "null"
    );
  } catch (serializationError: unknown) {
    return JSON.stringify({
      _serializationError: errorMessage(serializationError),
    });
  }
}

/**
 * Serialize a payload to JSON under a character cap, staying valid JSON the
 * whole way down.
 *
 * Truncation drops the largest non-identifying field first and re-measures,
 * because the overflow is nearly always one field — a file read, a diff, a
 * screenshot's base64 — rather than broad bloat. A naive `slice()` would
 * produce a body no `http` receiver could parse.
 */
export function serializeHookPayload(
  payload: HookPayload,
  maxChars: number = HOOKS.MAX_PAYLOAD_CHARS,
): string {
  const serialized = safeStringify(payload);
  if (serialized.length <= maxChars) return serialized;

  const reduced: Record<string, unknown> = { ...payload };
  const bySizeDescending = Object.keys(reduced)
    .filter((key) => !PROTECTED_PAYLOAD_KEYS.has(key))
    .map((key) => ({ key, size: safeStringify(reduced[key]).length }))
    .sort((left, right) => right.size - left.size);

  for (const { key, size } of bySizeDescending) {
    if (safeStringify(reduced).length <= maxChars) break;
    reduced[key] = `[truncated: ${size} chars omitted]`;
  }

  let result = safeStringify(reduced);
  if (result.length <= maxChars) return result;

  // Pathological case — the identifying fields alone blow the cap. Emit the
  // smallest thing that is still a well-formed hook payload.
  const minimal: Record<string, unknown> = { _truncated: true };
  for (const key of PROTECTED_PAYLOAD_KEYS) {
    if (key in payload) minimal[key] = payload[key];
  }
  result = safeStringify(minimal);
  return result.length <= maxChars ? result : `{"_truncated":true}`;
}

/** Cap a handler-supplied string, marking the cut so it doesn't read as complete. */
export function truncateHookOutput(
  text: string,
  maxChars: number = HOOKS.MAX_OUTPUT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars]`;
}

// ─── Decision parsing ─────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Extract the recognized decision fields from arbitrary parsed JSON.
 *
 * Returns `null` when the value isn't an object at all. `fieldCount` lets a
 * caller tell "an object shaped like a decision" from "an object that merely
 * happens to be JSON" — the difference between an MCP tool answering the hook
 * contract and one returning its own unrelated result.
 *
 * Unknown fields are dropped rather than passed through: a handler that
 * returns `{"isApproved": false}` (the *internal* vocabulary) must not
 * accidentally deny by having its field merged straight into the hook result.
 */
export function pickHookDecision(
  input: unknown,
): { decision: HookDecision; fieldCount: number } | null {
  if (!isPlainObject(input)) return null;

  // Claude Code nests the event-specific half under `hookSpecificOutput`
  // (`{"hookSpecificOutput": {"hookEventName": "PreToolUse",
  // "permissionDecision": "deny"}}`). A hook script written for Claude Code
  // must work here unchanged, so the nested fields are lifted to the top;
  // a top-level field of the same name still wins.
  const nested = isPlainObject(input.hookSpecificOutput)
    ? input.hookSpecificOutput
    : null;
  const value: Record<string, unknown> = nested ? { ...nested, ...input } : input;

  const decision: HookDecision = {};
  let fieldCount = 0;

  if (typeof value.continue === "boolean") {
    decision.continue = value.continue;
    fieldCount += 1;
  }
  if (typeof value.stopReason === "string") {
    decision.stopReason = value.stopReason;
    fieldCount += 1;
  }
  if (typeof value.systemMessage === "string") {
    decision.systemMessage = value.systemMessage;
    fieldCount += 1;
  }
  if (typeof value.additionalContext === "string") {
    decision.additionalContext = value.additionalContext;
    fieldCount += 1;
  }
  if (
    typeof value.permissionDecision === "string" &&
    PERMISSION_DECISIONS.has(value.permissionDecision)
  ) {
    decision.permissionDecision = value.permissionDecision as
      | "allow"
      | "deny"
      | "ask";
    fieldCount += 1;
  }
  if (typeof value.permissionDecisionReason === "string") {
    decision.permissionDecisionReason = value.permissionDecisionReason;
    fieldCount += 1;
  }
  if (isPlainObject(value.updatedInput)) {
    decision.updatedInput = value.updatedInput;
    fieldCount += 1;
  }
  if ("updatedToolOutput" in value) {
    decision.updatedToolOutput = value.updatedToolOutput;
    fieldCount += 1;
  }
  if (typeof value.decision === "string" && GENERIC_DECISIONS.has(value.decision)) {
    decision.decision = value.decision as "block" | "allow" | "deny";
    fieldCount += 1;
  }
  if (typeof value.reason === "string") {
    decision.reason = value.reason;
    fieldCount += 1;
  }
  if (typeof value.message === "string") {
    decision.message = value.message;
    fieldCount += 1;
  }

  return { decision, fieldCount };
}

// ─── Timeout ──────────────────────────────────────────────────────────────────

/** Per-event default deadline and ceiling, where they differ from the generic ones. */
const EVENT_TIMEOUTS: Partial<
  Record<HookEventName, { defaultMilliseconds: number; maxMilliseconds?: number }>
> = {
  // Before every tool call (and every approval prompt): a slow hook here
  // taxes the entire conversation, not one turn.
  [HOOK_EVENTS.PRE_TOOL_USE]: { defaultMilliseconds: HOOKS.PRE_TOOL_USE_TIMEOUT_MILLISECONDS },
  [HOOK_EVENTS.PERMISSION_REQUEST]: { defaultMilliseconds: HOOKS.PRE_TOOL_USE_TIMEOUT_MILLISECONDS },
  // The user pressed Stop and is watching it take effect.
  [HOOK_EVENTS.INTERRUPT]: {
    defaultMilliseconds: HOOKS.INTERRUPT_TIMEOUT_MILLISECONDS,
    maxMilliseconds: HOOKS.INTERRUPT_MAX_TIMEOUT_MILLISECONDS,
  },
};

/**
 * The deadline a hook actually runs under: its own setting when it has a sane
 * one, otherwise the per-event default, always clamped to the event's ceiling
 * (`Interrupt`: 3 s) or the global one.
 */
export function resolveHookTimeout(hook: ConfiguredHookDocument): number {
  const eventTimeouts = EVENT_TIMEOUTS[hook.event];
  const eventDefault =
    eventTimeouts?.defaultMilliseconds ?? HOOKS.DEFAULT_TIMEOUT_MILLISECONDS;
  const ceiling = eventTimeouts?.maxMilliseconds ?? HOOKS.MAX_TIMEOUT_MILLISECONDS;

  const configured = hook.timeoutMilliseconds;
  const base =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : eventDefault;

  return Math.min(base, ceiling);
}

class HookTimeoutError extends Error {}

/**
 * Race a handler against its deadline. The handler also receives the abort
 * signal — this race is the backstop for one that ignores it, so the loop is
 * released on time even if the underlying work is still running.
 */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMilliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HookTimeoutError(
                `${label} exceeded its ${timeoutMilliseconds}ms budget`,
              ),
            ),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildSignal(
  timeoutMilliseconds: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const deadlineSignal = AbortSignal.timeout(timeoutMilliseconds);
  if (!callerSignal) return deadlineSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([deadlineSignal, callerSignal]);
  }
  return deadlineSignal;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Run one configured hook and return whatever decision it produced.
 *
 * Never throws and never rejects. Every failure mode — depth ceiling, unknown
 * handler type, timeout, egress refusal, provider outage — resolves to a
 * result carrying `_handlerFailed`, so the caller's control flow has exactly
 * one shape.
 */
export async function runConfiguredHook(
  hook: ConfiguredHookDocument,
  payload: HookPayload,
  options: HookRunOptions = {},
): Promise<HookHandlerResult> {
  const depth = options.hookDepth ?? 0;
  if (depth >= HOOKS.MAX_DEPTH) {
    logger.warn(
      `[HookRunner] Skipping hook "${hook.name}" on ${hook.event}: depth ${depth} is at the ${HOOKS.MAX_DEPTH} ceiling (a hook triggered by another hook's work).`,
    );
    return { _handlerFailed: true, _reason: "hook_depth_exceeded" };
  }

  const timeoutMilliseconds = resolveHookTimeout(hook);
  const signal = buildSignal(timeoutMilliseconds, options.signal);
  const payloadJson = serializeHookPayload(payload);
  const label = `Hook "${hook.name}" (${hook.handler?.type})`;

  try {
    const handlerType = hook.handler?.type;
    let work: Promise<HookHandlerResult>;

    switch (handlerType) {
      case HOOK_HANDLER_TYPES.PROMPT:
        work = runPromptHook(hook.handler, payload, {
          payloadJson,
          event: hook.event,
          signal,
          timeoutMilliseconds,
          hookName: hook.name,
          provider: options.provider,
          providerName: options.providerName,
          model: options.model,
          project: options.project ?? hook.project,
          username: options.username ?? hook.username,
          agent: options.agent ?? hook.agent,
          requestId: options.requestId,
          traceId: options.traceId,
          conversationId: options.conversationId,
          agentConversationId: options.agentConversationId,
        });
        break;

      case HOOK_HANDLER_TYPES.HTTP:
        work = runHttpHook(hook.handler, {
          payloadJson,
          signal,
          hookName: hook.name,
          hookId: hook.id,
          event: hook.event,
          secret:
            options.secret ??
            (hook as ConfiguredHookDocument & { secret?: string }).secret,
        });
        break;

      case HOOK_HANDLER_TYPES.MCP_TOOL:
        work = runMcpToolHook(hook.handler, payload, {
          signal,
          timeoutMilliseconds,
          hookName: hook.name,
          // The hook reaches its OWNER's MCP servers, like a command hook
          // runs with its owner's rights.
          scope: {
            username: hook.username,
            profileId: (hook as { profileId?: string | null }).profileId ?? null,
          },
        });
        break;

      case HOOK_HANDLER_TYPES.COMMAND:
        work = runCommandHook(hook.handler, {
          payloadJson,
          event: hook.event,
          signal,
          timeoutMilliseconds,
          hookName: hook.name,
          hookId: hook.id,
          // Ownership is the DOCUMENT's, never the caller's: a hook runs with
          // the rights of whoever it belongs to.
          owner: hook.username,
          project: options.project ?? hook.project,
          sessionId: payload.session_id,
          cwd: payload.cwd,
        });
        break;

      case HOOK_HANDLER_TYPES.AGENT:
        work = runAgentHook(hook.handler, payload, {
          payloadJson,
          event: hook.event,
          signal,
          timeoutMilliseconds,
          hookName: hook.name,
          provider: options.provider,
          providerName: options.providerName,
          model: options.model,
          project: options.project ?? hook.project,
          username: options.username ?? hook.username,
          agent: options.agent ?? hook.agent,
          requestId: options.requestId,
          traceId: options.traceId,
          conversationId: options.conversationId,
          agentConversationId: options.agentConversationId,
          transcript: options.transcript,
        });
        break;

      default:
        logger.warn(
          `[HookRunner] Hook "${hook.name}" has unknown handler type "${String(handlerType)}"`,
        );
        return { _handlerFailed: true, _reason: "unknown_handler_type" };
    }

    const result = await withDeadline(work, timeoutMilliseconds, label);
    return capOutputs(result);
  } catch (hookError: unknown) {
    const reason =
      hookError instanceof HookTimeoutError ? "hook_timeout" : "hook_error";
    logger.warn(
      `[HookRunner] ${label} failed on ${hook.event} (${reason}): ${errorMessage(hookError)}`,
    );
    // A command hook configured `fail_closed` blocks when the runner's own
    // deadline wins the race, the same as when tools-service reports it.
    if (reason === "hook_timeout" && hook.handler?.type === HOOK_HANDLER_TYPES.COMMAND) {
      const closed = commandTimeoutDecision(
        hook.handler as CommandHookHandlerConfig,
        hook.event,
        hook.name,
      );
      if (closed) return { ...closed, _reason: "command_timeout_fail_closed" };
    }
    return { _handlerFailed: true, _reason: reason };
  }
}

function capOutputs(result: HookHandlerResult): HookHandlerResult {
  if (!result || typeof result !== "object") return {};
  const capped: HookHandlerResult = { ...result };
  if (typeof capped.systemMessage === "string") {
    capped.systemMessage = truncateHookOutput(capped.systemMessage);
  }
  if (typeof capped.additionalContext === "string") {
    capped.additionalContext = truncateHookOutput(capped.additionalContext);
  }
  return capped;
}

// ─── Translation into the kernel's vocabulary ────────────────────────────────

/**
 * Map a hook's decision onto the result `AgentHooks` merges.
 *
 * Every vocabulary collapses to one verdict — deny, ask or allow:
 *   - deny:  `permissionDecision:"deny"`, `decision:"block"|"deny"`,
 *            `continue:false`. On `Stop` only `decision:"block"` counts, and
 *            it means the opposite of stopping: the agent keeps going with
 *            the reason as its next instruction (`continue:false` on `Stop`
 *            is the turn ending, which it already is).
 *   - ask:   `permissionDecision:"ask"` — a per-call approval request. Only
 *            `PreToolUse` has one to make; the approval gate reads it.
 *   - allow: `permissionDecision:"allow"`, `decision:"allow"` — skips the
 *            mode's prompt on `PreToolUse`, or answers the prompt on
 *            `PermissionRequest`. It never overrides a deny rule.
 *
 * A refusal on an event outside `BLOCKING_EVENTS` is dropped with a warning:
 * `SessionEnd`, `Notification` and friends fire at seams with nothing left to
 * refuse. `systemMessage`, `additionalContext` and the rewrites still pass
 * through; the call site decides whether its event honours them.
 */
export function normalizeDecision(
  decision: HookDecision | HookHandlerResult | null | undefined,
  event: HookEventName,
): TransformedHookResult {
  const result: TransformedHookResult = {};
  if (!decision || typeof decision !== "object") return result;

  const canBlock = BLOCKING_EVENTS.includes(event);
  const reasonText =
    decision.permissionDecisionReason ||
    decision.reason ||
    decision.message ||
    decision.stopReason;

  let verdict: "deny" | "ask" | "allow" | null = null;
  if (event === HOOK_EVENTS.STOP) {
    if (decision.decision === "block") verdict = "deny";
  } else if (
    decision.permissionDecision === "deny" ||
    decision.decision === "block" ||
    decision.decision === "deny" ||
    decision.continue === false
  ) {
    verdict = "deny";
  } else if (decision.permissionDecision === "ask") {
    verdict = "ask";
  } else if (
    decision.permissionDecision === "allow" ||
    decision.decision === "allow"
  ) {
    verdict = "allow";
  }

  if (verdict === "deny" && !canBlock) {
    logger.warn(
      `[HookRunner] Ignoring deny from a hook on "${event}": that event cannot block. Reason given: ${reasonText || "(none)"}`,
    );
  } else if (verdict === "deny") {
    result.isApproved = false;
    result.isDenied = true;
    result.permissionDecision = "deny";
    result.reason = reasonText || "Blocked by a configured hook";
  } else if (verdict === "ask" && event !== HOOK_EVENTS.PRE_TOOL_USE) {
    // Only `PreToolUse` sits in front of an approval step it can route a
    // call into. Elsewhere `ask` is the same category of mistake as a stray
    // deny.
    logger.warn(
      `[HookRunner] Ignoring "ask" from a hook on "${event}": only PreToolUse can request an approval.`,
    );
  } else if (verdict === "ask") {
    result.permissionDecision = "ask";
    result.reason = reasonText || "A configured hook requested approval";
  } else if (
    verdict === "allow" &&
    (event === HOOK_EVENTS.PRE_TOOL_USE || event === HOOK_EVENTS.PERMISSION_REQUEST)
  ) {
    result.isApproved = true;
    result.permissionDecision = "allow";
    if (reasonText) result.reason = reasonText;
  }

  if (decision.updatedInput) result.updatedInput = decision.updatedInput;
  if ("updatedToolOutput" in decision) {
    result.updatedToolOutput = decision.updatedToolOutput;
  }
  if (typeof decision.additionalContext === "string") {
    result.additionalContext = decision.additionalContext;
  }
  if (typeof decision.systemMessage === "string") {
    result.systemMessage = decision.systemMessage;
  }

  return result;
}

const HookRunner = {
  runConfiguredHook,
  normalizeDecision,
  resolveHookTimeout,
  serializeHookPayload,
  truncateHookOutput,
  pickHookDecision,
};

export default HookRunner;
