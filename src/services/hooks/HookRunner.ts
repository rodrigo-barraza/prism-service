import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { HOOKS } from "#src/constants";
import {
  BLOCKING_EVENTS,
  HOOK_EVENTS,
  HOOK_HANDLER_TYPES,
} from "#src/services/hooks/types";
import type {
  ConfiguredHookDocument,
  HookDecision,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import type { TransformedHookResult } from "#src/services/AgentHooks";
import type { LLMProvider } from "#src/services/harnesses/types";
import runPromptHook from "#src/services/hooks/handlers/PromptHookHandler";
import runHttpHook from "#src/services/hooks/handlers/HttpHookHandler";
import runMcpToolHook from "#src/services/hooks/handlers/McpToolHookHandler";

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
] as const;

const PERMISSION_DECISIONS = new Set(["allow", "deny", "ask"]);

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
  value: unknown,
): { decision: HookDecision; fieldCount: number } | null {
  if (!isPlainObject(value)) return null;

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
  if (value.decision === "block") {
    decision.decision = "block";
    fieldCount += 1;
  }
  if (typeof value.reason === "string") {
    decision.reason = value.reason;
    fieldCount += 1;
  }

  return { decision, fieldCount };
}

// ─── Timeout ──────────────────────────────────────────────────────────────────

/**
 * The deadline a hook actually runs under: its own setting when it has a sane
 * one, otherwise the per-event default, always clamped to the ceiling.
 * `PreToolUse` gets the tighter default because it fires before *every* tool
 * call — a slow hook there taxes the entire conversation, not one turn.
 */
export function resolveHookTimeout(hook: ConfiguredHookDocument): number {
  const eventDefault =
    hook.event === HOOK_EVENTS.PRE_TOOL_USE
      ? HOOKS.PRE_TOOL_USE_TIMEOUT_MILLISECONDS
      : HOOKS.DEFAULT_TIMEOUT_MILLISECONDS;

  const configured = hook.timeoutMilliseconds;
  const base =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : eventDefault;

  return Math.min(base, HOOKS.MAX_TIMEOUT_MILLISECONDS);
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
 * Map a hook's decision onto the `{isApproved, …}` object `AgentHooks` merges.
 *
 * Three spellings mean "stop": `permissionDecision:"deny"` (the `PreToolUse`
 * vocabulary), `decision:"block"` (the generic one), and `continue:false`
 * (abort the run). They collapse to the same internal result because the
 * kernel has exactly one refusal channel.
 *
 * A refusal on an event outside `BLOCKING_EVENTS` is dropped with a warning.
 * `SessionEnd`, `Notification`, `Stop` and friends fire at seams with nothing
 * left to refuse; honoring a deny there would mean inventing an abort path
 * that the surrounding code has no handling for. The rest of the decision —
 * `systemMessage`, `additionalContext` — still passes through, because those
 * *do* have somewhere to land.
 */
export function normalizeDecision(
  decision: HookDecision | HookHandlerResult | null | undefined,
  event: HookEventName,
): TransformedHookResult {
  const result: TransformedHookResult = {};
  if (!decision || typeof decision !== "object") return result;

  const canBlock = BLOCKING_EVENTS.includes(event);

  const wantsDeny =
    decision.permissionDecision === "deny" ||
    decision.decision === "block" ||
    decision.continue === false;
  const wantsAsk = decision.permissionDecision === "ask";

  if (wantsDeny && !canBlock) {
    logger.warn(
      `[HookRunner] Ignoring deny from a hook on "${event}": that event cannot block. Reason given: ${
        decision.permissionDecisionReason ||
        decision.reason ||
        decision.stopReason ||
        "(none)"
      }`,
    );
  } else if (wantsDeny) {
    result.isApproved = false;
    result.isDenied = true;
    result.reason =
      decision.permissionDecisionReason ||
      decision.reason ||
      decision.stopReason ||
      "Blocked by a configured hook";
  } else if (wantsAsk && !canBlock) {
    // `ask` routes into the ApprovalGate, which only exists on the tool-call
    // seam. Elsewhere it is the same category of mistake as a stray deny.
    logger.warn(
      `[HookRunner] Ignoring "ask" from a hook on "${event}": that event has no approval seam.`,
    );
  } else if (wantsAsk) {
    result.isApproved = false;
    result.requiresApproval = true;
    result.reason =
      decision.permissionDecisionReason ||
      decision.reason ||
      "A configured hook requested approval";
  } else if (decision.permissionDecision === "allow") {
    result.isApproved = true;
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
