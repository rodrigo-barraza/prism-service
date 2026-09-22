import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { ORCHESTRATOR } from "#src/constants";
import { type InternalToolContext } from "./InternalToolRegistry.ts";

export const REPORT_PROGRESS_TOOL_NAME = "report_progress";

/**
 * Tools that only mean something inside a sub-agent — they address the
 * parent. AgenticToolResolver removes them from every root loop.
 */
export const SUB_AGENT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  REPORT_PROGRESS_TOOL_NAME,
]);

// ── report_progress ────────────────────────────────────────
// A running sub-agent tells the agent that delegated to it how far it has
// got, without ending its task. OrchestratorService.reportProgress posts it
// into the parent's running turn as an `agent_message` carrying sub-agent
// authority — the parent sees a delegate's status, never a user instruction.
const reportProgress = {
  name: REPORT_PROGRESS_TOOL_NAME,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[REPORT_PROGRESS_TOOL_NAME],
  description:
    "Send a short progress update to the agent that delegated this task to you, while you keep working. " +
    "Use it at real milestones (a finding the parent can act on now, a blocker, a change of plan) — not for every step. " +
    "It is not your final answer: finish the task and end with a full summary as usual. " +
    `At most ${ORCHESTRATOR.MAXIMUM_PROGRESS_REPORTS_PER_RUN} updates per task; the parent only receives them while it is working.`,
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: `The update, in one or two sentences (up to ${ORCHESTRATOR.PROGRESS_REPORT_MAXIMUM_CHARACTERS} characters).`,
      },
    },
    required: ["message"],
  },
  display: {
    activeVerb: "Reporting progress",
    completedVerb: "Reported progress",
    subjectParam: "message",
    subjectFormat: "truncate" as const,
  },
  labels: ["subagent", "orchestrator", "progress"],
  domain: DOMAINS.CORE_ORCHESTRATOR.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const { default: OrchestratorService } = await import(
      "#src/services/OrchestratorService"
    );
    return OrchestratorService.reportProgress(
      context.conversationId || context.agentConversationId || "",
      typeof toolArguments.message === "string" ? toolArguments.message : "",
    );
  },
};

export default [reportProgress];
