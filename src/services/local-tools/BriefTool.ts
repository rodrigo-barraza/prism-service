import logger from "../../utils/logger.ts";
import { SSE_EVENT_TYPES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

export default {
  name: TOOL_NAMES.SUMMARIZE_CONVERSATION,

  schema: {
    name: TOOL_NAMES.SUMMARIZE_CONVERSATION,
    description:
      "Produce a compressed summary of the current conversation context. " +
      "Use this tool when the conversation is getting long and you need to " +
      "consolidate your understanding before continuing. The summary you write " +
      "is stored and can be referenced in future turns to recover context. " +
      "This is NOT shown to the user — it is your private working memory.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Your compressed summary of the conversation so far. Include: " +
            "key decisions made, files modified, current task state, and what remains to be done.",
        },
        keyFiles: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: list of key file paths relevant to the current work.",
        },
        openQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Optional: unresolved questions or ambiguities.",
        },
      },
      required: ["summary"],
    },
  },

  domain: "Core Harness Tools",
  labels: ["coding"],

  async execute(args: Record<string, unknown>, context: { _emit?: (event: Record<string, unknown>) => void }) {
    const { summary, keyFiles, openQuestions } = args;
    if (!summary || typeof summary !== "string") {
      return { error: "'summary' is required and must be a non-empty string" };
    }

    const keyFilesArr = (keyFiles || []) as string[];
    const openQuestionsArr = (openQuestions || []) as string[];

    const brief = {
      summary,
      keyFiles: keyFilesArr,
      openQuestions: openQuestionsArr,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      `[Brief] ${summary.length} chars, ${keyFilesArr.length} files, ${openQuestionsArr.length} questions`,
    );

    if (context._emit) {
      context._emit({ type: SSE_EVENT_TYPES.BRIEF_UPDATE, brief });
    }

    return { acknowledged: true, brief };
  },
};
