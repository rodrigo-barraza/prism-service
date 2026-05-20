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

  async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
    const { question, choices, context: questionContext, questions } = args;

    // ── Normalize into questions array ─────────────────
    let normalizedQuestions: Record<string, unknown>;
    if (questions && Array.isArray(questions) && questions.length > 0) {
      // Multi-question mode — validate uniqueness
      const seen = new Set();
      // @ts-ignore
      for ( const q of questions) {
        if (!q.question || typeof q.question !== "string") {
          return {
            error:
              "Each question in the 'questions' array must have a non-empty 'question' string",
          };
        }
        if (seen.has(q.question)) {
          return {
            error: `Duplicate question text: "${q.question.slice(0, 60)}"`,
          };
        }
        seen.add(q.question);
        // Validate option label uniqueness within each question
        if (q.options?.length > 0) {
          const labelsSeen = new Set();
          // @ts-ignore
          for ( const opt of q.options) {
            if (labelsSeen.has(opt.label)) {
              return {
                error: `Duplicate option label "${opt.label}" in question "${q.question.slice(0, 40)}"`,
              };
            }
            labelsSeen.add(opt.label);
          }
        }
      }
      if (questions.length > 4) {
        return { error: "Maximum 4 questions per call" };
      }
      // @ts-ignore - TODO: strict typing
      normalizedQuestions = questions.map((q: Record<string, unknown>) => ({
        question: q.question,
        // @ts-ignore - TODO: strict typing
        header: q.header?.slice(0, 16) || null,
        // @ts-ignore - TODO: strict typing
        options: (q.options || []).slice(0, 6).map((o: Record<string, unknown>) => ({
          label: o.label,
          preview: o.preview || null,
        })),
        multiSelect: !!q.multiSelect,
      }));
    } else if (question && typeof question === "string") {
      // Single question mode — backward-compatible
      // @ts-ignore - TODO: strict typing
      normalizedQuestions = [
        {
          question,
          header: null,
          // @ts-ignore - TODO: strict typing
          options: (choices || []).map((c: Record<string, unknown>) => ({
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

    // @ts-ignore - TODO: strict typing
    const totalOptions = normalizedQuestions.reduce(
      // @ts-ignore - TODO: strict typing
      (sum: Record<string, unknown>, q: Record<string, unknown>) => sum + q.options.length,
      0,
    );
    logger.info(
      `[AskUserQuestion] ${normalizedQuestions.length} question(s), ` +
        `${totalOptions} total options — ` +
        // @ts-ignore - TODO: strict typing
        `"${normalizedQuestions[0].question.slice(0, 60)}${normalizedQuestions[0].question.length > 60 ? "..." : ""}"`,
    );

    // Emit the SSE event with the full questions array
    if (context._emit) {
      // @ts-ignore - TODO: strict typing
      context._emit({
        type: "user_question",
        // Full multi-question payload
        questions: normalizedQuestions,
        // Backward-compat fields for simple consumers
        // @ts-ignore - TODO: strict typing
        question: normalizedQuestions[0].question,
        // @ts-ignore - TODO: strict typing
        choices: normalizedQuestions[0].options.map((o: Record<string, unknown>) => o.label),
        context: questionContext || null,
      });
    }

    const { default: AgenticLoopService } =
      await import("../AgenticLoopService.js");
    // @ts-ignore - TODO: strict typing
    const result = await new Promise((resolve: Record<string, unknown>) => {
      const timeoutId = setTimeout(
        // @ts-ignore - TODO: strict typing
        () => resolve({ answers: null, timedOut: true }),
        300_000,
      );
      // @ts-ignore - TODO: strict typing
      AgenticLoopService._setPendingQuestion(sessionId, {
        resolve: (value: Record<string, unknown>) => {
          clearTimeout(timeoutId);
          // @ts-ignore - TODO: strict typing
          resolve(value);
        },
        questions: normalizedQuestions,
      });
    });

    // @ts-ignore
    if (result.timedOut) {
      logger.warn(`[AskUserQuestion] Timed out after 5 minutes`);
      return {
        answers: null,
        timedOut: true,
        message: "The user did not respond within 5 minutes.",
      };
    }

    // @ts-ignore
    logger.info(
      // @ts-ignore
      `[AskUserQuestion] Answered: ${JSON.stringify(result.answers).slice(0, 200)}`,
    );

    // Return structured response
    return {
      // @ts-ignore - TODO: strict typing
      questions: normalizedQuestions.map((q: Record<string, unknown>) => q.question),
      // @ts-ignore
      answers: result.answers,
      // Backward-compat for simple single-question consumers
      // @ts-ignore
      answer: Array.isArray(result.answers)
        // @ts-ignore
        ? result.answers[0]?.answer
        // @ts-ignore
        : result.answers,
    };
  },
};
