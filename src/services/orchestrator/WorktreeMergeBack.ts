import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { GitWorktreeHelper } from "#src/services/orchestrator/GitWorktreeHelper";
import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import type {
  MergeBackReport,
  SubAgentResult,
  SubAgentState,
} from "#src/types/orchestrator";
import type { EmitFunction } from "#src/services/harnesses/types";

/**
 * Sub-agent worktree merge-back.
 *
 * An isolated sub-agent works on its own branch in its own worktree. When its
 * loop ends, the work is committed, diffed (tools-service's typed contract),
 * merged into the repository's current branch, and only THEN is the worktree
 * removed and the branch deleted. Every failure keeps both and reports where
 * they are: nothing here ever discards work.
 *
 * A caller that owns the worktree (`preserveWorktree`: a peer-to-peer speaker,
 * a critic-loop actor, a tournament or MCTS candidate) gets `deferred` and
 * settles it itself with `mergeBackDeferred` / `settleCompetingWorktrees`.
 */

export const MERGE_BACK_STATUS_MESSAGE = "merge_back";

const KEPT_STATUSES = new Set<MergeBackReport["status"]>([
  "conflict",
  "failed",
]);

/** The work was not merged and is still on its branch, for someone to act on. */
export function isMergeBackKept(report: MergeBackReport | undefined): boolean {
  return !!report && KEPT_STATUSES.has(report.status);
}

function resetReport(subAgent: SubAgentState): MergeBackReport {
  // One object per sub-agent, shared by reference with every result built
  // from it, so a router settling a deferred worktree updates them all.
  const report = subAgent.mergeBack ?? ({} as MergeBackReport);
  delete report.conflictingFiles;
  delete report.error;
  Object.assign(report, {
    status: "deferred",
    branch: subAgent.branchName!,
    repositoryPath: subAgent.repositoryPath,
    worktreePath: subAgent.worktreePath,
    branchDeleted: false,
  } satisfies MergeBackReport);
  subAgent.mergeBack = report;
  return report;
}

function keep(
  report: MergeBackReport,
  status: "conflict" | "failed",
  error: string,
  conflictingFiles?: string[],
): MergeBackReport {
  report.status = status;
  report.error = error;
  if (conflictingFiles?.length) report.conflictingFiles = conflictingFiles;
  logger.warn(
    `[MergeBack] ${status}: kept worktree ${report.worktreePath} on branch ${report.branch} — ${error}`,
  );
  return report;
}

/** Tell the parent's stream that a sub-agent's work was kept, not merged. */
function emitKept(
  emit: EmitFunction | null | undefined,
  agentId: string,
  conversationId: string | null,
  report: MergeBackReport,
): void {
  if (!emit || !isMergeBackKept(report)) return;
  emit({
    type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
    subAgentId: agentId,
    message: MERGE_BACK_STATUS_MESSAGE,
    conversationId,
    mergeBack: { ...report },
  });
}

/**
 * Merge a committed branch into its repository, then remove the worktree and
 * delete the branch. A refused merge keeps both.
 */
async function mergeThenCleanUp(
  report: MergeBackReport,
  hasChanges: boolean,
  mergeMessage: string,
): Promise<MergeBackReport> {
  if (hasChanges) {
    const merge = await GitWorktreeHelper.mergeWorktree(
      report.repositoryPath,
      report.branch,
      mergeMessage,
    );
    if (merge.error) {
      return keep(
        report,
        merge.reason ? "conflict" : "failed",
        merge.error,
        merge.conflictingFiles,
      );
    }
  }
  report.status = hasChanges ? "merged" : "no-changes";

  if (report.worktreePath) {
    const removal = await GitWorktreeHelper.removeWorktree(
      report.repositoryPath,
      report.worktreePath,
    );
    if (removal.error) {
      report.error = `Cleanup kept the worktree: ${removal.error}`;
      logger.warn(`[MergeBack] ${report.error}`);
      return report;
    }
    report.worktreePath = null;
    report.branchDeleted = removal.branchDeleted === true;
    if (removal.branchError) report.error = removal.branchError;
  }
  return report;
}

/**
 * Once its report says the worktree is gone (removed here, or by a router
 * settling a deferred one), the sub-agent no longer runs isolated: a later
 * resume works in the parent's workspace, where its merged work now lives.
 */
export function syncWorktreeState(subAgent: SubAgentState): void {
  if (subAgent.mergeBack?.worktreePath === null && subAgent.worktreePath) {
    subAgent.worktreePath = null;
    subAgent.isolated = false;
  }
}

/**
 * Settle an isolated sub-agent's worktree at the end of its loop: commit,
 * diff, and — unless `defer` — merge back and clean up. Returns null for a
 * sub-agent that ran without a worktree.
 */
export async function settleSubAgentWorktree(
  subAgent: SubAgentState,
  { defer, emit }: { defer: boolean; emit?: EmitFunction | null },
): Promise<MergeBackReport | null> {
  if (!subAgent.isolated || !subAgent.worktreePath || !subAgent.branchName) {
    return null;
  }
  const report = resetReport(subAgent);

  const commit = await GitWorktreeHelper.commitWorktree(
    report.repositoryPath,
    subAgent.worktreePath,
    `orchestrator: ${subAgent.agentId} — ${subAgent.description}`,
  );
  if (commit.error) {
    subAgent.diff = null;
    keep(report, "failed", `Commit failed: ${commit.error}`);
  } else {
    const diff = await GitWorktreeHelper.getWorktreeDiff(
      report.repositoryPath,
      report.branch,
    );
    if ("error" in diff) {
      subAgent.diff = null;
      keep(report, "failed", `Diff failed: ${diff.error}`);
    } else {
      subAgent.diff = diff;
      if (!defer) {
        await mergeThenCleanUp(
          report,
          diff.files.length > 0,
          `Merge sub-agent ${subAgent.agentId}: ${subAgent.description}`,
        );
      }
    }
  }

  syncWorktreeState(subAgent);
  emitKept(emit, subAgent.agentId, subAgent.subAgentConversationId, report);
  return report;
}

/**
 * Merge back a worktree its owner deferred (`preserveWorktree`), now that the
 * owner is done with it. The loop already committed and diffed it.
 */
export async function mergeBackDeferred(
  result: SubAgentResult,
  emit?: EmitFunction | null,
): Promise<MergeBackReport | undefined> {
  const report = result.mergeBack;
  if (!report || report.status !== "deferred") return report;
  await mergeThenCleanUp(
    report,
    (result.diff?.files.length ?? 0) > 0,
    `Merge sub-agent ${result.agent_id}: ${result.description}`,
  );
  emitKept(emit, result.agent_id, null, report);
  return report;
}

/**
 * Retire a deferred worktree without merging it: the worktree directory goes;
 * the branch goes only if it holds nothing HEAD lacks, and otherwise stays
 * with the work on it. For a candidate that lost, or a scratch verifier.
 */
async function retireDeferred(result: SubAgentResult): Promise<void> {
  const report = result.mergeBack;
  if (!report || report.status !== "deferred" || !report.worktreePath) return;
  report.status = "not-selected";
  let removal = await GitWorktreeHelper.removeWorktree(
    report.repositoryPath,
    report.worktreePath,
  );
  if (removal.kept) {
    // Unique commits: keep them on the branch, drop only the directory.
    removal = await GitWorktreeHelper.removeWorktree(
      report.repositoryPath,
      report.worktreePath,
      { deleteBranch: false },
    );
  }
  if (removal.error) {
    report.error = `Cleanup kept the worktree: ${removal.error}`;
    logger.warn(`[MergeBack] ${report.error}`);
    return;
  }
  report.worktreePath = null;
  report.branchDeleted = removal.branchDeleted === true;
}

/**
 * Each deferred worktree once, through its latest result (a continued agent
 * shares one report across all its turns; its last turn is the one to act on).
 */
function latestPerWorktree(
  results: (SubAgentResult | { error: string })[],
): SubAgentResult[] {
  const seen = new Set<MergeBackReport>();
  const latest: SubAgentResult[] = [];
  for (const result of [...results].reverse()) {
    if ("error" in result || !result.mergeBack) continue;
    if (seen.has(result.mergeBack)) continue;
    seen.add(result.mergeBack);
    latest.push(result);
  }
  return latest;
}

/**
 * Merge a deferred worktree's branch now but keep the worktree for the agent's
 * next turn (peer-to-peer). A refused merge marks the report kept.
 */
export async function mergeDeferredKeepingWorktree(
  result: SubAgentResult,
  emit?: EmitFunction | null,
): Promise<MergeBackReport | undefined> {
  const report = result.mergeBack;
  if (!report || report.status !== "deferred" || !result.diff?.files.length) {
    return report;
  }
  const merge = await GitWorktreeHelper.mergeWorktree(
    report.repositoryPath,
    report.branch,
    `Merge sub-agent ${result.agent_id}: ${result.description}`,
  );
  if (merge.error) {
    keep(report, merge.reason ? "conflict" : "failed", merge.error, merge.conflictingFiles);
    emitKept(emit, result.agent_id, null, report);
  }
  return report;
}

/** For topologies whose members collaborate: merge back every deferred worktree. */
export async function mergeBackAllDeferred(
  results: (SubAgentResult | { error: string })[],
  emit?: EmitFunction | null,
): Promise<void> {
  for (const result of latestPerWorktree(results)) {
    await mergeBackDeferred(result, emit);
  }
}

/**
 * For topologies whose members compete (tournament, MCTS, a critic-loop jury):
 * merge the winner's deferred worktree and retire every other one, keeping its
 * branch. With no winner nothing is merged and every branch is kept.
 */
export async function settleCompetingWorktrees(
  results: (SubAgentResult | { error: string })[],
  winnerAgentId: string | null,
  emit?: EmitFunction | null,
): Promise<void> {
  for (const result of latestPerWorktree(results)) {
    if (result.agent_id === winnerAgentId) {
      await mergeBackDeferred(result, emit);
    } else {
      await retireDeferred(result);
    }
  }
}

/** One line for the parent when a sub-agent's work was not merged. */
export function describeKeptWork(report: MergeBackReport, locale: string): string {
  return PromptLocaleService.get(
    locale,
    "orchestrator.notifications.mergeBackKept",
    {
      status: report.status,
      files: report.conflictingFiles?.length
        ? `: ${report.conflictingFiles.join(", ")}`
        : "",
      branch: report.branch,
      location: report.worktreePath
        ? `worktree ${report.worktreePath} of ${report.repositoryPath}`
        : report.repositoryPath,
      error: report.error ?? "",
    },
  ).trim();
}
