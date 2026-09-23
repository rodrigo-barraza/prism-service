// ─── ACP sub-agent runs ──────────────────────────────────────
// What OrchestratorService does differently for a sub-agent whose custom
// agent runs on the `acp` runtime (an external ACP agent process —
// harnesses/AcpAgentRuntime): where it works, and what it is told.

import { GitWorktreeHelper } from "./GitWorktreeHelper.ts";
import { AcpAgentError } from "#src/services/harnesses/AcpAgentRuntime";
import { SYSTEM_MESSAGE_TAGS, wrapSystemMessage } from "#src/utils/SystemMessageTags";
import { NOTIFICATION_SOURCES } from "#src/constants";
import logger from "#src/utils/logger";
import type { SubAgentState } from "#src/types/orchestrator";
import type { ConversationMessage } from "#src/services/harnesses/types";

/**
 * An external agent edits files itself — on this host, not through
 * tools-service's workspace checks — so it always works in a worktree of
 * its own: the one its spawn created, or (a resumed agent whose worktree
 * was merged back, a spawn whose worktree could not be created) a fresh one
 * for this run. None can be had: the run fails, it never falls back to the
 * shared workspace.
 */
export async function ensureAcpWorktree(subAgent: SubAgentState): Promise<void> {
  if (subAgent.isolated && subAgent.worktreePath && subAgent.branchName) return;
  const branchName = `orchestrator/${subAgent.agentId}-${Date.now().toString(36)}`;
  const created = await GitWorktreeHelper.createWorktree(subAgent.repositoryPath, branchName);
  if (created.error || !created.worktreePath) {
    throw new AcpAgentError(
      `An external ACP agent runs only in its own git worktree, and none could be created in ${subAgent.repositoryPath}: ${created.error ?? "tools-service returned no worktree"}.`,
    );
  }
  subAgent.worktreePath = created.worktreePath;
  subAgent.branchName = created.branch ?? branchName;
  subAgent.isolated = true;
  logger.info(
    `[Orchestrator] Sub-agent ${subAgent.agentId}: new worktree ${subAgent.worktreePath} (${subAgent.branchName}) for its ACP run`,
  );
}

/** What the external agent is told about its situation, before the task. */
export function acpOperationalContext(subAgent: SubAgentState): string {
  const lines = [
    "You are working as a sub-agent: another agent (Prism) delegated the task below to you, and your final message is your report to it.",
    `Your workspace is ${subAgent.worktreePath}, your own git worktree — a checkout of ${subAgent.repositoryPath}` +
      (subAgent.branchName ? ` on branch ${subAgent.branchName}` : "") +
      ". Work only inside it; paths under the repository in the task mean the same files here.",
    "When you finish, Prism commits your changes and merges them back into the repository: do not push, and do not switch branches.",
    "In your report, say what you did and name the files you changed, relative to the repository.",
  ];
  if (subAgent.files?.length) lines.push(`Focus on files: ${subAgent.files.join(", ")}`);
  return lines.join("\n");
}

/**
 * The run's messages: the sub-agent's earlier transcript (already
 * persisted), its operational context, the task, and any follow-up the
 * parent sent while the run was starting (held on the agent — they go in
 * with the first prompt).
 */
export function acpRunMessages(
  subAgent: SubAgentState,
  prompt: string,
  formatFollowUp: (message: string) => string,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    ...(subAgent.messages || []).map((message) => ({ ...message, _alreadyPersisted: true })),
    {
      role: "system",
      content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.OPERATIONAL_CONTEXT, acpOperationalContext(subAgent)),
    },
    { role: "user", content: prompt },
  ];
  const held = subAgent.pendingMessages ?? [];
  subAgent.pendingMessages = [];
  for (const message of held) {
    messages.push({
      role: "user",
      content: formatFollowUp(message),
      _notificationSource: NOTIFICATION_SOURCES.ORCHESTRATOR,
      _notificationId: `${NOTIFICATION_SOURCES.ORCHESTRATOR}:${subAgent.agentId}:${Date.now()}`,
    } as ConversationMessage);
  }
  return messages;
}
