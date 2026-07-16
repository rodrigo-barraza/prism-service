import logger from "#src/utils/logger";
import type { ToolCall, AgenticContext } from "./harnesses/types.ts";
import PolicyEngine from "./PolicyEngine.ts";
import type { PolicyRule } from "./PolicyEngine.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

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

type ApprovalTier = (typeof APPROVAL_TIERS)[keyof typeof APPROVAL_TIERS];

/** Default tier assignments for built-in tools */
const DEFAULT_TIER_MAP: Record<string, ApprovalTier> = {
  // Tier 1 — read-only
  [TOOL_NAMES.READ_FILE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.LIST_DIRECTORY]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_FILE_CONTENTS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.FIND_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_WEB]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.READ_WEB_PAGE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.READ_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_FILE_INFO]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.DIFF_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_STATUS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_DIFF]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_LOG]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SUMMARIZE_PROJECT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — task management (agent's own scratchpad, not user files)
  [TOOL_NAMES.CREATE_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.LIST_TASKS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.UPDATE_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_SUBAGENT_OUTPUT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.WRITE_TODO]: APPROVAL_TIERS.AUTO,

  // Tier 1 — orchestrator orchestration
  [TOOL_NAMES.CREATE_SUBAGENT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.CREATE_SUBAGENTS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEND_SUBAGENT_MESSAGE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.STOP_SUBAGENT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.RESUME_SUBAGENT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  [TOOL_NAMES.SAVE_MEMORY]: APPROVAL_TIERS.AUTO,

  // Tier 1 — control flow (no side effects)
  [TOOL_NAMES.SLEEP]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.ENTER_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.EXIT_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_TOOLS]: APPROVAL_TIERS.AUTO,

  // Tier 1 — context recovery (read-only over offloaded tool results)
  [TOOL_NAMES.RETRIEVE_OFFLOADED_CONTENT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — model-invoked compaction (summarizes the agent's own
  // context; no external side effects)
  [TOOL_NAMES.COMPACT_CONTEXT]: APPROVAL_TIERS.AUTO,

  // Tier 2 — scheduling / notebook (creates persistent state)
  [TOOL_NAMES.CREATE_CRON]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.REMOTE_TRIGGER]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.CREATE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.LIST_CRON_JOBS]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.TRIGGER_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EDIT_NOTEBOOK]: APPROVAL_TIERS.WRITE,

  // Tier 1 — skill management (read-only discovery)
  [TOOL_NAMES.LIST_SKILLS]: APPROVAL_TIERS.AUTO,

  // Tier 1 — structured output (data formatting only)
  [TOOL_NAMES.EMIT_STRUCTURED_OUTPUT]: APPROVAL_TIERS.AUTO,

  // Tier 2 — skill mutations + execution
  [TOOL_NAMES.CREATE_SKILL]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EXECUTE_SKILL]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_SKILL]: APPROVAL_TIERS.WRITE,

  // Tier 2 — team deletion (stops sub-agents)
  [TOOL_NAMES.DELETE_SUBAGENTS]: APPROVAL_TIERS.WRITE,

  // Tier 2 — worktree isolation (creates/merges git branches)
  [TOOL_NAMES.ENTER_WORKTREE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EXIT_WORKTREE]: APPROVAL_TIERS.WRITE,

  // Tier 2 — write operations
  [TOOL_NAMES.WRITE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.REPLACE_IN_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.PATCH_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.MOVE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.CONTROL_BROWSER]: APPROVAL_TIERS.WRITE,

  // Tier 3 — destructive / arbitrary execution
  [TOOL_NAMES.EXECUTE_SHELL]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_PYTHON]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_JAVASCRIPT]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_COMMAND]: APPROVAL_TIERS.DANGER,
};

const TIER_LABELS: Record<number, string> = {
  [APPROVAL_TIERS.AUTO]: "auto",
  [APPROVAL_TIERS.WRITE]: "write",
  [APPROVAL_TIERS.DANGER]: "danger",
};

export interface ApprovalResult {
  isApproved: boolean;
  /**
   * Terminal rejection: a policy DENY that must never be presented to the
   * user for approval. Denied calls are rejected outright, even in
   * full-auto mode and inside sub-agents.
   */
  isDenied?: boolean;
  tier: ApprovalTier;
  tierLabel: string;
  reason: string;
}

export interface ApprovedToolCall extends Omit<ToolCall, "_approval"> {
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
    // SECURITY: MCP-namespaced tools are third-party code with unknown
    // side effects — they default to DANGER (Tier 3) so common
    // WRITE-auto settings never silently auto-approve them. Trusted
    // servers can be relaxed per-tool via tierOverrides.
    // Research basis (harness_landscape_survey_2026-07.md, D4): VIPER-MCP
    // found 106 zero-days across ~40k MCP repos (arXiv 2605.21392,
    // https://arxiv.org/abs/2605.21392); see also Unit 42's OpenClaw
    // supply-chain report (cited in MCPClientService).
    if (toolName.startsWith("mcp__")) {
      return APPROVAL_TIERS.DANGER;
    }
    return DEFAULT_TIER_MAP[toolName] ?? APPROVAL_TIERS.WRITE; // Unknown tools default to Tier 2
  }
  getTierLabel(toolName: string): string {
    return TIER_LABELS[this.getTier(toolName)] || "write";
  }
  check(toolCall: ToolCall): ApprovalResult {
    const tier = this.getTier(toolCall.name);
    const tierLabel = TIER_LABELS[tier] || "write";

    // ── Policy evaluation (takes precedence over tier system AND full
    // auto — a defensive DENY policy must hold even when everything else
    // auto-approves, otherwise full-auto/sub-agent runs bypass it) ──
    if (this.policies.length > 0) {
      const policyResult = PolicyEngine.evaluate(
        this.policies,
        toolCall.name,
        toolCall.args as Record<string, unknown>,
      );
      if (policyResult) {
        switch (policyResult.decision) {
          case "APPROVE":
            return {
              isApproved: true,
              tier,
              tierLabel,
              reason: policyResult.reason,
            };
          case "DENY":
            // Terminal rejection — never downgraded to an approval prompt.
            return {
              isApproved: false,
              isDenied: true,
              tier,
              tierLabel,
              reason: policyResult.reason,
            };
          case "ASK_USER":
            if (this.fullAuto) break; // full auto answers "ask user" with yes
            return {
              isApproved: false,
              tier,
              tierLabel,
              reason: policyResult.reason,
            };
        }
      }
      // No policy matched (or full-auto ASK_USER) — fall through to tier system
    }

    // Full Auto mode: everything not policy-denied runs
    if (this.fullAuto) {
      return { isApproved: true, tier, tierLabel, reason: "full_auto" };
    }

    // Tier 1: always auto-approve
    if (tier === APPROVAL_TIERS.AUTO) {
      return { isApproved: true, tier, tierLabel, reason: "read_only" };
    }

    // Tier 2 and 3: require approval
    return { isApproved: false, tier, tierLabel, reason: "requires_approval" };
  }
  checkBatch(toolCalls: ToolCall[]): {
    autoApproved: ApprovedToolCall[];
    needsApproval: ApprovedToolCall[];
    denied: ApprovedToolCall[];
  } {
    const autoApproved: ApprovedToolCall[] = [];
    const needsApproval: ApprovedToolCall[] = [];
    const denied: ApprovedToolCall[] = [];

    for (const toolCall of toolCalls) {
      const result = this.check(toolCall);
      // Stamp the approval onto the ORIGINAL tool call object, not just the
      // categorized copy — downstream consumers (ToolExecutor's hook pass,
      // CriticGate's tier check) receive the originals, and without the stamp
      // CriticGate sees every call as WRITE tier and never reviews anything.
      toolCall._approval = result;
      if (result.isDenied) {
        denied.push({ ...toolCall, _approval: result });
      } else if (result.isApproved) {
        autoApproved.push({ ...toolCall, _approval: result });
      } else {
        needsApproval.push({ ...toolCall, _approval: result });
      }
    }

    if (needsApproval.length > 0 || denied.length > 0) {
      logger.info(
        `[AutoApproval] ${autoApproved.length} auto-approved, ${needsApproval.length} need approval` +
          (needsApproval.length
            ? `: ${needsApproval.map((approvedToolCall) => approvedToolCall.name).join(", ")}`
            : "") +
          (denied.length
            ? `; ${denied.length} denied by policy: ${denied.map((deniedToolCall) => deniedToolCall.name).join(", ")}`
            : ""),
      );
    }

    return { autoApproved, needsApproval, denied };
  }
  createHook() {
    return async (toolCall: ToolCall, context: AgenticContext) => {
      // A prior explicit decision (user approval via the ApprovalGate, or a
      // policy DENY) is authoritative — re-running check() here would
      // wrongly veto calls the user just approved.
      const priorApproval = toolCall._approval as ApprovalResult | undefined;
      if (priorApproval && typeof priorApproval.isApproved === "boolean") {
        return priorApproval;
      }
      // Mid-loop "approve all" flips options.autoApprove without rebuilding
      // this engine — honor it so already-permitted calls aren't blocked.
      if (context?.options?.autoApprove && !this.fullAuto) {
        const result = this.check(toolCall);
        if (result.isDenied) return result;
        return { ...result, isApproved: true, reason: "approve_all" };
      }
      return this.check(toolCall);
    };
  }
}
