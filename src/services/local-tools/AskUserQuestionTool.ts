import logger from "../../utils/logger.ts";

export default {
  name: "ask_user_question",
  schema: {
    name: "ask_user_question",
    description:
      "Ask the user one or more questions and wait for their responses before continuing. " +
      "Use this when you need clarification, a decision between options, or explicit " +
      "confirmation before proceeding with a potentially impactful action. " +
      "The agent loop pauses until the user responds. " +
      "You can batch up to 4 related questions in a single call to reduce round-trips.",
    parameters: {
      type: "object",
      properties: {
        // ── Single question (simple) ───────────────────
        question: {
          type: "string",
          description:
            "The question to present to the user. For a single question, use this directly. For multiple questions, use the 'questions' array instead.",
        },
        choices: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: predefined answer choices for a single question.",
        },
        context: {
          type: "string",
          description:
            "Optional: additional context shown below a single question.",
        },

        // ── Multi-question batch ───────────────────────
        questions: {
          type: "array",
          maxItems: 4,
          description:
            "Optional: batch multiple related questions in one call (up to 4). Each item is a question object.",
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
      // At least one of question or questions is required — validated in execute()
    },
  },
  domain: "Agentic: Control Flow",
  labels: ["coding"],

interface QuestionOption {
  label: string;
  preview: string | null;
}

interface NormalizedQuestion {
  question: string;
  header: string | null;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface ToolContext {
  agentSessionId?: string;
  _emit?: (event: Record<string, unknown>) => void;
}

interface QuestionAnswer {
  answer?: string;
  [key: string]: unknown;
}

interface QuestionResult {
  answers: QuestionAnswer[] | null;
  timedOut?: boolean;
}

  async execute(args: Record<string, unknown>, context: ToolContext) {
    const { question, choices, context: questionContext, questions } = args;

    // ── Normalize into questions array ─────────────────
    let normalizedQuestions: NormalizedQuestion[];
    if (questions && Array.isArray(questions) && questions.length > 0) {
      // Multi-question mode — validate uniqueness
      const seen = new Set<string>();
      for ( const q of questions as Record<string, unknown>[]) {
        if (!q.question || typeof q.question !== "string") {
          return {
            error:
              "Each question in the 'questions' array must have a non-empty 'question' string",
          };
        }
        if (seen.has(q.question)) {
          return {
            error: `Duplicate question text: "${(q.question as string).slice(0, 60)}"`,
          };
        }
        seen.add(q.question);
        // Validate option label uniqueness within each question
        const qOptions = q.options as Record<string, unknown>[] | undefined;
        if (qOptions && qOptions.length > 0) {
          const labelsSeen = new Set<string>();
          for ( const opt of qOptions) {
            if (labelsSeen.has(opt.label as string)) {
              return {
                error: `Duplicate option label "${opt.label}" in question "${(q.question as string).slice(0, 40)}"`,
              };
            }
            labelsSeen.add(opt.label as string);
          }
        }
      }
      if (questions.length > 4) {
        return { error: "Maximum 4 questions per call" };
      }
      normalizedQuestions = (questions as Record<string, unknown>[]).map((q) => ({
        question: q.question as string,
        header: ((q.header as string) || "").slice(0, 16) || null,
        options: ((q.options || []) as Record<string, unknown>[]).slice(0, 6).map((o) => ({
          label: o.label as string,
          preview: (o.preview as string) || null,
        })),
        multiSelect: !!q.multiSelect,
      }));
    } else if (question && typeof question === "string") {
      // Single question mode — backward-compatible
      normalizedQuestions = [
        {
          question,
          header: null,
          options: ((choices || []) as string[]).map((c) => ({
            label: c,
            preview: null,
          })),
          multiSelect: false,
        },
      ];
    } else {
      return {
        error: "Either 'question' (string) or 'questions' (array) is required",
      };
    }

    const sessionId = context.agentSessionId;
    if (!sessionId) {
      return {
        error:
          "No agent session — ask_user_question requires an active session",
      };
    }

    const totalOptions = normalizedQuestions.reduce(
      (sum, q) => sum + q.options.length,
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
        // Full multi-question payload
        questions: normalizedQuestions,
        // Backward-compat fields for simple consumers
        question: normalizedQuestions[0].question,
        choices: normalizedQuestions[0].options.map((o) => o.label),
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
      AgenticLoopService._setPendingQuestion(sessionId, {
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
        message: "The user did not respond within 5 minutes.",
      };
    }

    logger.info(
      `[AskUserQuestion] Answered: ${JSON.stringify(result.answers).slice(0, 200)}`,
    );

    // Return structured response
    return {
      questions: normalizedQuestions.map((q) => q.question),
      answers: result.answers,
      // Backward-compat for simple single-question consumers
      answer: Array.isArray(result.answers)
        ? result.answers[0]?.answer
        : result.answers,
    };
  },
};
