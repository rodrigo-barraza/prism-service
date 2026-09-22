import ChangeStreamService from "#src/services/ChangeStreamService";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { TURN_INPUT } from "#src/constants";

/**
 * ConversationAttentionRegistry — what each conversation is waiting on from
 * its user: tool calls awaiting approval and questions awaiting an answer.
 *
 * Keyed by the CLIENT-FACING conversation id, because that is what the
 * conversation list, the sidebar and the notifications speak. It is fed
 * ONLY from the turn's own event stream (`observeEvent`, called for every
 * event a turn emits — see withDirectViewerBroadcast): a wait opens on
 * `approval_required` / `plan_proposal` / `user_question` and closes on
 * whichever event proves it is over — `approval_decided`, the call's first
 * `tool_output` or its `tool_execution` result, the `turn_input` carrying
 * an answer, or the end of the turn. It deliberately does not read the
 * ApprovalRegistry maps: those are keyed per loop, and pending questions by
 * agentConversationId, neither of which the list endpoint can address.
 *
 * In memory, like the waits it mirrors: a restart ends every waiting turn,
 * so an empty registry after boot is the truth.
 *
 * Every change is published on the change stream as a synthetic
 * `conversation_attention` event carrying the new counts, so a sidebar
 * updates without refetching the list.
 */

/** `collection` value of the synthetic change-stream event. */
export const ATTENTION_CHANGE_COLLECTION = "conversation_attention";

/** Pending-approval key for a plan proposal (it has no tool-call id). */
const PLAN_APPROVAL_KEY = "plan";

/** SSE event: one pending call was decided (per-call approvals). */
const APPROVAL_DECIDED_EVENT_TYPE = "approval_decided";

/** Abandoned entries (a turn that died without a terminal event) expire. */
const ENTRY_TTL_MILLISECONDS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MILLISECONDS = 10 * 60 * 1000;

export interface ConversationAttention {
  pendingApprovalCount: number;
  pendingQuestionCount: number;
  /** ISO time the oldest pending item started waiting; null when nothing waits. */
  awaitingSince: string | null;
}

interface PendingApproval {
  since: number;
  toolName: string | null;
}

interface PendingQuestion {
  since: number;
  blocking: boolean;
}

interface AttentionEntry {
  approvals: Map<string, PendingApproval>;
  questions: Map<string, PendingQuestion>;
  touchedAt: number;
}

interface ObservedEvent {
  type?: unknown;
  [key: string]: unknown;
}

const EMPTY_ATTENTION: ConversationAttention = Object.freeze({
  pendingApprovalCount: 0,
  pendingQuestionCount: 0,
  awaitingSince: null,
});

const entriesByConversation = new Map<string, AttentionEntry>();
/** Last attention published per conversation — change detection. */
const publishedByConversation = new Map<string, string>();
let approvalKeySequence = 0;

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [conversationId, entry] of entriesByConversation) {
    if (now - entry.touchedAt > ENTRY_TTL_MILLISECONDS) {
      ConversationAttentionRegistry.clear(conversationId);
    }
  }
}, SWEEP_INTERVAL_MILLISECONDS);
sweepTimer.unref?.();

function entryFor(conversationId: string): AttentionEntry {
  let entry = entriesByConversation.get(conversationId);
  if (!entry) {
    entry = { approvals: new Map(), questions: new Map(), touchedAt: 0 };
    entriesByConversation.set(conversationId, entry);
  }
  entry.touchedAt = Date.now();
  return entry;
}

function computeAttention(
  entry: AttentionEntry | undefined,
): ConversationAttention {
  if (!entry || (entry.approvals.size === 0 && entry.questions.size === 0)) {
    return EMPTY_ATTENTION;
  }
  let oldest = Infinity;
  for (const approval of entry.approvals.values()) {
    oldest = Math.min(oldest, approval.since);
  }
  for (const question of entry.questions.values()) {
    oldest = Math.min(oldest, question.since);
  }
  return {
    pendingApprovalCount: entry.approvals.size,
    pendingQuestionCount: entry.questions.size,
    awaitingSince: new Date(oldest).toISOString(),
  };
}

/** Publish the conversation's attention when it differs from the last publish. */
function publishIfChanged(conversationId: string): void {
  const entry = entriesByConversation.get(conversationId);
  const attention = computeAttention(entry);
  const isEmpty =
    attention.pendingApprovalCount === 0 &&
    attention.pendingQuestionCount === 0;
  if (isEmpty) entriesByConversation.delete(conversationId);

  const fingerprint = JSON.stringify(attention);
  const previous = publishedByConversation.get(conversationId);
  // Nothing was ever published and nothing waits: no news.
  if (previous === undefined && isEmpty) return;
  if (previous === fingerprint) return;

  if (isEmpty) publishedByConversation.delete(conversationId);
  else publishedByConversation.set(conversationId, fingerprint);

  ChangeStreamService.publish({
    collection: ATTENTION_CHANGE_COLLECTION,
    operationType: "update",
    documentId: null,
    id: conversationId,
    updatedFields: ["pendingApprovalCount", "pendingQuestionCount", "awaitingSince"],
    timestamp: new Date().toISOString(),
    attention,
  });
}

function approvalKeyFor(toolCall: Record<string, unknown> | undefined): string {
  const id = toolCall?.id;
  if (typeof id === "string" && id) return id;
  approvalKeySequence += 1;
  return `unidentified-${approvalKeySequence}`;
}

/**
 * Drop the pending approval a finished tool call answers: by id, or — for
 * providers that emit calls without ids — the oldest one of the same name.
 */
function resolveApprovalForExecutedCall(
  entry: AttentionEntry,
  tool: Record<string, unknown>,
): boolean {
  const id = typeof tool.id === "string" ? tool.id : null;
  if (id && entry.approvals.delete(id)) return true;
  if (id) return false;
  const toolName = typeof tool.name === "string" ? tool.name : null;
  for (const [key, approval] of entry.approvals) {
    if (approval.toolName === toolName && key.startsWith("unidentified-")) {
      entry.approvals.delete(key);
      return true;
    }
  }
  return false;
}

/** The oldest pending question of one kind (blocking or not). */
function oldestQuestionId(entry: AttentionEntry, blocking: boolean): string | null {
  let oldestId: string | null = null;
  let oldestSince = Infinity;
  for (const [questionId, question] of entry.questions) {
    if (question.blocking === blocking && question.since < oldestSince) {
      oldestSince = question.since;
      oldestId = questionId;
    }
  }
  return oldestId;
}

/**
 * The question a delivered answer settles: the id the event names, else a
 * pending id the answer text quotes (the <user-answer> message names its
 * card), else the oldest non-blocking question — the only kind answered
 * through the mailbox.
 */
function answeredQuestionId(entry: AttentionEntry, event: ObservedEvent): string | null {
  if (typeof event.questionId === "string" && entry.questions.has(event.questionId)) {
    return event.questionId;
  }
  const content = typeof event.content === "string" ? event.content : "";
  for (const questionId of entry.questions.keys()) {
    if (content.includes(questionId)) return questionId;
  }
  return oldestQuestionId(entry, false);
}

const ConversationAttentionRegistry = {
  /** The conversation's current attention (zeros when nothing waits). */
  get(conversationId: string | null | undefined): ConversationAttention {
    if (!conversationId) return EMPTY_ATTENTION;
    return computeAttention(entriesByConversation.get(conversationId));
  },

  /**
   * Stamp `pendingApprovalCount` / `pendingQuestionCount` / `awaitingSince`
   * onto a conversation record about to be served (keyed by its `id`).
   */
  attach(record: Record<string, unknown>): void {
    Object.assign(
      record,
      ConversationAttentionRegistry.get(record.id as string | undefined),
    );
  },

  /**
   * Account one event of a running turn. Only the events that open or
   * close a wait matter; everything else is ignored.
   */
  observeEvent(conversationId: string, event: ObservedEvent): void {
    if (!conversationId || !event || typeof event.type !== "string") return;
    switch (event.type) {
      case SERVER_SENT_EVENT_TYPES.APPROVAL_REQUIRED: {
        const toolCall = event.toolCall as Record<string, unknown> | undefined;
        const key =
          typeof event.toolCallId === "string" && event.toolCallId
            ? event.toolCallId
            : approvalKeyFor(toolCall);
        entryFor(conversationId).approvals.set(key, {
          since: Date.now(),
          toolName: typeof toolCall?.name === "string" ? toolCall.name : null,
        });
        break;
      }
      case SERVER_SENT_EVENT_TYPES.PLAN_PROPOSAL: {
        if (event.autoApproved) return;
        entryFor(conversationId).approvals.set(PLAN_APPROVAL_KEY, {
          since: Date.now(),
          toolName: null,
        });
        break;
      }
      case APPROVAL_DECIDED_EVENT_TYPE: {
        const entry = entriesByConversation.get(conversationId);
        if (!entry) return;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        // A decided id we never saw can only be the plan (it has no call id).
        if (!entry.approvals.delete(toolCallId) && !entry.approvals.delete(PLAN_APPROVAL_KEY)) {
          return;
        }
        break;
      }
      case SERVER_SENT_EVENT_TYPES.STATUS: {
        if (event.message !== STATUS_MESSAGES.PLAN_MODE_EXITED) return;
        if (!entriesByConversation.get(conversationId)?.approvals.delete(PLAN_APPROVAL_KEY)) return;
        break;
      }
      case SERVER_SENT_EVENT_TYPES.TOOL_OUTPUT: {
        // An approved call is running: it no longer waits on anyone.
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!toolCallId) return;
        if (!entriesByConversation.get(conversationId)?.approvals.delete(toolCallId)) return;
        break;
      }
      case SERVER_SENT_EVENT_TYPES.USER_QUESTION: {
        const questionId =
          typeof event.questionId === "string" && event.questionId
            ? event.questionId
            : `question-${Date.now()}`;
        entryFor(conversationId).questions.set(questionId, {
          since: Date.now(),
          blocking: event.blocking !== false,
        });
        break;
      }
      case TURN_INPUT.EVENT_TYPE: {
        // A non-blocking card's answer reaches the turn through the mailbox.
        if (event.kind !== "question_answer") return;
        const entry = entriesByConversation.get(conversationId);
        if (!entry) return;
        const questionId = answeredQuestionId(entry, event);
        if (!questionId || !entry.questions.delete(questionId)) return;
        break;
      }
      case SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION: {
        if (event.status !== "done" && event.status !== "error") return;
        const entry = entriesByConversation.get(conversationId);
        const tool = event.tool as Record<string, unknown> | undefined;
        if (!entry || !tool) return;
        let changed = resolveApprovalForExecutedCall(entry, tool);
        if (tool.name === TOOL_NAMES.ASK_USER) {
          // A blocking ask_user returns once answered (with its questionId)
          // or timed out (without). A non-blocking one returns at once with
          // status "pending" — its card is still waiting.
          const result = (tool.result ?? {}) as Record<string, unknown>;
          if (result.status !== "pending") {
            const questionId =
              typeof result.questionId === "string"
                ? result.questionId
                : oldestQuestionId(entry, true);
            if (questionId && entry.questions.delete(questionId)) {
              changed = true;
            }
          }
        }
        if (!changed) return;
        break;
      }
      case SERVER_SENT_EVENT_TYPES.DONE:
      case SERVER_SENT_EVENT_TYPES.ERROR: {
        // The turn is over: nothing it was waiting on can still be answered.
        ConversationAttentionRegistry.clear(conversationId);
        return;
      }
      default:
        return;
    }
    publishIfChanged(conversationId);
  },

  /** Forget everything the conversation was waiting on. */
  clear(conversationId: string): void {
    const entry = entriesByConversation.get(conversationId);
    if (entry) {
      entry.approvals.clear();
      entry.questions.clear();
    }
    publishIfChanged(conversationId);
  },

  /** Conversations with anything waiting (diagnostics, tests). */
  get size(): number {
    return entriesByConversation.size;
  },

  /** Drop all state without publishing (tests / shutdown). */
  reset(): void {
    entriesByConversation.clear();
    publishedByConversation.clear();
  },
};

export default ConversationAttentionRegistry;
