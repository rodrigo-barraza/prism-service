/**
 * QuestionRegistry — the open `ask_user` questions of every running turn.
 *
 * Filed under the LOOP KEY (LoopKey.resolveLoopKey): the id the client holds
 * for a root turn, the sub-agent's own conversation id for a sub-agent —
 * the id `/agent/answer` is called with, and the key the TurnInputMailbox is
 * opened under. Several questions can be open per loop (non-blocking cards
 * stay open while the loop keeps working), each by its `questionId`.
 *
 * The map itself is ApprovalRegistry.pendingQuestions, so the loop's
 * end-of-turn cleanup (`pendingQuestions.delete(<loop key>)`) drops them all.
 */
import {
  pendingQuestions,
  type PendingQuestionEntry,
  type QuestionAnswer,
  type QuestionDefinition,
} from "./ApprovalRegistry.ts";
import logger from "#src/utils/logger";

/** What an answer did — see QuestionRegistry.answer. */
export type QuestionAnswerOutcome =
  | {
      resolved: true;
      questionId: string;
      blocking: boolean;
      loopKey: string;
      /** How the id found the loop; `agent_conversation_id` is the legacy key. */
      matchedBy: "loop_key" | "agent_conversation_id";
    }
  | {
      resolved: false;
      reason: "no_pending_question" | "unknown_question" | "no_active_turn";
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

function summarize(entry: PendingQuestionEntry): PendingQuestionSummary {
  return {
    questionId: entry.questionId,
    blocking: entry.blocking,
    createdAt: entry.createdAt,
    question: entry.question,
    questions: entry.questions,
    choices: entry.choices,
  };
}

/** The oldest blocking question, else the oldest one (a lone non-blocking card). */
function pickDefault(
  questions: Map<string, PendingQuestionEntry>,
): PendingQuestionEntry | undefined {
  let oldestBlocking: PendingQuestionEntry | undefined;
  let oldest: PendingQuestionEntry | undefined;
  for (const entry of questions.values()) {
    if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    if (entry.blocking && (!oldestBlocking || entry.createdAt < oldestBlocking.createdAt)) {
      oldestBlocking = entry;
    }
  }
  return oldestBlocking ?? oldest;
}

/**
 * The loop an answer's id addresses: the id itself as a loop key, else —
 * for one release — the loop whose agentConversationId it is (the key
 * questions used to be filed under).
 */
function findLoop(
  id: string,
): { loopKey: string; matchedBy: "loop_key" | "agent_conversation_id" } | null {
  if (pendingQuestions.has(id)) return { loopKey: id, matchedBy: "loop_key" };
  for (const [loopKey, questions] of pendingQuestions) {
    for (const entry of questions.values()) {
      if (entry.agentConversationId === id) {
        return { loopKey, matchedBy: "agent_conversation_id" };
      }
    }
  }
  return null;
}

const QuestionRegistry = {
  /** File a pending question under its loop. */
  register(loopKey: string, entry: PendingQuestionEntry): void {
    let questions = pendingQuestions.get(loopKey);
    if (!questions) {
      questions = new Map();
      pendingQuestions.set(loopKey, questions);
    }
    questions.set(entry.questionId, entry);
  },

  /** Drop one question without answering it (its blocking wait timed out). */
  remove(loopKey: string, questionId: string): void {
    const questions = pendingQuestions.get(loopKey);
    if (!questions) return;
    questions.delete(questionId);
    if (questions.size === 0) pendingQuestions.delete(loopKey);
  },

  /**
   * Answer a pending question. `id` is the loop key (a root turn's
   * conversation id, or a sub-agent's own); `agentConversationId` is also
   * tried, as the legacy key. With `questionId`, exactly that question;
   * without, the oldest blocking one (else the oldest open card).
   */
  answer(
    id: string,
    answers: QuestionAnswer[],
    { questionId, agentConversationId }: { questionId?: string; agentConversationId?: string } = {},
  ): QuestionAnswerOutcome {
    const loop =
      (id && findLoop(id)) || (agentConversationId && findLoop(agentConversationId)) || null;
    if (!loop) {
      return questionId
        ? { resolved: false, reason: "unknown_question", questionId }
        : { resolved: false, reason: "no_pending_question" };
    }
    if (loop.matchedBy === "agent_conversation_id") {
      logger.warn(
        `[QuestionRegistry] Answer addressed by legacy agentConversationId resolved to loop ${loop.loopKey} — send the conversationId`,
      );
    }
    const questions = pendingQuestions.get(loop.loopKey)!;
    const entry = questionId ? questions.get(questionId) : pickDefault(questions);
    if (!entry) return { resolved: false, reason: "unknown_question", questionId };

    QuestionRegistry.remove(loop.loopKey, entry.questionId);
    const delivery = entry.resolve({ answers });
    if (delivery && !delivery.delivered) {
      return { resolved: false, reason: "no_active_turn", questionId: entry.questionId };
    }
    return {
      resolved: true,
      questionId: entry.questionId,
      blocking: entry.blocking,
      loopKey: loop.loopKey,
      matchedBy: loop.matchedBy,
    };
  },

  /** Every open question on a loop, oldest first. */
  list(loopKey: string): PendingQuestionSummary[] {
    const questions = pendingQuestions.get(loopKey);
    if (!questions) return [];
    return [...questions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(summarize);
  },

  /** The question a reloaded client shows: the oldest blocking one, else the oldest open card. */
  getPending(loopKey: string): PendingQuestionSummary | null {
    const questions = pendingQuestions.get(loopKey);
    const entry = questions && pickDefault(questions);
    return entry ? summarize(entry) : null;
  },
};

export default QuestionRegistry;
