import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SERVER_SENT_EVENT_TYPES,
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { InternalToolContext } from "./InternalToolRegistry.ts";

interface BriefContext extends InternalToolContext {
  _emit?: (event: { type: string; brief: Record<string, unknown> }) => void;
}

export default {
  name: TOOL_NAMES.SUMMARIZE_CONVERSATION,

  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.SUMMARIZE_CONVERSATION],
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
  display: {
    activeVerb: "Summarizing conversation",
    completedVerb: "Summarized conversation",
    subjectParam: "summary",
    subjectFormat: "truncate" as const,
  },

  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["coding"],

  async execute(toolArguments: Record<string, unknown>, context: BriefContext) {
    const summary =
      typeof toolArguments.summary === "string"
        ? toolArguments.summary
        : undefined;
    const keyFiles = Array.isArray(toolArguments.keyFiles)
      ? toolArguments.keyFiles
      : [];
    const openQuestions = Array.isArray(toolArguments.openQuestions)
      ? toolArguments.openQuestions
      : [];

    if (!summary) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.summarize_conversation.summaryRequired",
        ),
      };
    }

    const keyFileItems = keyFiles.filter(
      (item) => typeof item === "string",
    ) as string[];
    const openQuestionItems = openQuestions.filter(
      (item) => typeof item === "string",
    ) as string[];

    const brief = {
      summary,
      keyFiles: keyFileItems,
      openQuestions: openQuestionItems,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      `[Brief] ${summary.length} chars, ${keyFileItems.length} files, ${openQuestionItems.length} questions`,
    );

    if (context._emit) {
      context._emit({ type: SERVER_SENT_EVENT_TYPES.BRIEF_UPDATE, brief });
    }

    return { acknowledged: true, brief };
  },
};
