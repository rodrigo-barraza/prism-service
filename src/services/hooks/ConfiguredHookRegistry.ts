import type { Db } from "mongodb";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS, HOOKS } from "#src/constants";
import type AgentHooks from "#src/services/AgentHooks";
import type { TransformedHookResult } from "#src/services/AgentHooks";
import type { LLMProvider, ToolCall } from "#src/services/harnesses/types";
import {
  BLOCKING_EVENTS,
  HOOK_DEPTH_CONTEXT_KEY,
  HOOK_EVENTS,
  INTERNAL_EVENT_BY_HOOK_EVENT,
  TOOL_MATCHED_EVENTS,
} from "#src/services/hooks/types";
import type {
  ConfiguredHookDocument,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import { matchesMatcher } from "#src/services/hooks/HookMatcher";
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
}

/**
 * Fold an event's positional arguments into one flat payload.
 *
 * Three shapes arrive here and all three are handled by position, not by
 * guessing: `(toolCall, …)` for the tool events, `(ctx, output)` for `Stop`,
 * and `(payload)` for everything the hooks feature newly wires up. The
 * fallback — spread a lone plain object — is what makes a new event work
 * without touching this file, provided it passes its fields as one object.
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
    }
  } else if (event === HOOK_EVENTS.STOP) {
    // `afterResponse(ctx, output)` — only the text belongs in a payload; the
    // rest of `output` is the whole message history.
    const output = isPlainObject(second) ? second : undefined;
    if (typeof output?.text === "string") payload.response_text = output.text;
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

  return {
    payload,
    depth,
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

/**
 * Which `AgentHooks` category a configured hook registers under.
 *
 * `PostToolUse` is the interesting case: it is not in `BLOCKING_EVENTS`, but
 * it can rewrite the tool result via `updatedToolOutput`, and `inspect` hooks
 * are fire-and-forget — their return value is discarded and the loop does not
 * wait for them. A rewrite registered as `inspect` would silently never apply.
 */
export function categoryForEvent(event: HookEventName): HookCategory {
  if (event === HOOK_EVENTS.POST_TOOL_USE) return "transform";
  if (BLOCKING_EVENTS.includes(event)) return "decide";
  return "inspect";
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

    const isToolMatched = TOOL_MATCHED_EVENTS.includes(hook.event);

    const handler = async (
      ...args: unknown[]
    ): Promise<TransformedHookResult | undefined> => {
      const adapted = adaptHookArguments(hook.event, args, context);

      // The matcher gates *before* the handler runs — the whole point of a
      // matcher is that a `Bash`-only hook costs nothing on a `Read` call.
      if (isToolMatched && !matchesMatcher(hook.matcher, adapted.payload.tool_name)) {
        return undefined;
      }

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
      });

      return normalizeDecision(result, hook.event);
    };

    hooks.register(
      internalEvent,
      handler,
      hook.name,
      categoryForEvent(hook.event),
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
};

export default ConfiguredHookRegistry;
