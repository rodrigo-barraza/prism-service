import logger from "../utils/logger.ts";

/**
 * Tool approval tiers — deterministic, rule-based permission system.
 *
 * Tier 1 (AUTO):    Read-only tools, always execute without prompting.
 * Tier 2 (WRITE):   Write tools, auto-approve in "Full Auto" mode, otherwise prompt.
 * Tier 3 (DANGER):  Destructive / arbitrary execution, always prompt unless Full Auto.
 */
export const APPROVAL_TIERS = {
  AUTO: 1,
  WRITE: 2,
  DANGER: 3,
};

/** Default tier assignments for built-in tools */
const DEFAULT_TIER_MAP = {
  // Tier 1 — read-only
  read_file: APPROVAL_TIERS.AUTO,
  list_directory: APPROVAL_TIERS.AUTO,
  grep_search: APPROVAL_TIERS.AUTO,
  glob_files: APPROVAL_TIERS.AUTO,
  web_search: APPROVAL_TIERS.AUTO,
  fetch_url: APPROVAL_TIERS.AUTO,
  multi_file_read: APPROVAL_TIERS.AUTO,
  file_info: APPROVAL_TIERS.AUTO,
  file_diff: APPROVAL_TIERS.AUTO,
  git_status: APPROVAL_TIERS.AUTO,
  git_diff: APPROVAL_TIERS.AUTO,
  git_log: APPROVAL_TIERS.AUTO,
  project_summary: APPROVAL_TIERS.AUTO,

  // Tier 1 — task management (agent's own scratchpad, not user files)
  task_create: APPROVAL_TIERS.AUTO,
  task_get: APPROVAL_TIERS.AUTO,
  task_list: APPROVAL_TIERS.AUTO,
  task_update: APPROVAL_TIERS.AUTO,

  // Tier 1 — coordinator orchestration
  team_create: APPROVAL_TIERS.AUTO,
  send_message: APPROVAL_TIERS.AUTO,
  stop_agent: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  upsert_memory: APPROVAL_TIERS.AUTO,

  // Tier 1 — control flow (no side effects)
  sleep: APPROVAL_TIERS.AUTO,
  enter_plan_mode: APPROVAL_TIERS.AUTO,
  exit_plan_mode: APPROVAL_TIERS.AUTO,
  tool_search: APPROVAL_TIERS.AUTO,

  // Tier 2 — scheduling / notebook (creates persistent state)
  cron_create: APPROVAL_TIERS.WRITE,
  remote_trigger: APPROVAL_TIERS.WRITE,
  notebook_edit: APPROVAL_TIERS.WRITE,

  // Tier 1 — skill management (read-only discovery)
  skill_list: APPROVAL_TIERS.AUTO,

  // Tier 1 — structured output (data formatting only)
  synthetic_output: APPROVAL_TIERS.AUTO,

  // Tier 2 — skill mutations + execution
  skill_create: APPROVAL_TIERS.WRITE,
  skill_execute: APPROVAL_TIERS.WRITE,
  skill_delete: APPROVAL_TIERS.WRITE,

  // Tier 2 — team deletion (stops workers)
  team_delete: APPROVAL_TIERS.WRITE,

  // Tier 2 — worktree isolation (creates/merges git branches)
  enter_worktree: APPROVAL_TIERS.WRITE,
  exit_worktree: APPROVAL_TIERS.WRITE,

  // Tier 2 — write operations
  write_file: APPROVAL_TIERS.WRITE,
  str_replace_file: APPROVAL_TIERS.WRITE,
  patch_file: APPROVAL_TIERS.WRITE,
  move_file: APPROVAL_TIERS.WRITE,
  delete_file: APPROVAL_TIERS.WRITE,
  browser_action: APPROVAL_TIERS.WRITE,

  // Tier 3 — destructive / arbitrary execution
  execute_shell: APPROVAL_TIERS.DANGER,
  execute_python: APPROVAL_TIERS.DANGER,
  execute_javascript: APPROVAL_TIERS.DANGER,
  run_command: APPROVAL_TIERS.DANGER,
};

const TIER_LABELS = {
  [APPROVAL_TIERS.AUTO]: "auto",
  [APPROVAL_TIERS.WRITE]: "write",
  [APPROVAL_TIERS.DANGER]: "danger",
};

/**
 * AutoApprovalEngine — determines whether a tool call should auto-execute
 * or require user approval.
 *
 * Registered as a `beforeToolCall` hook in AgentHooks.
 */
export default class AutoApprovalEngine {
  constructor(options: any = {}) {
        (this as any).fullAuto = options.fullAuto || false;
        (this as any).tierOverrides = options.tierOverrides || {};
  }

  /**
   * Get the approval tier for a tool.

   * @returns {number} Tier constant (1, 2, or 3)
   */
  getTier(toolName: any) {
        if ((this as any).tierOverrides[toolName] !== undefined) {
            return (this as any).tierOverrides[toolName];
    }
        return (DEFAULT_TIER_MAP as any)[(toolName as string)] ?? APPROVAL_TIERS.WRITE; // Unknown tools default to Tier 2
  }

  /**
   * Get the tier label for a tool.


   */
  getTierLabel(toolName: any) {
    return TIER_LABELS[this.getTier(toolName)] || "write";
  }

  /**
   * Check whether a tool call should auto-execute.
   *

   * @returns {{ approved: boolean, tier: number, tierLabel: string, reason: string }}
   */
  check(toolCall: any) {
        const tier = this.getTier((toolCall.name as any));
    const tierLabel = TIER_LABELS[tier] || "write";

    // Full Auto mode: everything runs
        if ((this as any).fullAuto) {
      return { approved: true, tier, tierLabel, reason: "full_auto" };
    }

    // Tier 1: always auto-approve
    if (tier === APPROVAL_TIERS.AUTO) {
      return { approved: true, tier, tierLabel, reason: "read_only" };
    }

    // Tier 2 and 3: require approval
    return { approved: false, tier, tierLabel, reason: "requires_approval" };
  }

  /**
   * Check a batch of tool calls. Returns the ones needing approval.
   *

   * @returns {{ autoApproved: Array, needsApproval: Array }}
   */
  checkBatch(toolCalls: any) {
    const autoApproved: any[] = [];
    const needsApproval: any[] = [];

        for ( const tc of toolCalls) {
      const result = this.check(tc);
      if (result.approved) {
        autoApproved.push({ ...tc, _approval: result });
      } else {
        needsApproval.push({ ...tc, _approval: result });
      }
    }

    if (needsApproval.length > 0) {
      logger.info(
        `[AutoApproval] ${autoApproved.length} auto-approved, ${needsApproval.length} need approval: ${needsApproval.map((t: any) => t.name).join(", ")}`,
      );
    }

    return { autoApproved, needsApproval };
  }

  /**
   * Create a beforeToolCall hook handler for AgentHooks.

   */
  createHook() {
    return async (toolCall: any, _ctx: any) => {
      return this.check(toolCall);
    };
  }
}
