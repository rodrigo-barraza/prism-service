import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";

export default {
  name: TOOL_NAMES.ENTER_PLAN_MODE,

  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.ENTER_PLAN_MODE],
  description:
    "Switch into planning mode. While in plan mode, you will not have access to any tools — " +
    "you can only output text. Use this to produce a structured implementation plan before " +
    "executing changes. Call exit_plan_mode when you are ready to resume tool execution. " +
    "Use this when the task is complex and benefits from upfront planning.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why you are entering plan mode (shown to the user).",
      },
    },
    required: [],
  },
  display: {
    activeVerb: "Entering plan mode",
    completedVerb: "Entered plan mode",
    subjectParam: "reason",
    subjectFormat: "truncate" as const,
  },

  labels: ["coding"],
  domain: DOMAINS.CORE_PLAN.displayName,

  async execute(toolArguments: Record<string, unknown>) {
    const reason =
      typeof toolArguments.reason === "string"
        ? toolArguments.reason
        : undefined;
    logger.info(`[EnterPlanMode] ${reason || "(no reason given)"}`);
    return {
      acknowledged: true,
      mode: "plan",
      reason: reason || null,
      message: PromptLocaleService.get(
        PromptLocaleService.getDefaultLocale(),
        "harness.planModeEntry.message",
      ),
    };
  },
};
