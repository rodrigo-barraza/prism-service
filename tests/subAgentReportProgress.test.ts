/**
 * Prompt 17, Landing 1 — report_progress edge cases. The delivery into a
 * running parent turn is covered with the real harness in
 * nonBlockingSubAgentDispatch.test.ts (scenario 3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, ORCHESTRATOR, NOTIFICATION_SOURCES } from "#src/constants";
import OrchestratorService from "#src/services/OrchestratorService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import type { SubAgentState } from "#src/types/orchestrator";

const PARENT_CONVERSATION_ID = "progress-parent";
const CHILD_CONVERSATION_ID = "progress-child";

function registerChild(status: SubAgentState["status"] = "running"): SubAgentState {
  const subAgent = {
    agentId: "agent-7-beef",
    subAgentConversationId: CHILD_CONVERSATION_ID,
    parentAgentConversationId: "progress-parent-session",
    parentConversationId: PARENT_CONVERSATION_ID,
    description: "Crawler",
    status,
    project: "test-project",
    username: "test-user",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
  } as SubAgentState;
  OrchestratorService._getActiveSubAgents().set(subAgent.agentId, subAgent);
  return subAgent;
}

function reportProgress(message: string, conversationId = CHILD_CONVERSATION_ID) {
  return InternalToolRegistry.execute("report_progress", { message }, { conversationId });
}

describe("report_progress", () => {
  beforeEach(() => {
    OrchestratorService.clearAllActiveSubAgents();
    TurnInputMailbox._clearAll();
  });

  afterEach(() => {
    OrchestratorService.clearAllActiveSubAgents();
    TurnInputMailbox._clearAll();
  });

  it("is refused for a caller that is not a running sub-agent", async () => {
    expect(await reportProgress("hi", "some-root-conversation")).toEqual({
      error: "report_progress is only available to a running sub-agent.",
    });
    registerChild("complete");
    expect(await reportProgress("hi")).toHaveProperty("error");
  });

  it("is not queued when the parent has no open turn, but is remembered on the agent", async () => {
    const child = registerChild();

    expect(await reportProgress("Halfway there")).toEqual({ delivered: false, reason: "no_active_turn" });
    expect(child.lastProgress?.message).toBe("Halfway there");
    expect(TurnInputMailbox.pendingCount(PARENT_CONVERSATION_ID)).toBe(0);
  });

  it("posts one external input from the sub-agent, clipped, per call", async () => {
    registerChild();
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);
    const longMessage = "x".repeat(ORCHESTRATOR.PROGRESS_REPORT_MAXIMUM_CHARACTERS + 500);

    expect(await reportProgress(longMessage)).toMatchObject({ delivered: true });

    const [entry] = TurnInputMailbox.drain(PARENT_CONVERSATION_ID);
    // Prompt 22 L3: a sub-agent's words reach its parent as external input.
    expect(entry.kind).toBe("external");
    expect(entry.origin).toEqual({ source: "subagent", sender: "agent-7-beef" });
    expect(entry.meta).toMatchObject({
      _notificationSource: NOTIFICATION_SOURCES.SUB_AGENT_PROGRESS,
      _authority: "sub-agent",
      _subAgentId: "agent-7-beef",
    });
    // Plain text: the mailbox renders it inside the external-input envelope.
    expect(entry.text).toContain("Progress report from your sub-agent agent-7-beef");
    expect(entry.text).toContain("not from the user");
    expect(entry.text).not.toContain("x".repeat(ORCHESTRATOR.PROGRESS_REPORT_MAXIMUM_CHARACTERS + 1));
  });

  it(`stops delivering after ${ORCHESTRATOR.MAXIMUM_PROGRESS_REPORTS_PER_RUN} reports in one run`, async () => {
    registerChild();
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);
    for (let report = 0; report < ORCHESTRATOR.MAXIMUM_PROGRESS_REPORTS_PER_RUN; report++) {
      expect(await reportProgress(`step ${report}`)).toMatchObject({ delivered: true });
    }

    expect(await reportProgress("one too many")).toEqual({ delivered: false, reason: "progress_limit_reached" });
    expect(TurnInputMailbox.pendingCount(PARENT_CONVERSATION_ID)).toBe(ORCHESTRATOR.MAXIMUM_PROGRESS_REPORTS_PER_RUN);
  });

  it("rejects an empty message", async () => {
    registerChild();
    TurnInputMailbox.open(PARENT_CONVERSATION_ID);
    expect(await reportProgress("   ")).toEqual({ error: "'message' is required." });
    expect(TurnInputMailbox.pendingCount(PARENT_CONVERSATION_ID)).toBe(0);
  });
});
