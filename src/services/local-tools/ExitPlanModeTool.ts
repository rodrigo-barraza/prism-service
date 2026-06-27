import logger from "../../utils/logger.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

export default {
  name: TOOL_NAMES.EXIT_PLAN_MODE,

  schema: {
    name: TOOL_NAMES.EXIT_PLAN_MODE,
    emoji: ["🚀", "🧠"],
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

  labels: ["coding"],
  domain: DOMAINS.CORE_PLAN.displayName,

  async execute(toolArguments: Record<string, unknown>) {
    const summary = typeof toolArguments.summary === "string" ? toolArguments.summary : undefined;
    logger.info(`[ExitPlanMode] ${summary || "(no summary)"}`);
    // Note: AgenticLoopService overrides this result with the approved plan
    // and Claude Code-style approval message after the approval gate.
    return {
      acknowledged: true,
      mode: "execute",
      summary: summary || null,
    };
  },
};
