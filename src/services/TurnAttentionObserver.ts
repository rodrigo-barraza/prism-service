import ConversationAttentionRegistry from "#src/services/ConversationAttentionRegistry";
import WebhookEventBus, { NEEDS_YOU_WEBHOOK_EVENTS } from "#src/services/WebhookEventBus";
import PushNotifier, { type PushMoment } from "#src/services/push/PushNotifier";
import { getRequestContext } from "#src/utils/RequestContext";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * TurnAttentionObserver — the one tap on a running turn's events for the
 * "needs you" features. withDirectViewerBroadcast hands it every event of
 * every turn, keyed by the client-facing conversation id (the wrap happens
 * exactly once per request, so each event arrives here exactly once):
 *
 *   - ConversationAttentionRegistry — what the conversation waits on;
 *   - webhooks — approval.required, question.asked, turn.completed,
 *     turn.failed (goal.updated is ConversationGoalService's);
 *   - PushNotifier — a browser push when nobody is watching.
 *
 * Runs inside the request's AsyncLocalStorage context, which is where the
 * owner's identity comes from. Never throws into the turn.
 */

/**
 * A turn reports its end once. A second terminal event before the next
 * non-terminal one (a rejected plan emits `done` and the finalizer may
 * emit another) is the same end. Bounded: callers like lupos open a new
 * conversation per message, and each ends here.
 */
const terminalReportedConversations = new Set<string>();
const MAXIMUM_REMEMBERED_TERMINALS = 5_000;

function rememberTerminal(conversationId: string): void {
  terminalReportedConversations.add(conversationId);
  if (terminalReportedConversations.size > MAXIMUM_REMEMBERED_TERMINALS) {
    const oldest = terminalReportedConversations.values().next().value;
    if (oldest !== undefined) terminalReportedConversations.delete(oldest);
  }
}

interface TurnEvent {
  type?: unknown;
  [key: string]: unknown;
}

interface OwnerScope {
  project: string | null;
  username: string | null;
  profileId: string | null;
  agent: string | null;
}

function currentOwnerScope(): OwnerScope {
  const store = getRequestContext();
  const known = (value: string | null | undefined) =>
    value && value !== "any" ? value : null;
  return {
    project: known(store.project),
    username: known(store.username),
    profileId: store.profileId ?? null,
    agent: store.agent ?? null,
  };
}

function questionTexts(event: TurnEvent): string[] {
  if (!Array.isArray(event.questions)) return [];
  return event.questions
    .map((question) =>
      question && typeof question === "object"
        ? (question as { question?: unknown }).question
        : null,
    )
    .filter((text): text is string => typeof text === "string");
}

/** Map an event to the moment it announces (null for everything else). */
function momentOf(conversationId: string, event: TurnEvent): PushMoment | null {
  switch (event.type) {
    case SERVER_SENT_EVENT_TYPES.APPROVAL_REQUIRED: {
      const toolCall = (event.toolCall ?? {}) as Record<string, unknown>;
      return {
        kind: "approval_required",
        conversationId,
        toolCallId:
          (typeof event.toolCallId === "string" && event.toolCallId) ||
          (typeof toolCall.id === "string" ? toolCall.id : null),
        toolName: typeof toolCall.name === "string" ? toolCall.name : null,
        batchSize: typeof event.batchSize === "number" ? event.batchSize : null,
      };
    }
    case SERVER_SENT_EVENT_TYPES.USER_QUESTION:
      return {
        kind: "question_asked",
        conversationId,
        questionId: typeof event.questionId === "string" ? event.questionId : null,
        questionText: questionTexts(event)[0] ?? null,
      };
    case SERVER_SENT_EVENT_TYPES.DONE:
      return { kind: "turn_completed", conversationId };
    case SERVER_SENT_EVENT_TYPES.ERROR:
      return {
        kind: "turn_failed",
        conversationId,
        errorMessage: typeof event.message === "string" ? event.message : null,
      };
    default:
      return null;
  }
}

function emitWebhook(
  moment: PushMoment,
  event: TurnEvent,
  scope: OwnerScope,
): void {
  const common = {
    conversationId: moment.conversationId,
    project: scope.project,
    username: scope.username,
    profileId: scope.profileId,
    agent: scope.agent,
  };
  switch (moment.kind) {
    case "approval_required": {
      const toolCall = (event.toolCall ?? {}) as Record<string, unknown>;
      WebhookEventBus.emit(NEEDS_YOU_WEBHOOK_EVENTS.APPROVAL_REQUIRED, {
        ...common,
        toolCallId: moment.toolCallId,
        toolName: moment.toolName,
        args: toolCall.args ?? {},
        tier: event.tier ?? null,
        tierLabel: event.tierLabel ?? null,
        batchId: event.batchId ?? null,
      });
      return;
    }
    case "question_asked":
      WebhookEventBus.emit(NEEDS_YOU_WEBHOOK_EVENTS.QUESTION_ASKED, {
        ...common,
        questionId: moment.questionId,
        blocking: event.blocking !== false,
        questions: questionTexts(event),
        context: event.context ?? null,
      });
      return;
    case "turn_completed":
      WebhookEventBus.emit(NEEDS_YOU_WEBHOOK_EVENTS.TURN_COMPLETED, {
        ...common,
        provider: event.provider ?? null,
        model: event.model ?? null,
        estimatedCost: event.estimatedCost ?? null,
        totalTime: event.totalTime ?? null,
      });
      return;
    case "turn_failed":
      WebhookEventBus.emit(NEEDS_YOU_WEBHOOK_EVENTS.TURN_FAILED, {
        ...common,
        message: moment.errorMessage,
        code: event.code ?? null,
      });
      return;
  }
}

/** Observe one event of a running turn. Best-effort: never throws. */
export function observeTurnEvent(conversationId: string, event: TurnEvent): void {
  if (!conversationId || !event || typeof event.type !== "string") return;
  try {
    ConversationAttentionRegistry.observeEvent(conversationId, event);

    const moment = momentOf(conversationId, event);
    if (!moment) {
      terminalReportedConversations.delete(conversationId);
      return;
    }
    if (moment.kind === "turn_completed" || moment.kind === "turn_failed") {
      if (terminalReportedConversations.has(conversationId)) return;
      rememberTerminal(conversationId);
    } else {
      terminalReportedConversations.delete(conversationId);
    }

    const scope = currentOwnerScope();
    emitWebhook(moment, event, scope);
    PushNotifier.notify({ ...moment, owner: scope });
  } catch (error: unknown) {
    logger.warn(
      `[TurnAttentionObserver] ${String(event.type)} on ${conversationId}: ${errorMessage(error)}`,
    );
  }
}

/** Forget turn-end bookkeeping (tests). */
export function resetTurnAttentionObserver(): void {
  terminalReportedConversations.clear();
}
