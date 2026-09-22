import type { Request, Response } from "express";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ConversationAttentionRegistry from "#src/services/ConversationAttentionRegistry";
import PendingDecisionStore from "#src/services/PendingDecisionStore";
import logger from "#src/utils/logger";

/**
 * POST /agent/answer and POST /conversation/answer — one handler.
 *
 * Body:
 *   {
 *     conversationId: string,        // the loop key: a root turn's conversation id,
 *                                    // or a sub-agent's own conversation id
 *     agentConversationId?: string,  // legacy key, still resolved for one release
 *     questionId?: string,           // from the `user_question` event — resolves exactly that card
 *     answer?: string,               // simple (backward-compat)
 *     answers?: Array<{ answer: string|string[], annotations?: string }>,
 *   }
 *
 * Without `questionId` the oldest BLOCKING question is answered (else the
 * oldest open card); the response names the question it resolved.
 *
 * 404 when nothing took the answer — no pending question, an unknown
 * `questionId`, or a non-blocking card whose turn already ended. The client
 * then sends the answer as a normal message, so it is delivered once.
 *
 * 409 `already_answered` for a second answer to one card: the first was
 * taken, and a 404 here would make the client send this one as a message.
 *
 * Questions are durable (PendingDecisionStore): an answer to a turn parked
 * when the previous process stopped is stored — `delivered: false` — for
 * the turn to pick up when it is re-driven.
 */
export function handleQuestionAnswer(routeLabel: string) {
  return async (request: Request, response: Response) => {
    const { conversationId, agentConversationId, questionId, answer, answers } =
      request.body ?? {};
    const addressedId =
      typeof conversationId === "string" && conversationId
        ? conversationId
        : typeof agentConversationId === "string"
          ? agentConversationId
          : "";

    if (!addressedId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }
    if (questionId !== undefined && typeof questionId !== "string") {
      return response.status(400).json({ error: "questionId must be a string" });
    }

    // Normalize: structured answers take priority, fall back to simple string
    let normalizedAnswers: {
      answer: string | string[];
      annotations?: string;
    }[];
    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers as {
        answer: string | string[];
        annotations?: string;
      }[];
    } else if (answer !== undefined && answer !== null) {
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return response.status(400).json({ error: "Missing answer or answers" });
    }

    const outcome = await AgenticLoopService.resolveUserQuestion(
      addressedId,
      normalizedAnswers,
      {
        questionId: questionId || undefined,
        agentConversationId:
          typeof agentConversationId === "string" ? agentConversationId : undefined,
      },
    );

    if (!outcome.resolved && outcome.reason === "already_answered") {
      return response.status(409).json({
        error: "This question was already answered",
        reason: outcome.reason,
        conversationId: addressedId,
        questionId: outcome.questionId,
      });
    }
    if (!outcome.resolved) {
      const error =
        outcome.reason === "unknown_question"
          ? "No pending question with this questionId"
          : outcome.reason === "no_active_turn"
            ? "The turn that asked has ended"
            : "No pending question for this conversation";
      return response.status(404).json({
        error,
        reason: outcome.reason,
        conversationId: addressedId,
        ...(outcome.questionId ? { questionId: outcome.questionId } : {}),
      });
    }

    logger.info(
      `[${routeLabel}] ${normalizedAnswers.length} answer(s) → ${outcome.questionId} ` +
        `(${outcome.blocking ? "blocking" : "non-blocking"}) on ${outcome.loopKey}`,
    );

    if (!outcome.delivered) {
      // No running turn will emit the event that closes its "needs you" entry.
      ConversationAttentionRegistry.forget(
        await PendingDecisionStore.find({ loopKey: outcome.loopKey, itemId: outcome.questionId }),
      );
    }

    response.json({
      ok: true,
      questionId: outcome.questionId,
      blocking: outcome.blocking,
      delivered: outcome.delivered,
    });
  };
}
