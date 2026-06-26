import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { InternalToolContext } from "./InternalToolRegistry.ts";
import type { QuestionDefinition } from "../ApprovalRegistry.ts";

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
}

interface AskUserContext extends InternalToolContext {
  _emit?: (event: UserQuestionEmitEvent) => void;
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

interface AskUserQuestionArgs {
  context?: string;
  questions: QuestionInput[];
}

export default {
  name: TOOL_NAMES.ASK_USER,
  schema: {
    name: TOOL_NAMES.ASK_USER,
    emoji: ["💬", "❓"],
    description:
      "Ask the user one or more questions and wait for their responses before continuing. " +
      "Use this when you need clarification, a decision between options, or explicit " +
      "confirmation before proceeding with a potentially impactful action. " +
      "The agent loop pauses until the user responds. " +
      "You can batch up to 4 related questions in a single call to reduce round-trips.",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "Optional: additional context shown below the questions.",
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
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.questionsRequired"),
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
          error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.invalidQuestion"),
        };
      }
      if (seen.has(questionInput.question)) {
        return {
          error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.duplicateQuestion", { preview: questionInput.question.slice(0, 60) }),
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
              error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.duplicateOption", { label: option.label, question: questionInput.question.slice(0, 40) }),
            };
          }
          labelsSeen.add(option.label);
        }
      }
    }
    if (questions.length > 4) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.tooManyQuestions") };
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

    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.noConversation"),
      };
    }

    const totalOptions = normalizedQuestions.reduce(
      (sum, questionObject) => sum + questionObject.options.length,
      0,
    );
    logger.info(
      `[AskUserQuestion] ${normalizedQuestions.length} question(s), ` +
        `${totalOptions} total options — ` +
        `"${normalizedQuestions[0].question.slice(0, 60)}${normalizedQuestions[0].question.length > 60 ? "..." : ""}"`,
    );

    // Emit the SSE event with the full questions array
    if (context._emit) {
      context._emit({
        type: "user_question",
        questions: normalizedQuestions,
        context: questionContext || null,
      });
    }

    const { default: AgenticLoopService } =
      await import("../AgenticLoopService.js");
    const result = await new Promise<QuestionResult>((resolve) => {
      const timeoutId = setTimeout(
        () => resolve({ answers: null, timedOut: true }),
        300_000,
      );
      AgenticLoopService._setPendingQuestion(agentConversationId, {
        resolve: (value: QuestionResult) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        questions: normalizedQuestions,
      });
    });

    if (result.timedOut) {
      logger.warn(`[AskUserQuestion] Timed out after 5 minutes`);
      return {
        answers: null,
        timedOut: true,
        message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.ask_user.timedOut"),
      };
    }

    logger.info(
      `[AskUserQuestion] Answered: ${JSON.stringify(result.answers).slice(0, 200)}`,
    );

    // Return structured response
    return {
      questions: normalizedQuestions.map((query) => query.question),
      answers: result.answers,
    };
  },
};
