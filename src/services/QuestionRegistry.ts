/**
 * QuestionRegistry — the open `ask_user` questions of every turn.
 *
 * Filed under the LOOP KEY (LoopKey.resolveLoopKey): the id the client holds
 * for a root turn, the sub-agent's own conversation id for a sub-agent —
 * the id `/agent/answer` is called with, and the key the TurnInputMailbox is
 * opened under. Several questions can be open per loop (non-blocking cards
 * stay open while the loop keeps working), each by its `questionId`.
 *
 * Durable (prompt 13): each question is a record in PendingDecisionStore,
 * written before its card goes out, and an answer is a conditional write on
 * it — so an answer survives a restart (stored; the turn picks it up when it
 * is re-driven) and is taken exactly once: a second answer to the same card
 * reads `already_answered` (409), never a 404 the client would re-send as a
 * message. What lives here is only the WAITER of a question whose turn is
 * running in this process: the resolver that wakes a blocking wait, or
 * posts a non-blocking answer into the turn's mailbox.
 *
 * No timeout: a blocking question waits until it is answered or its turn
 * ends (stopped or finished).
 */
import type {
  PendingQuestionEntry,
  QuestionAnswer,
  QuestionDefinition,
} from "./ApprovalRegistry.ts";
import PendingDecisionStore, {
  pendingDecisionId,
  type DecisionOwner,
  type PendingDecisionRecord,
} from "#src/services/PendingDecisionStore";
import ConversationRunState, { locatorFor } from "#src/services/conversation/ConversationRunState";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** What an answer did — see QuestionRegistry.answer. */
export type QuestionAnswerOutcome =
  | {
      resolved: true;
      questionId: string;
      blocking: boolean;
      loopKey: string;
      /** How the id found the loop; `agent_conversation_id` is the legacy key. */
      matchedBy: "loop_key" | "agent_conversation_id";
      /**
       * A turn running in this process took the answer. False after a
       * restart: the answer is stored for the re-driven turn.
       */
      delivered: boolean;
    }
  | {
      resolved: false;
      reason: "no_pending_question" | "unknown_question" | "no_active_turn" | "already_answered";
      questionId?: string;
    };

/** One open question as listed for a loop (no resolver). */
export interface PendingQuestionSummary {
  questionId: string;
  blocking: boolean;
  createdAt: number;
  question?: string;
  questions?: QuestionDefinition[];
  choices?: string[];
}

interface QuestionWaiter {
  loopKey: string;
  blocking: boolean;
  owner: DecisionOwner;
  resolve: PendingQuestionEntry["resolve"];
}

const QUESTION_KINDS = ["question"] as const;

/** questionId → the waiter of a question whose turn runs in this process. */
const waiters = new Map<string, QuestionWaiter>();

function summarize(record: PendingDecisionRecord): PendingQuestionSummary {
  return {
    questionId: record.itemId,
    blocking: record.blocking !== false,
    createdAt: Date.parse(record.createdAt),
    ...(record.question !== undefined ? { question: record.question } : {}),
    ...(record.questions !== undefined
      ? { questions: record.questions as QuestionDefinition[] }
      : {}),
    ...(record.choices !== undefined ? { choices: record.choices } : {}),
  };
}

/** The oldest blocking question, else the oldest one (a lone non-blocking card). */
function pickDefault(pending: PendingDecisionRecord[]): PendingDecisionRecord | undefined {
  return pending.find((record) => record.blocking !== false) ?? pending[0];
}

/** Drop a waiter; a blocking one un-parks its conversation. */
function release(questionId: string): QuestionWaiter | undefined {
  const waiter = waiters.get(questionId);
  if (!waiter) return undefined;
  waiters.delete(questionId);
  if (waiter.blocking) void ConversationRunState.unpark(locatorFor(waiter.loopKey, waiter.owner));
  return waiter;
}

/**
 * The loop an answer's id addresses: the id itself as a loop key, else —
 * for one release — the loop whose agentConversationId it is (the key
 * questions used to be filed under). With its pending questions, oldest first.
 */
async function findLoop(id: string): Promise<{
  loopKey: string;
  matchedBy: "loop_key" | "agent_conversation_id";
  pending: PendingDecisionRecord[];
} | null> {
  const byLoopKey = await PendingDecisionStore.find({
    loopKey: id,
    kinds: QUESTION_KINDS,
    status: "pending",
  });
  if (byLoopKey.length > 0) return { loopKey: id, matchedBy: "loop_key", pending: byLoopKey };
  const byAgentId = await PendingDecisionStore.find({
    agentConversationId: id,
    kinds: QUESTION_KINDS,
    status: "pending",
  });
  if (byAgentId.length === 0) return null;
  const loopKey = byAgentId[0].loopKey;
  return {
    loopKey,
    matchedBy: "agent_conversation_id",
    pending: byAgentId.filter((record) => record.loopKey === loopKey),
  };
}

/** Why a named question can no longer take an answer. */
async function settledReason(
  ids: string[],
  questionId: string,
): Promise<"already_answered" | "no_active_turn" | "unknown_question"> {
  const records = await PendingDecisionStore.find({ itemId: questionId, kinds: QUESTION_KINDS });
  const record = records.find(
    (candidate) => ids.includes(candidate.loopKey) || ids.includes(candidate.agentConversationId ?? ""),
  );
  if (!record) return "unknown_question";
  return record.status === "answered" ? "already_answered" : "no_active_turn";
}

const QuestionRegistry = {
  /**
   * Record a question as pending and hold its resolver. Call BEFORE the card
   * goes out — an answer can only land on a question that exists. A
   * blocking question parks its conversation until it is answered.
   */
  async register(
    loopKey: string,
    entry: PendingQuestionEntry,
    owner: DecisionOwner = {},
  ): Promise<void> {
    const agentConversationId = entry.agentConversationId ?? owner.agentConversationId ?? null;
    await PendingDecisionStore.insert([
      {
        ...owner,
        agentConversationId,
        id: pendingDecisionId(loopKey, null, entry.questionId),
        loopKey,
        kind: "question",
        itemId: entry.questionId,
        batchId: null,
        position: 0,
        status: "pending",
        createdAt: new Date(entry.createdAt).toISOString(),
        blocking: entry.blocking,
        ...(entry.question !== undefined ? { question: entry.question } : {}),
        ...(entry.questions !== undefined ? { questions: entry.questions } : {}),
        ...(entry.choices !== undefined ? { choices: entry.choices } : {}),
      },
    ]);
    waiters.set(entry.questionId, {
      loopKey,
      blocking: entry.blocking,
      owner,
      resolve: entry.resolve,
    });
    if (entry.blocking) await ConversationRunState.park(locatorFor(loopKey, owner));
  },

  /** Withdraw one question unanswered (its turn was stopped). */
  async remove(loopKey: string, questionId: string): Promise<void> {
    release(questionId);
    try {
      await PendingDecisionStore.settle(pendingDecisionId(loopKey, null, questionId), {
        status: "cancelled",
      });
    } catch (error: unknown) {
      logger.warn(
        `[QuestionRegistry] Could not withdraw ${questionId} on ${loopKey}: ${getErrorMessage(error)}`,
      );
    }
  },

  /**
   * Answer a pending question. `id` is the loop key (a root turn's
   * conversation id, or a sub-agent's own); `agentConversationId` is also
   * tried, as the legacy key. With `questionId`, exactly that question;
   * without, the oldest blocking one (else the oldest open card).
   */
  async answer(
    id: string,
    answers: QuestionAnswer[],
    { questionId, agentConversationId }: { questionId?: string; agentConversationId?: string } = {},
  ): Promise<QuestionAnswerOutcome> {
    const ids = [id, agentConversationId].filter((value): value is string => !!value);
    let loop: Awaited<ReturnType<typeof findLoop>> = null;
    for (const candidate of ids) {
      loop = await findLoop(candidate);
      if (loop) break;
    }
    if (!loop) {
      return questionId
        ? { resolved: false, reason: await settledReason(ids, questionId), questionId }
        : { resolved: false, reason: "no_pending_question" };
    }
    if (loop.matchedBy === "agent_conversation_id") {
      logger.warn(
        `[QuestionRegistry] Answer addressed by legacy agentConversationId resolved to loop ${loop.loopKey} — send the conversationId`,
      );
    }

    const record = questionId
      ? loop.pending.find((candidate) => candidate.itemId === questionId)
      : pickDefault(loop.pending);
    if (!record) {
      return { resolved: false, reason: await settledReason(ids, questionId!), questionId };
    }

    const won = await PendingDecisionStore.settle(record.id, { status: "answered", answers });
    if (!won) return { resolved: false, reason: "already_answered", questionId: record.itemId };

    const blocking = record.blocking !== false;
    const waiter = release(record.itemId);
    if (waiter) {
      const delivery = waiter.resolve({ answers });
      if (delivery && !delivery.delivered) {
        // A non-blocking card whose turn closed: nobody took the answer, so
        // it was not given — the client sends it as a message instead.
        await PendingDecisionStore.markUndelivered(record.id);
        return { resolved: false, reason: "no_active_turn", questionId: record.itemId };
      }
    } else if (!(await PendingDecisionStore.isParked(loop.loopKey))) {
      await ConversationRunState.clear(locatorFor(loop.loopKey, record));
    }
    return {
      resolved: true,
      questionId: record.itemId,
      blocking,
      loopKey: loop.loopKey,
      matchedBy: loop.matchedBy,
      delivered: !!waiter,
    };
  },

  /** Every open question on a loop, oldest first. */
  async list(loopKey: string): Promise<PendingQuestionSummary[]> {
    const pending = await PendingDecisionStore.find({
      loopKey,
      kinds: QUESTION_KINDS,
      status: "pending",
    });
    return pending.map(summarize);
  },

  /** The question a reloaded client shows: the oldest blocking one, else the oldest open card. */
  async getPending(loopKey: string): Promise<PendingQuestionSummary | null> {
    const pending = await PendingDecisionStore.find({
      loopKey,
      kinds: QUESTION_KINDS,
      status: "pending",
    });
    const record = pickDefault(pending);
    return record ? summarize(record) : null;
  },

  /**
   * The turn is over: its open cards can no longer be answered into it.
   * A blocking wait still open (the turn was stopped) is released unanswered.
   */
  async cancelAll(loopKey: string): Promise<PendingDecisionRecord[]> {
    for (const [questionId, waiter] of [...waiters]) {
      if (waiter.loopKey !== loopKey) continue;
      release(questionId);
      if (waiter.blocking) waiter.resolve({ answers: null, isCancelled: true });
    }
    try {
      return await PendingDecisionStore.settleAll(
        { loopKey, kinds: QUESTION_KINDS },
        () => ({ status: "cancelled" }),
      );
    } catch (error: unknown) {
      logger.warn(
        `[QuestionRegistry] Could not close the questions of ${loopKey}: ${getErrorMessage(error)}`,
      );
      return [];
    }
  },

  /**
   * A new turn starts on this loop: questions still pending from a turn that
   * is not running here (it died with a previous process) will never be
   * answered into this one — close them. Returns the records it settled.
   */
  async retireOrphans(loopKey: string): Promise<PendingDecisionRecord[]> {
    const pending = await PendingDecisionStore.find({
      loopKey,
      kinds: QUESTION_KINDS,
      status: "pending",
    });
    const retired: PendingDecisionRecord[] = [];
    for (const record of pending) {
      if (waiters.has(record.itemId)) continue;
      if (await PendingDecisionStore.settle(record.id, { status: "cancelled" })) retired.push(record);
    }
    return retired;
  },

  /** Test helper — forget every waiter (the store keeps its records). */
  _clearAll(): void {
    waiters.clear();
  },
};

export default QuestionRegistry;
