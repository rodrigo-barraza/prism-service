import TurnInputMailbox, {
  type TurnInputEntry,
} from "#src/services/TurnInputMailbox";
import { NOTIFICATION_SOURCES, TURN_INPUT } from "#src/constants";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";
import { resolveLoopKey } from "#src/services/LoopKey";
import { externalInputMessageFields } from "#src/services/external/ExternalInput";
import { recordUntrustedInput } from "#src/services/permissions/UntrustedSpans";
import { CapabilityScopeHandle, GOAL_SCOPE_KEY } from "#src/services/permissions/CapabilityScope";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ConversationMessage,
  AgenticContext,
} from "#src/services/harnesses/types";

/**
 * TurnInputDrain — moves pending TurnInputMailbox entries into the running
 * turn's message array at a safe boundary and acknowledges each one on the
 * event stream.
 *
 * Boundaries (ReActHarness):
 *   - `iteration_start`  before the model call of every iteration
 *   - `after_tools`      after a tool batch has been observed
 *   - `before_end`       the model answered with text only; instead of ending
 *                        the turn, the pending input is applied and the loop
 *                        continues so the model can act on it
 *   - `turn_end`         the turn is ending anyway (sealTurnInput): what was
 *                        already accepted joins the transcript so it is
 *                        persisted with the turn instead of dropped
 *
 * Every injected message is a `user`-role message. A steering update is
 * wrapped in <user-update> so the model can tell it arrived mid-task (and so
 * a provider that demotes system messages still sees the marker); answers to
 * non-blocking questions are wrapped in <user-answer>; task completions and
 * sub-agent follow-ups arrive already formatted by their producer and are
 * pushed verbatim. The marker `_turnInput` on the message lets the client
 * render the bubble as "applied mid-turn" and strip the wrapper.
 *
 * `hook_context` (an async hook's output) is the exception: nobody typed it,
 * so it is injected as a system-role <hook-context> message with no
 * `_turnInput` marker (it must never render as a user bubble), and it is
 * acknowledged with a `hook_context_applied` status instead of `turn_input`.
 *
 * `external` (a webhook, a Discord message relayed into someone else's turn,
 * an MCP server, a sub-agent's message) is user-role on the wire — no provider takes free
 * text in another role but `system`, which would raise its authority — but
 * never the user's: its content is the <external-input> envelope that names
 * the source and gives it tool-level authority, the message carries its
 * origin (`_external`, and on the `_turnInput` marker for viewers), and its
 * text joins the turn's untrusted spans (permissions/UntrustedSpans).
 */

/** Status acknowledging an async hook's context reached the model. */
export const HOOK_CONTEXT_APPLIED_STATUS = "hook_context_applied";

export type TurnInputBoundary =
  | "iteration_start"
  | "after_tools"
  | "before_end"
  | "turn_end"
  // Applied by the provider mid-stream (OpenAI `response.steer`).
  | "native_steer";

export function buildTurnInputMessage(entry: TurnInputEntry): ConversationMessage {
  if (entry.kind === "hook_context") {
    return {
      role: "system",
      content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.HOOK_CONTEXT, entry.text),
      ...(entry.meta || {}),
      // Not a bubble (no `_turnInput`), but still recognisable as delivered
      // when a restart asks which entries reached the turn (TurnInputStore).
      _turnInputId: entry.id,
    } as ConversationMessage;
  }
  if (entry.kind === "external" && entry.origin) {
    return {
      role: "user",
      ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
      ...(entry.meta || {}),
      // The model reads the producer's text in the envelope; viewers get the
      // sender's own words (`meta.rawContent`, else the same text).
      ...externalInputMessageFields(entry.origin, entry.text, displayTextOf(entry)),
      [TURN_INPUT.MESSAGE_KEY]: {
        id: entry.id,
        kind: entry.kind,
        receivedAt: entry.receivedAt,
        ...entry.origin,
      },
    } as ConversationMessage;
  }
  const base: ConversationMessage = {
    role: "user",
    content: "",
    ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
    [TURN_INPUT.MESSAGE_KEY]: { id: entry.id, kind: entry.kind, receivedAt: entry.receivedAt },
    rawContent: entry.text,
    ...(entry.meta || {}),
  };
  switch (entry.kind) {
    case "user_update":
      return {
        ...base,
        content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.USER_UPDATE, entry.text),
        _notificationSource: NOTIFICATION_SOURCES.USER_UPDATE,
        _notificationId: `${NOTIFICATION_SOURCES.USER_UPDATE}:${entry.id}:${entry.receivedAt}`,
      };
    case "question_answer":
      return {
        ...base,
        content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.USER_ANSWER, entry.text),
        _notificationSource: NOTIFICATION_SOURCES.USER_ANSWER,
        _notificationId: `${NOTIFICATION_SOURCES.USER_ANSWER}:${entry.id}:${entry.receivedAt}`,
      };
    case "goal_revision":
      // The verifier speaking, not the user: marked so memory extraction
      // and the client never take it for the user's words.
      return {
        ...base,
        content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.GOAL_VERIFICATION, entry.text),
        _notificationSource: NOTIFICATION_SOURCES.GOAL_VERIFIER,
        _notificationId: `${NOTIFICATION_SOURCES.GOAL_VERIFIER}:${entry.id}:${entry.receivedAt}`,
      };
    case "task_completion":
    case "agent_message":
    default:
      // Producers format these (AgentNotificationService for completions,
      // the orchestrator for follow-ups) and set their own source markers
      // through `meta`; keep the text verbatim.
      return { ...base, content: entry.text };
  }
}

/**
 * What a viewer is shown for an entry: the producer's display text when it
 * set one (`meta.rawContent` — a sub-agent's own words without the
 * model-facing wrapper, which is also what the persisted message keeps),
 * else the entry's text.
 */
function displayTextOf(entry: TurnInputEntry): string {
  const rawContent = entry.meta?.rawContent;
  return typeof rawContent === "string" ? rawContent : entry.text;
}

/**
 * Drain the mailbox for this turn into `currentMessages`. Returns the number
 * of entries applied (0 when nothing was pending — the common case, and it
 * costs one Map lookup).
 */
export function drainTurnInput(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  context: AgenticContext,
  boundary: TurnInputBoundary,
): number {
  // The key AgenticLoopService opened this turn's mailbox under.
  const conversationId = resolveLoopKey(context);
  if (!conversationId) return 0;
  const entries = TurnInputMailbox.drain(conversationId);
  if (entries.length === 0) return 0;

  for (const entry of entries) {
    const message = buildTurnInputMessage(entry);
    currentMessages.push(message);
    // The user is back at the wheel: the goal's autonomous-work narrowing
    // no longer applies (lifecycle/GoalGate pauses the goal at the next end).
    if (entry.kind === "user_update" || entry.kind === "question_answer") {
      const scope = context.options?._capabilityScope;
      if (scope instanceof CapabilityScopeHandle) scope.release(GOAL_SCOPE_KEY);
    }
    // What the turn now holds from outside it — a check on later tool
    // arguments compares against it (permissions/UntrustedSpans).
    recordUntrustedInput(context, message);
    acknowledgeTurnInput(entry, state, context, boundary);
  }
  logger.info(
    `[TurnInputDrain] Applied ${entries.length} entr${entries.length === 1 ? "y" : "ies"} at ${boundary} (iteration ${state.iterations}) for ${conversationId}`,
  );
  return entries.length;
}

/** The events a drained (or natively applied) entry is acknowledged with. */
function acknowledgeTurnInput(
  entry: TurnInputEntry,
  state: AgenticLoopState,
  context: AgenticContext,
  boundary: TurnInputBoundary,
): void {
  if (entry.kind === "hook_context") {
    context.emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: HOOK_CONTEXT_APPLIED_STATUS,
      inputId: entry.id,
      boundary,
      iteration: state.iterations,
      ...(entry.meta || {}),
    });
    return;
  }
  state.turnInputApplied++;
  // The event carries the entry so viewers (and the driving client, which
  // rendered an optimistic bubble by id) can show it in the transcript.
  context.emit({
    type: TURN_INPUT.EVENT_TYPE,
    id: entry.id,
    kind: entry.kind,
    content: displayTextOf(entry),
    ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
    // An external input names its source, so a viewer never shows it as the user.
    ...(entry.kind === "external" && entry.origin ? entry.origin : {}),
    boundary,
    iteration: state.iterations,
  });
  context.emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: TURN_INPUT.STATUS_APPLIED,
    inputId: entry.id,
    kind: entry.kind,
    boundary,
    iteration: state.iterations,
  });
}

/**
 * Inputs the provider applied natively mid-stream (OpenAI `response.steer`
 * — the continuation now streaming carries them): take them out of the
 * mailbox, acknowledge them like a drain (`turn_input` + applied status,
 * boundary `native_steer`), and return their transcript messages. The model
 * already has them; recordNativeTurnInput puts them in the transcript and
 * nothing injects them again.
 */
export function takeNativeTurnInput(
  inputIds: string[],
  state: AgenticLoopState,
  context: AgenticContext,
): ConversationMessage[] {
  const loopKey = resolveLoopKey(context);
  if (!loopKey || inputIds.length === 0) return [];
  const entries = TurnInputMailbox.take(loopKey, inputIds);
  for (const entry of entries) acknowledgeTurnInput(entry, state, context, "native_steer");
  if (entries.length > 0) {
    logger.info(
      `[TurnInputDrain] ${entries.length} input(s) applied natively (iteration ${state.iterations}) for ${loopKey}`,
    );
  }
  return entries.map((entry) => ({
    ...buildTurnInputMessage(entry),
    _nativeSteer: true,
  }));
}

/**
 * Record a pass's natively applied inputs in the transcript — BEFORE the
 * assistant message the pass will produce, since that output already acted
 * on them. Called right after the stream is consumed.
 */
export function recordNativeTurnInput(
  currentMessages: ConversationMessage[],
  pass: { nativeTurnInput?: ConversationMessage[] },
): void {
  if (!pass.nativeTurnInput?.length) return;
  currentMessages.push(...pass.nativeTurnInput);
  pass.nativeTurnInput = undefined;
}

/**
 * The turn has decided to end. Seal its mailbox — every later post is
 * refused as `no_active_turn`, so its producer takes the after-the-turn
 * path (a completion wakes a new turn, the client queues an update) — and
 * move anything already accepted into the transcript, where finalize
 * persists it. Returns how many entries were moved.
 */
export function sealTurnInput(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  context: AgenticContext,
): number {
  const loopKey = resolveLoopKey(context);
  if (!loopKey) return 0;
  TurnInputMailbox.seal(loopKey);
  return drainTurnInput(currentMessages, state, context, "turn_end");
}

/** True when input is waiting — used at the text-only break to keep the loop alive. */
export function hasPendingTurnInput(context: AgenticContext): boolean {
  const loopKey = resolveLoopKey(context);
  return !!loopKey && TurnInputMailbox.pendingCount(loopKey) > 0;
}
