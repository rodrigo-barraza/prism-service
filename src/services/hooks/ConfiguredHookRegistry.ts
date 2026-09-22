import type { Db } from "mongodb";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS, HOOKS } from "#src/constants";
import type AgentHooks from "#src/services/AgentHooks";
import type { TransformedHookResult } from "#src/services/AgentHooks";
import type { LLMProvider, ToolCall } from "#src/services/harnesses/types";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  HOOK_DEPTH_CONTEXT_KEY,
  HOOK_EVENTS,
  HOOK_HANDLER_TYPES,
  INTERNAL_EVENT_BY_HOOK_EVENT,
  MATCHER_FIELD_BY_EVENT,
  TOOL_MATCHED_EVENTS,
} from "#src/services/hooks/types";
import type {
  ConfiguredHookDocument,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import { matchesMatcher, matchesToolCall } from "#src/services/hooks/HookMatcher";
import { summarizeTranscript } from "#src/services/hooks/buildPayload";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { DEFAULT_PROFILE_ID, profileFilter } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import {
  normalizeDecision,
  runConfiguredHook,
} from "#src/services/hooks/HookRunner";

/**
 * ConfiguredHookRegistry — the bridge from stored config to the live kernel.
 *
 * `AgentHooks` knows nothing about Mongo, matchers, or Claude Code's event
 * names; it takes functions. This module is what turns twenty stored
 * documents into twenty registered functions, once per agentic run, and it
 * carries the three pieces of glue that live nowhere else:
 *
 *   - **Vocabulary.** `INTERNAL_EVENT_BY_HOOK_EVENT` is applied here and only
 *     here, so `PreToolUse` reaches `beforeToolCall` without either name
 *     leaking into the other's half of the system.
 *   - **Category.** Blocking events register as `decide` so a deny
 *     short-circuits; `PostToolUse` registers as `transform` because it can
 *     rewrite the result the model is about to read; everything else
 *     registers as `inspect` and is fire-and-forget. Getting this wrong is
 *     silent — an observability hook registered as `decide` would stall every
 *     tool call, and a gate registered as `inspect` would never gate.
 *   - **Argument shape.** `AgentHooks` handlers have per-event signatures
 *     (`(toolCall, ctx)`, `(ctx, output)`, `(payload)`). The adapter below
 *     folds all of them into the one flat `HookPayload` the handlers speak.
 *
 * Loading is cached per scope for `HOOKS.CONFIG_CACHE_TTL_MILLISECONDS`,
 * because a `PreToolUse` hook would otherwise put a Mongo round-trip in front
 * of every tool call. The routes layer calls `invalidateHookCache` on write
 * so a user editing a hook sees it take effect immediately rather than up to
 * a cache TTL later — a delay that reads as "hooks are broken".
 */

type InternalHookEvent = Parameters<AgentHooks["register"]>[0];
type HookCategory = Parameters<AgentHooks["register"]>[3];

export interface HookScope {
  project: string;
  username: string;
  /** Absent falls back to the request context's profile, then "default". */
  profileId?: string;
  /** `null`/absent loads only the scope-wide hooks. */
  agent?: string | null;
}

/**
 * What a call site knows about the run it is registering hooks for.
 *
 * Every field is optional and nullable on purpose: the harness scope object
 * that flows in here is assembled from request fields that are themselves
 * optional, and forcing each caller to coerce `null` to `undefined` at the
 * boundary buys nothing. Missing identity falls back to `"any"`, matching how
 * `agent_rules` and the rest of the scoped collections behave.
 */
export interface HookRegistrationContext {
  project?: string | null;
  username?: string | null;
  /** Absent falls back to the request context's profile, then "default". */
  profileId?: string | null;
  agent?: string | null;
  sessionId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  conversationId?: string | null;
  /** Working directory reported in the payload. `workspaceRoot` is its alias. */
  cwd?: string | null;
  workspaceRoot?: string | null;
  /** Depth of the run these hooks belong to. Nested runs pass a higher value. */
  hookDepth?: number;
  signal?: AbortSignal;
  /** Live provider, so `prompt` hooks inherit the conversation's routing. */
  provider?: LLMProvider;
  providerName?: string;
  model?: string;
  requestId?: string;
  traceId?: string | null;
  /**
   * The run's event stream. A hook's `systemMessage` is shown to the user
   * through it — for every event, including fire-and-forget ones whose
   * return value the kernel discards.
   */
  emit?: (event: Record<string, unknown>) => void;
}

/** Identity with the `"any"` fallbacks applied. */
function resolveScope(context: HookRegistrationContext): HookScope {
  return {
    project: context.project || "any",
    username: context.username || "any",
    profileId: resolveProfileId(context.profileId),
    agent: context.agent ?? null,
  };
}

/**
 * A caller that doesn't know about profiles gets the ambient request's
 * profile (AsyncLocalStorage), and the default profile outside any request.
 */
function resolveProfileId(profileId?: string | null): string {
  return profileId || getRequestContext().profileId || DEFAULT_PROFILE_ID;
}

interface CachedScope {
  expiresAt: number;
  hooks: ConfiguredHookDocument[];
}

const scopeCache = new Map<string, CachedScope>();

/** Cache key for a scope. Exported so callers can invalidate precisely. */
export function hookScopeKey(scope: HookScope | HookRegistrationContext): string {
  return `${scope.project || "any"}::${scope.username || "any"}::${resolveProfileId(scope.profileId)}::${scope.agent ?? "*"}`;
}

/**
 * Load every enabled hook that applies to a scope, newest first.
 *
 * `agent: null` documents apply to every agent in the project/user scope;
 * a named agent additionally picks up its own. The cap is a hard stop rather
 * than a warning: fifty hooks on `PreToolUse` is already a pathological
 * configuration, and the run has to stay bounded regardless.
 */
export async function loadHooksForScope(
  db: Db | null | undefined,
  scope: HookScope,
): Promise<ConfiguredHookDocument[]> {
  if (!db) return [];

  // Resolve once so the cache key and the Mongo filter agree on the profile.
  const profileId = resolveProfileId(scope.profileId);
  const key = hookScopeKey({ ...scope, profileId });
  const cached = scopeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.hooks;

  try {
    const agentFilters: Array<Record<string, unknown>> = [{ agent: null }];
    if (scope.agent) agentFilters.push({ agent: scope.agent });

    const documents = (await db
      .collection(COLLECTIONS.AGENT_HOOKS)
      .find({
        project: scope.project,
        username: scope.username,
        profileId: profileFilter(profileId),
        enabled: true,
        $or: agentFilters,
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(HOOKS.MAX_HOOKS_PER_SCOPE)
      .toArray()) as unknown as ConfiguredHookDocument[];

    scopeCache.set(key, {
      expiresAt: Date.now() + HOOKS.CONFIG_CACHE_TTL_MILLISECONDS,
      hooks: documents,
    });
    return documents;
  } catch (loadError: unknown) {
    // Deliberately not cached: a Mongo blip must not disable hooks for the
    // next TTL. The next run re-reads.
    logger.warn(
      `[ConfiguredHookRegistry] Could not load hooks for ${key}: ${errorMessage(loadError)}`,
    );
    return [];
  }
}

/** Drop one scope's cached hooks, or all of them. Call after any write. */
export function invalidateHookCache(scopeKey?: string): void {
  if (scopeKey) {
    scopeCache.delete(scopeKey);
    return;
  }
  scopeCache.clear();
}

// ─── Argument adaptation ──────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `ToolCall` as `beforeToolCall`/`afterToolCall` pass it: a named call with
 * arguments and/or an id. Checked structurally because the same position in
 * other events holds a plain payload object.
 */
function isToolCallArgument(value: unknown): value is ToolCall {
  return (
    isPlainObject(value) &&
    typeof value.name === "string" &&
    ("args" in value || "id" in value)
  );
}

/**
 * The agentic context object, distinguished from a payload by carrying the
 * live provider and the conversation's message array. Never spread into a
 * payload — it holds functions, a provider client, and the full history.
 */
function looksLikeAgenticContext(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    ("provider" in value || "resolvedModel" in value) &&
    ("messages" in value || "agentConversationId" in value)
  );
}

function readDepth(value: unknown): number | null {
  if (!isPlainObject(value)) return null;
  const depth = value[HOOK_DEPTH_CONTEXT_KEY];
  return typeof depth === "number" && Number.isFinite(depth) ? depth : null;
}

interface AdaptedArguments {
  payload: HookPayload;
  depth: number;
  signal?: AbortSignal;
  provider?: LLMProvider;
  providerName?: string;
  model?: string;
  /** The live message array, when the event was fired with the agentic context. */
  messages?: Array<Record<string, unknown>>;
}

/**
 * Fold an event's positional arguments into one flat payload.
 *
 * Two shapes arrive here, handled by position, not by guessing:
 *   - `(toolCall, second?, ctx?)` for the tool events. On `PostToolUse` /
 *     `PostToolUseFailure` `second` is the tool's result; on
 *     `PermissionRequest` / `PermissionDenied` it is the event's extra
 *     fields (tier, who denied, …).
 *   - `(payload, ctx?)` for everything else. Spreading the lone plain object
 *     is what makes a new event work without touching this file.
 * The agentic context, when passed, is never spread — it only lends the
 * provider, signal and live transcript.
 */
export function adaptHookArguments(
  event: HookEventName,
  args: unknown[],
  context: HookRegistrationContext,
): AdaptedArguments {
  const agenticContext = args.find(looksLikeAgenticContext);
  const scope = resolveScope(context);

  const payload: HookPayload = {
    hook_event_name: event,
    session_id: context.sessionId || "",
    agent_conversation_id:
      (agenticContext?.agentConversationId as string | undefined) ||
      context.agentConversationId ||
      "",
    project: scope.project,
    username: scope.username,
    agent: scope.agent ?? null,
    cwd:
      context.cwd ??
      context.workspaceRoot ??
      ((agenticContext?.workspaceRoot as string | null | undefined) || null),
  };

  const parentId =
    (agenticContext?.parentAgentConversationId as string | undefined) ||
    context.parentAgentConversationId;
  if (parentId) payload.parent_agent_conversation_id = parentId;

  const [first, second] = args;

  if (isToolCallArgument(first)) {
    payload.tool_name = first.name;
    payload.tool_input = (first.args || {}) as Record<string, unknown>;
    if (first.id) payload.tool_use_id = first.id;

    if (
      event === HOOK_EVENTS.POST_TOOL_USE ||
      event === HOOK_EVENTS.POST_TOOL_USE_FAILURE
    ) {
      payload.tool_output = second;
      const errorText = isPlainObject(second) ? second.error : undefined;
      if (typeof errorText === "string") payload.tool_error = errorText;
    } else if (isPlainObject(second) && !looksLikeAgenticContext(second)) {
      Object.assign(payload, second);
    }
  } else {
    const single = args.find(
      (argument) =>
        isPlainObject(argument) &&
        !looksLikeAgenticContext(argument) &&
        !isToolCallArgument(argument),
    );
    if (single) Object.assign(payload, single);
  }

  const depth = Math.max(
    context.hookDepth ?? 0,
    ...args.map((argument) => readDepth(argument) ?? 0),
  );

  const contextSignal = agenticContext?.signal;
  const liveMessages =
    agenticContext?._currentMessages ?? agenticContext?.messages;

  return {
    payload,
    depth,
    messages: Array.isArray(liveMessages)
      ? (liveMessages as Array<Record<string, unknown>>)
      : undefined,
    signal:
      contextSignal instanceof AbortSignal ? contextSignal : context.signal,
    provider:
      (agenticContext?.provider as LLMProvider | undefined) || context.provider,
    providerName:
      (agenticContext?.providerName as string | undefined) ||
      context.providerName,
    model:
      (agenticContext?.resolvedModel as string | undefined) || context.model,
  };
}

/** Events whose hooks gate something and short-circuit on the first refusal. */
const DECIDE_EVENTS = new Set<HookEventName>([
  HOOK_EVENTS.PRE_TOOL_USE,
  HOOK_EVENTS.USER_PROMPT_SUBMIT,
  HOOK_EVENTS.PERMISSION_REQUEST,
  HOOK_EVENTS.PRE_MODEL_SWITCH,
  HOOK_EVENTS.STOP,
]);

/** Events whose hooks are awaited for what they return, without gating. */
const TRANSFORM_EVENTS = new Set<HookEventName>([
  HOOK_EVENTS.POST_TOOL_USE,
  HOOK_EVENTS.POST_TOOL_BATCH,
  HOOK_EVENTS.INTERRUPT,
]);

/**
 * Which `AgentHooks` category a configured hook registers under.
 *
 * `inspect` hooks are fire-and-forget — their return value is discarded and
 * the loop does not wait for them. So every event whose hooks return
 * something the loop USES must be `decide` or `transform`: `PostToolUse`
 * (rewrites the result), `PostToolBatch` (adds context), `Stop` (can keep
 * the agent going). Getting this wrong is silent in both directions. An
 * `async` hook is always `inspect`, whatever its event: it must not hold up,
 * block or rewrite the action that fired it.
 */
export function categoryForEvent(
  event: HookEventName,
  isAsync = false,
): HookCategory {
  if (isAsync) return "inspect";
  if (DECIDE_EVENTS.has(event)) return "decide";
  if (TRANSFORM_EVENTS.has(event)) return "transform";
  return "inspect";
}

/** Status message a hook's `systemMessage` is shown to the user under. */
export const HOOK_SYSTEM_MESSAGE_STATUS = "hook_system_message";

/**
 * Does the hook's matcher select this occurrence of its event? Tool events
 * test the call (name, and arguments for the `Tool(argPattern)` form); the
 * events in `MATCHER_FIELD_BY_EVENT` test one payload field; every other
 * event has nothing to narrow, so its (write-time-rejected) matcher is moot.
 */
export function hookSelects(
  hook: ConfiguredHookDocument,
  payload: HookPayload,
): boolean {
  if (TOOL_MATCHED_EVENTS.includes(hook.event)) {
    return matchesToolCall(hook.matcher, payload.tool_name, payload.tool_input);
  }
  const field = MATCHER_FIELD_BY_EVENT[hook.event];
  if (field) {
    const value = payload[field];
    return matchesMatcher(
      hook.matcher,
      value === undefined || value === null ? "" : String(value),
    );
  }
  return true;
}

/**
 * Deliver an async hook's output at the running turn's next safe boundary.
 * `additionalContext` becomes a `hook_context` mailbox entry the harness
 * drains into the conversation; a turn that has already ended has no
 * boundary left, so the output is logged and dropped.
 */
function deliverAsyncOutput(
  hook: ConfiguredHookDocument,
  result: TransformedHookResult,
  context: HookRegistrationContext,
): void {
  const text =
    typeof result.additionalContext === "string" ? result.additionalContext.trim() : "";
  if (!text) return;
  const conversationId = context.conversationId || context.sessionId;
  if (!conversationId) return;
  const posted = TurnInputMailbox.post(conversationId, {
    kind: "hook_context",
    text,
    meta: { _hookName: hook.name, _hookEvent: hook.event },
  });
  if (!posted.accepted) {
    logger.info(
      `[ConfiguredHookRegistry] Async hook "${hook.name}" (${hook.event}) finished after its turn (${posted.reason}); output dropped.`,
    );
  }
}

/**
 * Register configured hooks into a live `AgentHooks` instance.
 * Returns how many were registered.
 */
export function registerConfiguredHooks(
  hooks: AgentHooks,
  configured: ConfiguredHookDocument[],
  context: HookRegistrationContext,
): number {
  let registered = 0;
  const scope = resolveScope(context);

  for (const hook of configured || []) {
    if (!hook || hook.enabled === false) continue;

    const internalEvent = INTERNAL_EVENT_BY_HOOK_EVENT[
      hook.event
    ] as InternalHookEvent | undefined;

    if (!internalEvent) {
      logger.warn(
        `[ConfiguredHookRegistry] Hook "${hook.name}" names unknown event "${hook.event}" — skipped.`,
      );
      continue;
    }

    const isAsync = hook.async === true;

    const handler = async (
      ...args: unknown[]
    ): Promise<TransformedHookResult | undefined> => {
      const adapted = adaptHookArguments(hook.event, args, context);

      // The matcher gates *before* the handler runs — the whole point of a
      // matcher is that a `Bash`-only hook costs nothing on a `Read` call.
      if (!hookSelects(hook, adapted.payload)) return undefined;

      const result = await runConfiguredHook(hook, adapted.payload, {
        hookDepth: adapted.depth,
        signal: adapted.signal,
        provider: adapted.provider,
        providerName: adapted.providerName,
        model: adapted.model,
        project: scope.project,
        username: scope.username,
        agent: scope.agent ?? null,
        requestId: context.requestId,
        traceId: context.traceId,
        conversationId: context.conversationId,
        agentConversationId:
          adapted.payload.agent_conversation_id || context.agentConversationId,
        transcript:
          hook.handler?.type === HOOK_HANDLER_TYPES.AGENT
            ? summarizeTranscript(adapted.messages)
            : undefined,
      });

      const normalized = normalizeDecision(result, hook.event);

      // Shown to the user here, once, for every event and category — an
      // inspect hook's return value never reaches its call site.
      if (typeof normalized.systemMessage === "string" && normalized.systemMessage) {
        context.emit?.({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: HOOK_SYSTEM_MESSAGE_STATUS,
          text: normalized.systemMessage,
          hookName: hook.name,
          hookEvent: hook.event,
        });
        delete normalized.systemMessage;
      }

      if (isAsync) {
        deliverAsyncOutput(hook, normalized, context);
        return undefined;
      }
      return normalized;
    };

    hooks.register(
      internalEvent,
      handler,
      hook.name,
      categoryForEvent(hook.event, isAsync),
    );
    registered += 1;
  }

  if (registered > 0) {
    logger.debug(
      `[ConfiguredHookRegistry] Registered ${registered} configured hook(s) for ${hookScopeKey(context)}`,
    );
  }

  return registered;
}

/** Load and register in one call — the shape every wiring site wants. */
export async function loadAndRegisterHooks(
  db: Db | null | undefined,
  hooks: AgentHooks,
  context: HookRegistrationContext,
): Promise<number> {
  const configured = await loadHooksForScope(db, resolveScope(context));
  if (configured.length === 0) return 0;
  return registerConfiguredHooks(hooks, configured, context);
}

const ConfiguredHookRegistry = {
  loadHooksForScope,
  registerConfiguredHooks,
  loadAndRegisterHooks,
  invalidateHookCache,
  hookScopeKey,
  categoryForEvent,
  adaptHookArguments,
  hookSelects,
};

export default ConfiguredHookRegistry;
