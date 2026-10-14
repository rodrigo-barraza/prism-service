import type { WorktreeCreateResponse } from "#src/types/orchestrator";

/**
 * The one worktree-create failure a sub-agent may answer by working in the
 * shared directory: there is no repository to isolate it in (tools-service's
 * or a bridge's reason "not-a-repository", or git's own words). Anything
 * else — a bridge offline or too old to make worktrees, a git error — and
 * the sub-agent is not started (OrchestratorService).
 */
export function isNoRepository(result: WorktreeCreateResponse): boolean {
  return result.reason === "not-a-repository" || /not a git repository/i.test(result.error ?? "");
}
