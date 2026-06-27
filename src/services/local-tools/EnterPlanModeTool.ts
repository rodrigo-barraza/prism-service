import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

export default {
  name: TOOL_NAMES.ENTER_PLAN_MODE,

  schema: {
    name: TOOL_NAMES.ENTER_PLAN_MODE,
    emoji: ["📝", "🧠"],
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
  },

  labels: ["coding"],
  domain: DOMAINS.CORE_PLAN.displayName,

  async execute(toolArguments: Record<string, unknown>) {
    const reason = typeof toolArguments.reason === "string" ? toolArguments.reason : undefined;
    logger.info(`[EnterPlanMode] ${reason || "(no reason given)"}`);
    return {
      acknowledged: true,
      mode: "plan",
      reason: reason || null,
      message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "harness.planModeEntry.message"),
    };
  },
};
