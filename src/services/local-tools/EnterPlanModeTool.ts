import logger from "../../utils/logger.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

interface EnterPlanModeArgs {
  reason?: string;
}

export default {
  name: TOOL_NAMES.ENTER_PLAN_MODE,

  schema: {
    name: TOOL_NAMES.ENTER_PLAN_MODE,
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

  domain: "Core Tools",
  labels: ["coding"],

  async execute(args: EnterPlanModeArgs) {
    logger.info(`[EnterPlanMode] ${args.reason || "(no reason given)"}`);
    return {
      acknowledged: true,
      mode: "plan",
      reason: args.reason || null,
      message:
        "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n\n" +
        "In plan mode, you should:\n" +
        "1. Thoroughly explore the codebase to understand existing patterns\n" +
        "2. Identify similar features and architectural approaches\n" +
        "3. Consider multiple approaches and their trade-offs\n" +
        "4. Design a concrete implementation strategy\n" +
        "5. When ready, call exit_plan_mode to present your plan for approval\n\n" +
        "Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.",
    };
  },
};
