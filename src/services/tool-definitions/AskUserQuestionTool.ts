import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { type InternalToolContext } from "./InternalToolRegistry.ts";
import { LOG_PREVIEW, AGENT_DIRECTIVES, TURN_INPUT } from "#src/constants";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { resolveLoopKey } from "#src/services/LoopKey";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { QuestionDefinition } from "#src/services/ApprovalRegistry";

interface QuestionOption {
  label: string;
  preview: string | null;
}

interface NormalizedQuestion extends QuestionDefinition {
  question: string;
  header: string | null;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface UserQuestionEmitEvent {
  type: "user_question";
  questions: NormalizedQuestion[];
  context: string | null;
  /** Stable id for the card — the answer to a non-blocking card is matched by it. */
  questionId: string;
  /** false → the loop keeps working; the answer arrives via TurnInputMailbox. */
  blocking: boolean;
}

interface QuestionPendingStatusEvent {
  type: typeof SERVER_SENT_EVENT_TYPES.STATUS;
  message: typeof TURN_INPUT.STATUS_QUESTION_PENDING;
  questionId: string;
}

interface AskUserContext extends InternalToolContext {
  _emit?: (event: UserQuestionEmitEvent | QuestionPendingStatusEvent) => void;
}

/** How long a BLOCKING question holds the turn before it gives up. */
export const ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS = 300_000;

let questionSequence = 0;
function nextQuestionId(): string {
  questionSequence++;
  return `q-${Date.now().toString(36)}-${questionSequence}`;
}

/** Render the user's answers as the text of a <user-answer> message. */
export function formatQuestionAnswers(
  questions: NormalizedQuestion[],
  answers: QuestionAnswer[] | null,
  questionId: string,
): string {
  if (!answers || answers.length === 0) {
    return `Question ${questionId}: no answer was given.`;
  }
  const lines: string[] = [`Answers to question card ${questionId}:`];
  questions.forEach((question, index) => {
    const answer = answers[index]?.answer;
    const rendered = Array.isArray(answer) ? answer.join(", ") : (answer ?? "(no answer)");
    lines.push(`- Q: ${question.question}\n  A: ${rendered}`);
    const annotations = (answers[index] as { annotations?: string } | undefined)?.annotations;
    if (annotations) lines.push(`  Notes: ${annotations}`);
  });
  return lines.join("\n");
}

interface QuestionAnswer {
  answer?: string | string[];
}

interface QuestionResult {
  answers: QuestionAnswer[] | null;
  timedOut?: boolean;
}

interface QuestionInput {
  question: string;
  header?: string;
  options?: {
    label: string;
    preview?: string | null;
  }[];
  multiSelect?: boolean;
}


export default {
  name: TOOL_NAMES.ASK_USER,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.ASK_USER],
  description:
    "Ask the user one or more questions and wait for their responses before continuing. " +
    "Use this when you need clarification, a decision between options, or explicit " +
    "confirmation before proceeding with a potentially impactful action. " +
    "By default the agent loop pauses until the user responds. " +
    "Set blocking=false to ask a preference the rest of your work does not depend on: the card is " +
    "shown, you continue immediately, and the answer is delivered to you as a <user-answer> message " +
    "at your next step (or as the next turn if this one has ended). Never use blocking=false for " +
    "a decision the next action depends on. " +
    "You can batch up to 4 related questions in a single call to reduce round-trips.",
  parameters: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description:
          "Optional: additional context shown below the questions.",
      },
      blocking: {
        type: "boolean",
        description:
          "Optional: default true (wait for the answer). false → show the card, keep working, and receive the answer later as a <user-answer> message.",
      },
      questions: {
        type: "array",
        maxItems: 4,
        description:
          "Batch of questions to ask the user (up to 4). Each item is a question object.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question text.",
            },
            header: {
              type: "string",
              maxLength: 16,
              description:
                "Optional: short label chip displayed as a tag (e.g. 'Auth method', 'Database'). Max 16 chars.",
            },
            options: {
              type: "array",
              maxItems: 6,
              description: "Optional: predefined choices (up to 6).",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "The choice label shown to the user.",
                  },
                  preview: {
                    type: "string",
                    description:
                      "Optional: markdown or code preview content shown when this option is focused/hovered.",
                  },
                },
                required: ["label"],
              },
            },
            multiSelect: {
              type: "boolean",
              description:
                "Optional: if true, the user can select multiple options (checkboxes). Default: false (single select).",
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
  display: {
    activeVerb: "Asking user",
    completedVerb: "Asked user",
    subjectParam: "context",
    subjectFormat: "truncate" as const,
  },
  labels: ["coding"],
  domain: DOMAINS.CORE_USER.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: AskUserContext,
  ) {
    const questionContext =
      typeof toolArguments.context === "string"
        ? toolArguments.context
        : undefined;
    const questions = Array.isArray(toolArguments.questions)
      ? (toolArguments.questions as QuestionInput[])
      : undefined;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.ask_user.questionsRequired",
        ),
      };
    }

    // ── Normalize into questions array ─────────────────
    const seen = new Set<string>();
    for (const questionInput of questions) {
      if (
        !questionInput.question ||
        typeof questionInput.question !== "string"
      ) {
        return {
          error: PromptLocaleService.get(
            PromptLocaleService.getDefaultLocale(),
            "internal-tools-runtime.ask_user.invalidQuestion",
          ),
        };
      }
      if (seen.has(questionInput.question)) {
        return {
          error: PromptLocaleService.get(
            PromptLocaleService.getDefaultLocale(),
            "internal-tools-runtime.ask_user.duplicateQuestion",
            { preview: questionInput.question.slice(0, LOG_PREVIEW.SHORT) },
          ),
        };
      }
      seen.add(questionInput.question);
      // Validate option label uniqueness within each question
      const questionOptions = questionInput.options;
      if (questionOptions && questionOptions.length > 0) {
        const labelsSeen = new Set<string>();
        for (const option of questionOptions) {
          if (labelsSeen.has(option.label)) {
            return {
              error: PromptLocaleService.get(
                PromptLocaleService.getDefaultLocale(),
                "internal-tools-runtime.ask_user.duplicateOption",
                {
                  label: option.label,
                  question: questionInput.question.slice(0, 40),
                },
              ),
            };
          }
          labelsSeen.add(option.label);
        }
      }
    }
    if (questions.length > 4) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.ask_user.tooManyQuestions",
        ),
      };
    }
    const normalizedQuestions: NormalizedQuestion[] = questions.map(
      (questionInput) => ({
        question: questionInput.question,
        header: (questionInput.header || "").slice(0, 16) || null,
        options: (questionInput.options || []).slice(0, 6).map((item) => ({
          label: item.label,
          preview: item.preview || null,
        })),
        multiSelect: !!questionInput.multiSelect,
      }),
    );

    // Filed under the loop key — the id the client answers with (see LoopKey).
    const loopKey = resolveLoopKey(context);
    const agentConversationId = context.agentConversationId || null;
    if (!loopKey) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.ask_user.noConversation",
        ),
      };
    }

    const totalOptions = normalizedQuestions.reduce(
      (sum, questionObject) => sum + questionObject.options.length,
      0,
    );
    logger.info(
      `[AskUserQuestion] ${normalizedQuestions.length} question(s), ` +
        `${totalOptions} total options — ` +
        `"${normalizedQuestions[0].question.slice(0, LOG_PREVIEW.SHORT)}${normalizedQuestions[0].question.length > LOG_PREVIEW.SHORT ? "..." : ""}"`,
    );

    const questionId = nextQuestionId();
    const isBlocking = toolArguments.blocking !== false;

    // Emit the SSE event with the full questions array
    if (context._emit) {
      context._emit({
        type: "user_question",
        questions: normalizedQuestions,
        context: questionContext || null,
        questionId,
        blocking: isBlocking,
      });
    }

    const { default: AgenticLoopService } =
      await import("#src/services/AgenticLoopService");

    // ── Non-blocking: register the resolver, return at once ──────────
    // The answer route resolves the same pending-question entry; the
    // resolver posts the answer into the turn's mailbox, where the harness
    // picks it up at its next boundary. If the turn has already ended the
    // entry is gone (loop cleanup) or the mailbox refuses it, and the route
    // answers 404 — the client then sends the answer as a normal message,
    // which is the same text. Either way it is delivered exactly once.
    if (!isBlocking) {
      AgenticLoopService._setPendingQuestion(loopKey, {
        questionId,
        blocking: false,
        createdAt: Date.now(),
        agentConversationId,
        resolve: (value: QuestionResult) => {
          const posted = TurnInputMailbox.post(loopKey, {
            kind: "question_answer",
            text: formatQuestionAnswers(normalizedQuestions, value.answers, questionId),
            meta: { questionId },
          });
          if (!posted.accepted) {
            logger.warn(
              `[AskUserQuestion] Answer to ${questionId} arrived with no open turn (${posted.reason})`,
            );
          }
          return { delivered: posted.accepted, reason: posted.reason };
        },
        questions: normalizedQuestions,
      });
      if (context._emit) {
        context._emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: TURN_INPUT.STATUS_QUESTION_PENDING,
          questionId,
        });
      }
      logger.info(`[AskUserQuestion] ${questionId} posted non-blocking; continuing`);
      return {
        _directive: AGENT_DIRECTIVES.DETACHED_WORK,
        questionId,
        status: "pending",
        blocking: false,
        questions: normalizedQuestions.map((query) => query.question),
        instruction:
          "The question card is shown. Continue with work that does not depend on the answer. " +
          "The answer will arrive as a <user-answer> message; do not poll or ask again.",
      };
    }

    const result = await new Promise<QuestionResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        // Off the registry first, so a late answer 404s (and the client
        // sends it as a message) instead of resolving a wait nobody reads.
        AgenticLoopService._removePendingQuestion(loopKey, questionId);
        resolve({ answers: null, timedOut: true });
      }, ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS);
      AgenticLoopService._setPendingQuestion(loopKey, {
        questionId,
        blocking: true,
        createdAt: Date.now(),
        agentConversationId,
        resolve: (value: QuestionResult) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        questions: normalizedQuestions,
      });
    });

    if (result.timedOut) {
      logger.warn(
        `[AskUserQuestion] ${questionId} timed out after ${ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS / 1000}s`,
      );
      return {
        answers: null,
        timedOut: true,
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.ask_user.timedOut",
        ),
      };
    }

    logger.info(
      `[AskUserQuestion] Answered: ${JSON.stringify(result.answers).slice(0, LOG_PREVIEW.MEDIUM)}`,
    );

    // Return structured response
    return {
      questionId,
      questions: normalizedQuestions.map((query) => query.question),
      answers: result.answers,
    };
  },
};
