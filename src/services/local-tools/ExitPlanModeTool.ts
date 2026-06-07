import logger from "../../utils/logger.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

interface ExitPlanModeArgs {
  summary?: string;
}

export default {
  name: TOOL_NAMES.EXIT_PLAN_MODE,

  schema: {
    name: TOOL_NAMES.EXIT_PLAN_MODE,
    description:
      "Exit planning mode and resume normal tool execution. Call this after you have " +
      "produced your plan and are ready to execute it with tools.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Brief summary of the plan you are about to execute.",
        },
      },
      required: [],
    },
  },

  domain: "Core Tools",
  labels: ["coding"],

  async execute(args: ExitPlanModeArgs) {
    logger.info(`[ExitPlanMode] ${args.summary || "(no summary)"}`);
    // Note: AgenticLoopService overrides this result with the approved plan
    // and Claude Code-style approval message after the approval gate.
    return {
      acknowledged: true,
      mode: "execute",
      summary: args.summary || null,
    };
  },
};
