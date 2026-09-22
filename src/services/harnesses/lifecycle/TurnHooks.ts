import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { extractLatestUserMessageText } from "#src/utils/ConversationUtilities";
import { estimateTokens } from "#src/utils/CostCalculator";
import { ProviderError } from "#src/utils/errors";
import { COLLECTIONS, HOOKS } from "#src/constants";
import {
  buildHookPayload,
  summarizeTranscript,
} from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type { HookEventName } from "#src/services/hooks/types";
import HookSessionTracker from "#src/services/hooks/HookSessionTracker";
import type AgentHooks from "#src/services/AgentHooks";
import type { TransformedHookResult } from "#src/services/AgentHooks";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  AgenticContext,
  ConversationMessage,
  EmitFunction,
  ToolCall,
  ToolResult,
} from "#src/services/harnesses/types";

/**
 * TurnHooks — every configured-hook seam of an agentic turn, in one place,
 * shared by the ReAct loop and the Tree-/Graph-of-Thoughts strategies.
 *
 * Before this module the ReAct loop fired its session/prompt/notification
 * events inline and the branching strategies fired almost none of them, so
 * a guardrail on `UserPromptSubmit` or `Stop` silently stopped applying when
 * a conversation switched thought structure. Every harness now calls these.
 *
 * Order within a turn (the live check in docs/prompts/18 asserts it):
 *
 *   SessionStart (a new session only) → SubagentStart (sub-agents) →
 *   TurnStart → UserPromptSubmit → PreModelSwitch/PostModelSwitch →
 *   InstructionsLoaded → per batch: PreToolUse → [rules/mode] →
 *   PermissionRequest → Notification → approval_required → PermissionDenied
 *   → PostToolUse → PostToolBatch → next model call … → Stop (awaited;
 *   `block` continues, at most HOOKS.MAX_STOP_CONTINUATIONS times) →
 *   SubagentStop → TurnEnd → (idle) SessionEnd.
 *   StopFailure replaces Stop when the turn dies on an error; Interrupt fires
 *   the moment the user presses Stop.
 */

function identityOf(context: AgenticContext) {
  return {
    conversationId: context.conversationId,
    agentConversationId: context.agentConversationId as string | null | undefined,
    parentAgentConversationId: context.parentAgentConversationId as string | null | undefined,
    project: context.project,
    username: context.username,
    agent: context.agent as string | null | undefined,
    workspaceRoot: context.workspaceRoot,
  };
}

function payloadFor(
  event: HookEventName,
  context: AgenticContext,
  extra: Record<string, unknown> = {},
) {
  return buildHookPayload(event, identityOf(context), extra);
}

function hasHooks(hooks: AgentHooks, event: Parameters<AgentHooks["hasHooks"]>[0]): boolean {
  // Partial test doubles of AgentHooks have no `hasHooks`; treat as "maybe".
  return typeof hooks.hasHooks === "function" ? hooks.hasHooks(event) : true;
}

function isSubAgentRun(context: AgenticContext): boolean {
  return Boolean(context.parentAgentConversationId);
}

function emitStatus(
  emit: EmitFunction | undefined,
  message: string,
  extra: Record<string, unknown> = {},
) {
  emit?.({ type: SERVER_SENT_EVENT_TYPES.STATUS, message, ...extra });
}

function pushHookContext(currentMessages: ConversationMessage[], text: string) {
  currentMessages.push({
    role: "system",
    content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.HOOK_CONTEXT, text),
  } as ConversationMessage);
}

/**
 * Keep a hook's `additionalContext` for the message after the current batch.
 * Tolerates a state object built before the field existed (test doubles).
 */
export function rememberHookContext(state: AgenticLoopState, text: unknown): void {
  if (typeof text !== "string" || !text) return;
  if (!Array.isArray(state.pendingHookContext)) state.pendingHookContext = [];
  state.pendingHookContext.push(text);
}

function reasonOf(result: TransformedHookResult | undefined, fallback: string): string {
  return typeof result?.reason === "string" && result.reason ? result.reason : fallback;
}

// ─── Turn open / close ────────────────────────────────────────────────────────

export interface TurnHookHandle {
  /** The turn must not run: a UserPromptSubmit or PreModelSwitch hook refused it. */
  blocked: boolean;
  reason?: string;
  /** Detach the Interrupt listener and close the turn's session bookkeeping. */
  release: () => void;
}

/**
 * Everything that happens before the first model call. Returns `blocked`
 * when the turn must end here; the caller still calls `closeTurnHooks`.
 */
export async function openTurnHooks(
  context: AgenticContext,
  hooks: AgentHooks,
  currentMessages: ConversationMessage[],
  getMessages: () => ConversationMessage[] = () => currentMessages,
): Promise<TurnHookHandle> {
  const subAgent = isSubAgentRun(context);
  const conversationId = context.conversationId;
  let sessionOpened = false;

  // SessionStart — once per conversation session (root runs only).
  if (!subAgent && conversationId) {
    const hasHistory = currentMessages.some((message) => message.role === "assistant");
    const session = HookSessionTracker.beginSessionTurn(
      conversationId,
      hooks,
      identityOf(context),
      hasHistory,
    );
    sessionOpened = true;
    if (session.isNewSession) {
      await hooks.run(
        "sessionStart",
        payloadFor(HOOK_EVENTS.SESSION_START, context, { source: session.source }),
      );
    }
  }

  // A sub-agent runs its own harness, so its loop already knows it is one.
  // `subagentStart` fires here rather than at the spawn site so it lands in
  // the sub-agent's own scope, which is what a hook filtering by agent expects.
  if (subAgent) {
    await hooks.run("subagentStart", payloadFor(HOOK_EVENTS.SUBAGENT_START, context));
  }

  await hooks.run(
    "turnStart",
    payloadFor(HOOK_EVENTS.TURN_START, context, {
      is_sub_agent: subAgent,
      provider: context.providerName,
      model: context.resolvedModel,
    }),
  );

  const detachInterrupt = attachInterruptHook(hooks, context, getMessages);
  const release = () => {
    detachInterrupt();
    if (sessionOpened) HookSessionTracker.endSessionTurn(conversationId);
  };

  // UserPromptSubmit — one of the events allowed to block: a deny here ends
  // the run before a single token is spent.
  const promptVerdict = await hooks.run(
    "userPromptSubmit",
    payloadFor(HOOK_EVENTS.USER_PROMPT_SUBMIT, context, {
      prompt: extractLatestUserMessageText(currentMessages),
    }),
  );
  if (promptVerdict && promptVerdict.isApproved === false) {
    const reason = reasonOf(promptVerdict, "blocked by a UserPromptSubmit hook");
    logger.warn(`[TurnHooks] Prompt blocked before generation: ${reason}`);
    emitStatus(context.emit, `Prompt blocked: ${reason}`);
    return { blocked: true, reason, release };
  }
  if (typeof promptVerdict?.additionalContext === "string" && promptVerdict.additionalContext) {
    pushHookContext(currentMessages, promptVerdict.additionalContext);
  }

  const switchVerdict = await runModelSwitchHooks(context, hooks, currentMessages);
  if (switchVerdict.blocked) {
    emitStatus(context.emit, `Model switch blocked: ${switchVerdict.reason}`);
    return { blocked: true, reason: switchVerdict.reason, release };
  }

  return { blocked: false, release };
}

/** Everything after the turn's last step, on every exit path. */
export async function closeTurnHooks(
  context: AgenticContext,
  hooks: AgentHooks,
  state: AgenticLoopState,
  handle: TurnHookHandle | null,
  extra: { blocked?: boolean; reason?: string } = {},
): Promise<void> {
  if (isSubAgentRun(context)) {
    await hooks.run(
      "subagentStop",
      payloadFor(HOOK_EVENTS.SUBAGENT_STOP, context, { iterations: state.iterations }),
    );
  }
  await hooks.run(
    "turnEnd",
    payloadFor(HOOK_EVENTS.TURN_END, context, {
      iterations: state.iterations,
      outcome: context.signal?.aborted ? "aborted" : state.conversationOutcome,
      response_text: state.finalStreamedText || "",
      ...(extra.blocked ? { blocked: true, reason: extra.reason } : {}),
    }),
  );
  handle?.release();
}

// ─── Model switch ─────────────────────────────────────────────────────────────

/** The model the conversation's previous turn ran on, from its document. */
async function loadPreviousModel(
  context: AgenticContext,
): Promise<{ model: string; provider: string | null } | null> {
  try {
    const [{ default: MongoWrapper }, { MONGO_DB_NAME }] = await Promise.all([
      import("#src/wrappers/MongoWrapper"),
      import("#config"),
    ]);
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return null;
    const document = await database
      .collection(COLLECTIONS.AGENT_CONVERSATIONS)
      .findOne(
        { id: context.conversationId, project: context.project, username: context.username },
        { projection: { "settings.model": 1, "settings.provider": 1 } },
      );
    const settings = (document?.settings ?? null) as { model?: unknown; provider?: unknown } | null;
    if (!settings || typeof settings.model !== "string" || !settings.model) return null;
    return {
      model: settings.model,
      provider: typeof settings.provider === "string" ? settings.provider : null,
    };
  } catch (loadError: unknown) {
    logger.warn(`[TurnHooks] Could not read the previous model: ${errorMessage(loadError)}`);
    return null;
  }
}

/**
 * What switching costs in cache: the whole prompt prefix is written to the
 * new model's cache from scratch. Estimated from what the turn will send —
 * history, tool schemas and any system prompt already known — at the new
 * model's cache-write price (its input price when it has none).
 */
export function estimateRecacheCost(
  context: AgenticContext,
  currentMessages: ConversationMessage[],
): { tokens: number; costUsd: number; pricePerMillion: number } {
  const messageText = currentMessages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
    .join("\n");
  const toolText = JSON.stringify(context.options?.tools ?? []);
  const systemText = typeof context.options?.systemPrompt === "string" ? context.options.systemPrompt : "";
  const tokens = estimateTokens(`${systemText}\n${toolText}\n${messageText}`);
  const pricing = context.modelDefinition?.pricing ?? {};
  const pricePerMillion =
    (typeof pricing.cacheWriteInputPerMillion === "number" && pricing.cacheWriteInputPerMillion) ||
    (typeof pricing.inputPerMillion === "number" && pricing.inputPerMillion) ||
    0;
  return {
    tokens,
    costUsd: Number(((tokens / 1_000_000) * pricePerMillion).toFixed(6)),
    pricePerMillion,
  };
}

async function runModelSwitchHooks(
  context: AgenticContext,
  hooks: AgentHooks,
  currentMessages: ConversationMessage[],
): Promise<{ blocked: boolean; reason?: string }> {
  if (isSubAgentRun(context) || !context.conversationId) return { blocked: false };
  // One Mongo read per turn, only for conversations that have a hook to tell.
  if (!hasHooks(hooks, "preModelSwitch") && !hasHooks(hooks, "postModelSwitch")) {
    return { blocked: false };
  }
  const previous = await loadPreviousModel(context);
  if (!previous || previous.model === context.resolvedModel) return { blocked: false };

  const recache = estimateRecacheCost(context, currentMessages);
  const fields = {
    from_model: previous.model,
    from_provider: previous.provider,
    to_model: context.resolvedModel,
    to_provider: context.providerName,
    estimated_recache_tokens: recache.tokens,
    estimated_recache_cost_usd: recache.costUsd,
    cache_write_price_per_million: recache.pricePerMillion,
  };

  const verdict = await hooks.run(
    "preModelSwitch",
    payloadFor(HOOK_EVENTS.PRE_MODEL_SWITCH, context, fields),
  );
  if (verdict && verdict.isApproved === false) {
    return { blocked: true, reason: reasonOf(verdict, "blocked by a PreModelSwitch hook") };
  }
  await hooks.run("postModelSwitch", payloadFor(HOOK_EVENTS.POST_MODEL_SWITCH, context, fields));
  return { blocked: false };
}

// ─── Instructions ─────────────────────────────────────────────────────────────

export interface LoadedInstruction {
  instructionType: "project_instructions" | "rule";
  name: string;
  content: string;
}

/**
 * `InstructionsLoaded` — once per instruction the system-prompt assembler
 * put into this turn's prompt (PRISM.md, each pinned rule).
 */
export async function fireInstructionsLoaded(
  context: AgenticContext,
  hooks: AgentHooks,
  loaded: LoadedInstruction[] | undefined,
): Promise<void> {
  if (!Array.isArray(loaded) || loaded.length === 0) return;
  for (const instruction of loaded) {
    await hooks.run(
      "instructionsLoaded",
      payloadFor(HOOK_EVENTS.INSTRUCTIONS_LOADED, context, {
        instruction_type: instruction.instructionType,
        load_reason: "turn_start",
        name: instruction.name,
        file_path:
          instruction.instructionType === "project_instructions"
            ? "PRISM.md"
            : `rules/${instruction.name}`,
        file_content: instruction.content,
      }),
    );
  }
}

// ─── Tool batch ───────────────────────────────────────────────────────────────

/**
 * PreToolUse, BEFORE the approval gate (Claude Code: hooks → rules → mode →
 * ask). Per call, in parallel:
 *   - `deny` ends the call here — it never reaches a rule, the mode or a
 *     human, and no approval card is shown for it;
 *   - `ask` / `allow` are stamped on the call for the gate
 *     (`AutoApprovalEngine.check` reads them; a deny rule still wins);
 *   - `updatedInput` rewrites the arguments first, so rules, the approval
 *     card and the tool all see the rewritten call;
 *   - `additionalContext` is kept for the message after the batch.
 * Results keep the batch's order.
 */
export async function runPreToolUseStage(
  toolCalls: ToolCall[],
  context: AgenticContext,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<{ executable: ToolCall[]; blocked: ToolResult[] }> {
  if (!hasHooks(hooks, "preToolUse") || toolCalls.length === 0) {
    return { executable: toolCalls, blocked: [] };
  }

  const verdicts = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // Malformed JSON is rejected by the executor without running anything;
      // a hook has nothing meaningful to judge.
      if (toolCall._argsParseError) return undefined;
      try {
        return await hooks.run("preToolUse", toolCall, context);
      } catch (hookError: unknown) {
        logger.warn(`[TurnHooks] PreToolUse failed for ${toolCall.name}: ${errorMessage(hookError)}`);
        return undefined;
      }
    }),
  );

  const executable: ToolCall[] = [];
  const blocked: ToolResult[] = [];
  toolCalls.forEach((toolCall, index) => {
    const verdict = verdicts[index];
    if (
      verdict?.updatedInput &&
      typeof verdict.updatedInput === "object" &&
      !Array.isArray(verdict.updatedInput)
    ) {
      logger.info(`[TurnHooks] Tool "${toolCall.name}" arguments rewritten by a PreToolUse hook`);
      toolCall.args = verdict.updatedInput as Record<string, unknown>;
    }
    rememberHookContext(state, verdict?.additionalContext);

    if (verdict?.permissionDecision === "deny" || verdict?.isApproved === false) {
      const reason = reasonOf(verdict, "denied by a PreToolUse hook");
      logger.warn(`[TurnHooks] Tool "${toolCall.name}" blocked by a PreToolUse hook: ${reason}`);
      emitStatus(context.emit, `Tool "${toolCall.name}" blocked: ${reason}`);
      blocked.push({
        name: toolCall.name,
        id: toolCall.id,
        result: {
          success: false,
          error: "BLOCKED_BY_SAFETY_HOOK",
          message: `Tool execution was blocked by a PreToolUse hook: ${reason}`,
        },
      });
      return;
    }
    if (verdict?.permissionDecision === "ask" || verdict?.permissionDecision === "allow") {
      toolCall._hookPermission = {
        decision: verdict.permissionDecision,
        ...(typeof verdict.reason === "string" && { reason: verdict.reason }),
      };
    }
    executable.push(toolCall);
  });

  return { executable, blocked };
}

/**
 * The result a denied call returns to the model, worded by who denied it.
 * Shared by every harness so a hook denial never reads as "policy". Lives
 * here rather than in ApprovalGate so harness tests that mock the gate need
 * no new export.
 */
export function buildDeniedToolResult(toolCall: ToolCall): ToolResult {
  const reason = toolCall._approval?.reason || "policy rule";
  if (toolCall._approval?.deniedBy === "hook") {
    return {
      name: toolCall.name,
      id: toolCall.id,
      result: {
        success: false,
        error: "BLOCKED_BY_SAFETY_HOOK",
        message: `Tool execution was denied by a PermissionRequest hook: ${reason}`,
      },
    };
  }
  return {
    name: toolCall.name,
    id: toolCall.id,
    result: {
      success: false,
      error: "POLICY_DENIED",
      message: `Tool execution denied by policy: ${reason}`,
    },
  };
}

/** `PermissionDenied` — a rule, the classifier, a hook or the user said no. */
export async function firePermissionDenied(
  hooks: AgentHooks | undefined,
  context: AgenticContext,
  toolCall: ToolCall,
  deniedBy: "rule" | "classifier" | "hook" | "user",
  reason: string,
): Promise<void> {
  if (!hooks) return;
  try {
    await hooks.run(
      "permissionDenied",
      toolCall,
      {
        denied_by: deniedBy,
        reason,
        tier: toolCall._approval?.tierLabel ?? null,
      },
      context,
    );
  } catch (hookError: unknown) {
    logger.warn(`[TurnHooks] PermissionDenied hooks failed: ${errorMessage(hookError)}`);
  }
}

/**
 * `PostToolBatch` — the whole batch resolved and the model has not been
 * called again yet. `additionalContext` joins the batch's hook context.
 */
export async function runPostToolBatchStage(
  context: AgenticContext,
  hooks: AgentHooks,
  state: AgenticLoopState,
  toolCalls: ToolCall[],
  results: ToolResult[],
): Promise<void> {
  if (toolCalls.length === 0) return;
  const byId = new Map(results.map((result) => [result.id, result]));
  const summary = toolCalls.map((toolCall) => {
    const outcome = byId.get(toolCall.id)?.result as Record<string, unknown> | undefined;
    const failed =
      !outcome || outcome.success === false || typeof outcome.error === "string";
    return {
      tool_use_id: toolCall.id,
      tool_name: toolCall.name,
      tool_input: toolCall.args,
      ...(failed
        ? { error: typeof outcome?.error === "string" ? outcome.error : "failed", tool_output: outcome ?? null }
        : { tool_output: outcome }),
    };
  });
  const verdict = await hooks.run(
    "postToolBatch",
    payloadFor(HOOK_EVENTS.POST_TOOL_BATCH, context, {
      iteration: state.iterations,
      tool_calls: summary,
    }),
    context,
  );
  rememberHookContext(state, verdict?.additionalContext);
}

/**
 * Inject the batch's collected hook context (PreToolUse, PostToolUse,
 * PostToolBatch) as ONE <hook-context> message. Call right after the
 * assistant message carrying the batch's results is pushed.
 */
export function flushHookContext(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
): void {
  if (!Array.isArray(state.pendingHookContext) || state.pendingHookContext.length === 0) return;
  const text = state.pendingHookContext.join("\n\n");
  state.pendingHookContext = [];
  pushHookContext(currentMessages, text);
}

// ─── Stop / StopFailure / Interrupt ───────────────────────────────────────────

/**
 * `Stop`, awaited, at the point the loop would end the turn. A `block`
 * returns the text the agent must continue with; after
 * `HOOKS.MAX_STOP_CONTINUATIONS` forced continuations in one turn the block
 * is logged and ignored. `additionalContext` without a block is kept in the
 * turn's messages, where the model sees it next turn.
 */
export async function runStopStage(
  context: AgenticContext,
  hooks: AgentHooks,
  state: AgenticLoopState,
  lastAssistantMessage: string,
  currentMessages: ConversationMessage[],
): Promise<{ continueWith: string | null }> {
  if (!hasHooks(hooks, "stop")) return { continueWith: null };
  const continuationsSoFar = state.stopHookContinuations ?? 0;
  const verdict = await hooks.run(
    "stop",
    payloadFor(HOOK_EVENTS.STOP, context, {
      last_assistant_message: lastAssistantMessage,
      response_text: lastAssistantMessage,
      stop_hook_active: continuationsSoFar > 0,
      iterations: state.iterations,
    }),
    { ...context, _currentMessages: currentMessages },
  );

  const extraContext =
    typeof verdict?.additionalContext === "string" && verdict.additionalContext
      ? verdict.additionalContext
      : "";

  if (verdict?.permissionDecision === "deny" || verdict?.isApproved === false) {
    const reason = reasonOf(verdict, "A Stop hook asked the agent to keep going.");
    if (continuationsSoFar >= HOOKS.MAX_STOP_CONTINUATIONS) {
      logger.warn(
        `[TurnHooks] Stop hook blocked again after ${continuationsSoFar} forced continuations — cap of ${HOOKS.MAX_STOP_CONTINUATIONS} reached, ending the turn. Reason given: ${reason}`,
      );
      emitStatus(context.emit, "stop_hook_cap_reached", {
        continuations: continuationsSoFar,
        reason,
      });
      return { continueWith: null };
    }
    state.stopHookContinuations = continuationsSoFar + 1;
    emitStatus(context.emit, "stop_hook_continue", {
      continuation: state.stopHookContinuations,
      reason,
    });
    return { continueWith: extraContext ? `${reason}\n\n${extraContext}` : reason };
  }

  if (extraContext) pushHookContext(currentMessages, extraContext);
  return { continueWith: null };
}

/** The message a Stop block continues the turn with. */
export function buildStopContinuationMessage(text: string): ConversationMessage {
  return {
    role: "system",
    content: wrapSystemMessage(
      SYSTEM_MESSAGE_TAGS.HOOK_CONTEXT,
      `A Stop hook did not let the turn end yet. Continue working on the task:\n${text}`,
    ),
  } as ConversationMessage;
}

/** Claude Code's `error_type` vocabulary for `StopFailure`. */
export function classifyStopFailure(error: unknown): string {
  const record = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const status =
    error instanceof ProviderError
      ? error.statusCode
      : ((record.status ?? record.statusCode) as number | undefined);
  const type = String(
    (error instanceof ProviderError ? error.errorType : null) ??
      record.type ??
      (record.error as Record<string, unknown> | undefined)?.type ??
      "",
  );
  const message = String(record.message ?? "");

  if (status === 429 || type === "rate_limit_error") return "rate_limit";
  if (status === 529 || type === "overloaded_error") return "overloaded";
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") {
    return "authentication_failed";
  }
  if (type === "billing_error" || status === 402) return "billing_error";
  if (status === 404 || type === "not_found_error") return "model_not_found";
  if (/max[_ ]?(output[_ ]?)?tokens/i.test(message)) return "max_output_tokens";
  if (status === 400 || type === "invalid_request_error") return "invalid_request";
  if ((typeof status === "number" && status >= 500) || type === "api_error") return "server_error";
  return "unknown";
}

/** `StopFailure` — the turn ended on an error instead of an answer. */
export async function fireStopFailure(
  context: AgenticContext,
  hooks: AgentHooks,
  error: unknown,
): Promise<void> {
  try {
    await hooks.run(
      "stopFailure",
      payloadFor(HOOK_EVENTS.STOP_FAILURE, context, {
        error_type: classifyStopFailure(error),
        error_message: errorMessage(error),
      }),
    );
  } catch (hookError: unknown) {
    logger.warn(`[TurnHooks] StopFailure hooks failed: ${errorMessage(hookError)}`);
  }
}

/**
 * `Interrupt` — the user pressed Stop. Fired from the stop signal itself,
 * with the transcript as it stands, under its own 1 s (max 3 s) deadline.
 * Returns the detach function.
 */
export function attachInterruptHook(
  hooks: AgentHooks,
  context: AgenticContext,
  getMessages: () => ConversationMessage[],
): () => void {
  const signal = context.signal;
  if (!signal || signal.aborted || typeof signal.addEventListener !== "function") {
    return () => {};
  }
  const onAbort = () => {
    const liveMessages = getMessages();
    hooks
      .run(
        "interrupt",
        payloadFor(HOOK_EVENTS.INTERRUPT, context, {
          transcript: summarizeTranscript(liveMessages as unknown as Array<Record<string, unknown>>),
        }),
      )
      .catch((hookError: unknown) =>
        logger.warn(`[TurnHooks] Interrupt hooks failed: ${errorMessage(hookError)}`),
      );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
