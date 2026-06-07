import logger from "../utils/logger.ts";
import type { ToolCall, AgenticContext } from "./harnesses/types.ts";
import PolicyEngine from "./PolicyEngine.ts";
import type { PolicyRule } from "./PolicyEngine.ts";

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
} as const;

type ApprovalTier = typeof APPROVAL_TIERS[keyof typeof APPROVAL_TIERS];

/** Default tier assignments for built-in tools */
const DEFAULT_TIER_MAP: Record<string, ApprovalTier> = {
  // Tier 1 — read-only
  read_file: APPROVAL_TIERS.AUTO,
  list_directory: APPROVAL_TIERS.AUTO,
  search_file_contents: APPROVAL_TIERS.AUTO,
  find_files: APPROVAL_TIERS.AUTO,
  search_web: APPROVAL_TIERS.AUTO,
  read_web_page: APPROVAL_TIERS.AUTO,
  read_files: APPROVAL_TIERS.AUTO,
  get_file_info: APPROVAL_TIERS.AUTO,
  diff_files: APPROVAL_TIERS.AUTO,
  git_status: APPROVAL_TIERS.AUTO,
  git_diff: APPROVAL_TIERS.AUTO,
  git_log: APPROVAL_TIERS.AUTO,
  summarize_project: APPROVAL_TIERS.AUTO,

  // Tier 1 — task management (agent's own scratchpad, not user files)
  create_task: APPROVAL_TIERS.AUTO,
  get_task: APPROVAL_TIERS.AUTO,
  list_tasks: APPROVAL_TIERS.AUTO,
  update_task: APPROVAL_TIERS.AUTO,
  get_task_output: APPROVAL_TIERS.AUTO,
  write_todo: APPROVAL_TIERS.AUTO,

  // Tier 1 — orchestrator orchestration
  create_team: APPROVAL_TIERS.AUTO,
  send_message: APPROVAL_TIERS.AUTO,
  stop_agent: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  upsert_memory: APPROVAL_TIERS.AUTO,

  // Tier 1 — control flow (no side effects)
  sleep: APPROVAL_TIERS.AUTO,
  enter_plan_mode: APPROVAL_TIERS.AUTO,
  exit_plan_mode: APPROVAL_TIERS.AUTO,
  search_tools: APPROVAL_TIERS.AUTO,

  // Tier 2 — scheduling / notebook (creates persistent state)
  create_cron: APPROVAL_TIERS.WRITE,
  remote_trigger: APPROVAL_TIERS.WRITE,
  create_cron_job: APPROVAL_TIERS.WRITE,
  list_cron_jobs: APPROVAL_TIERS.WRITE,
  delete_cron_job: APPROVAL_TIERS.WRITE,
  trigger_cron_job: APPROVAL_TIERS.WRITE,
  edit_notebook: APPROVAL_TIERS.WRITE,

  // Tier 1 — skill management (read-only discovery)
  list_skills: APPROVAL_TIERS.AUTO,

  // Tier 1 — structured output (data formatting only)
  emit_structured_output: APPROVAL_TIERS.AUTO,

  // Tier 2 — skill mutations + execution
  create_skill: APPROVAL_TIERS.WRITE,
  execute_skill: APPROVAL_TIERS.WRITE,
  delete_skill: APPROVAL_TIERS.WRITE,

  // Tier 2 — team deletion (stops sub-agents)
  delete_team: APPROVAL_TIERS.WRITE,

  // Tier 2 — worktree isolation (creates/merges git branches)
  enter_worktree: APPROVAL_TIERS.WRITE,
  exit_worktree: APPROVAL_TIERS.WRITE,

  // Tier 2 — write operations
  write_file: APPROVAL_TIERS.WRITE,
  replace_in_file: APPROVAL_TIERS.WRITE,
  patch_file: APPROVAL_TIERS.WRITE,
  move_file: APPROVAL_TIERS.WRITE,
  delete_file: APPROVAL_TIERS.WRITE,
  control_browser: APPROVAL_TIERS.WRITE,

  // Tier 3 — destructive / arbitrary execution
  execute_shell: APPROVAL_TIERS.DANGER,
  execute_python: APPROVAL_TIERS.DANGER,
  execute_javascript: APPROVAL_TIERS.DANGER,
  execute_command: APPROVAL_TIERS.DANGER,
};

const TIER_LABELS: Record<number, string> = {
  [APPROVAL_TIERS.AUTO]: "auto",
  [APPROVAL_TIERS.WRITE]: "write",
  [APPROVAL_TIERS.DANGER]: "danger",
};

export interface ApprovalResult {
  approved: boolean;
  tier: ApprovalTier;
  tierLabel: string;
  reason: string;
}

export interface ApprovedToolCall extends Omit<ToolCall, '_approval'> {
  _approval: ApprovalResult;
}

export interface AutoApprovalEngineOptions {
  fullAuto?: boolean;
  tierOverrides?: Record<string, ApprovalTier>;
  /** Declarative policies evaluated before the tier system. */
  policies?: PolicyRule[];
}

/**
 * AutoApprovalEngine — determines whether a tool call should auto-execute
 * or require user approval.
 *
 * Registered as a `beforeToolCall` hook in AgentHooks.
 */
export default class AutoApprovalEngine {
  private fullAuto: boolean;
  private tierOverrides: Record<string, ApprovalTier>;
  private policies: PolicyRule[];

  constructor(options: AutoApprovalEngineOptions = {}) {
    this.fullAuto = options.fullAuto || false;
    this.tierOverrides = options.tierOverrides || {};
    this.policies = options.policies || [];
  }
  getTier(toolName: string): ApprovalTier {
    if (this.tierOverrides[toolName] !== undefined) {
      return this.tierOverrides[toolName];
    }
    return DEFAULT_TIER_MAP[toolName] ?? APPROVAL_TIERS.WRITE; // Unknown tools default to Tier 2
  }
  getTierLabel(toolName: string): string {
    return TIER_LABELS[this.getTier(toolName)] || "write";
  }
  check(toolCall: ToolCall): ApprovalResult {
    const tier = this.getTier(toolCall.name);
    const tierLabel = TIER_LABELS[tier] || "write";

    // Full Auto mode: everything runs
    if (this.fullAuto) {
      return { approved: true, tier, tierLabel, reason: "full_auto" };
    }

    // ── Policy evaluation (takes precedence over tier system) ──
    if (this.policies.length > 0) {
      const policyResult = PolicyEngine.evaluate(
        this.policies,
        toolCall.name,
        toolCall.args as Record<string, unknown>,
      );
      if (policyResult) {
        switch (policyResult.decision) {
          case "APPROVE":
            return { approved: true, tier, tierLabel, reason: policyResult.reason };
          case "DENY":
            return { approved: false, tier, tierLabel, reason: policyResult.reason };
          case "ASK_USER":
            return { approved: false, tier, tierLabel, reason: policyResult.reason };
        }
      }
      // No policy matched — fall through to tier system
    }

    // Tier 1: always auto-approve
    if (tier === APPROVAL_TIERS.AUTO) {
      return { approved: true, tier, tierLabel, reason: "read_only" };
    }

    // Tier 2 and 3: require approval
    return { approved: false, tier, tierLabel, reason: "requires_approval" };
  }
  checkBatch(toolCalls: ToolCall[]): { autoApproved: ApprovedToolCall[]; needsApproval: ApprovedToolCall[] } {
    const autoApproved: ApprovedToolCall[] = [];
    const needsApproval: ApprovedToolCall[] = [];

    for (const toolCall of toolCalls) {
      const result = this.check(toolCall);
      if (result.approved) {
        autoApproved.push({ ...toolCall, _approval: result });
      } else {
        needsApproval.push({ ...toolCall, _approval: result });
      }
    }

    if (needsApproval.length > 0) {
      logger.info(
        `[AutoApproval] ${autoApproved.length} auto-approved, ${needsApproval.length} need approval: ${needsApproval.map((t) => t.name).join(", ")}`,
      );
    }

    return { autoApproved, needsApproval };
  }
  createHook() {
    return async (toolCall: ToolCall, _ctx: AgenticContext) => {
      return this.check(toolCall);
    };
  }
}
