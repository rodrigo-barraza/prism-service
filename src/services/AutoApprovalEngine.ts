import logger from "#src/utils/logger";
import type { ToolCall, AgenticContext } from "./harnesses/types.ts";
import PolicyEngine from "./PolicyEngine.ts";
import type { PolicyRule, PolicyDecision } from "./PolicyEngine.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type PermissionRuleSet from "./permissions/PermissionRuleSet.ts";
import { resolveToolCapabilities } from "./permissions/ToolCapabilities.ts";
import { lookupMcpTool } from "./mcp/McpToolRegistry.ts";
import { toMcpScope } from "./mcp/McpScope.ts";
import { checkSelfProtection } from "./permissions/SelfProtection.ts";
import { strongestVerdict } from "./permissions/PermissionEvaluator.ts";
import { recordUserApproval } from "./permissions/ApprovalHistory.ts";
import {
  isPlanSafe,
  isWorkspaceEdit,
  planModeDenialReason,
  requiresUserInteraction,
  unattendedDenialReason,
  userInteractionDenialReason,
  type PermissionMode,
} from "./permissions/PermissionModes.ts";
import { modeOf, type PermissionModeHandle } from "./permissions/PermissionModeState.ts";
import { findProtectedPathWrite } from "./permissions/ProtectedPaths.ts";
import type {
  Capability,
  PermissionDecision,
  PermissionLayer,
  PermissionScope,
  PermissionVerdict,
} from "./permissions/types.ts";

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
  // Asking the user is not an action — the answer card IS the user's say.
  [TOOL_NAMES.ASK_USER]: APPROVAL_TIERS.AUTO,

  // Tier 1 — orchestrator orchestration
  [TOOL_NAMES.CREATE_SUBAGENT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.CREATE_SUBAGENTS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEND_SUBAGENT_MESSAGE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.STOP_SUBAGENT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.RESUME_SUBAGENT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  [TOOL_NAMES.SAVE_MEMORY]: APPROVAL_TIERS.AUTO,

  // Tier 1 — conversation goal metadata, bounded waits, read-only programs
  // (local tool names — see GoalTools / AsyncTaskConstants / RunToolProgramTool)
  // A proposal waits for the user's own card — no approval card before it.
  propose_goal: APPROVAL_TIERS.AUTO,
  update_goal: APPROVAL_TIERS.AUTO,
  clear_goal: APPROVAL_TIERS.AUTO,
  wait_for_tasks: APPROVAL_TIERS.AUTO,
  // run_tool_program only dispatches tier-AUTO tools itself (enforced inside)
  run_tool_program: APPROVAL_TIERS.AUTO,

  // Tier 1 — control flow (no side effects)
  [TOOL_NAMES.SLEEP]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.ENTER_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.EXIT_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_TOOLS]: APPROVAL_TIERS.AUTO,
  // Enabling or disabling tools only changes what the model is offered;
  // every tool it enables is still gated by its own tier when called.
  // Unmapped, these fell to WRITE and the first card of a CODING turn was
  // a prompt to look tools up.
  [TOOL_NAMES.ENABLE_TOOLS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.DISABLE_TOOLS]: APPROVAL_TIERS.AUTO,

  // Tier 1 — context recovery (read-only over offloaded tool results)
  [TOOL_NAMES.RETRIEVE_OFFLOADED_CONTENT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — model-invoked compaction (summarizes the agent's own
  // context; no external side effects)
  [TOOL_NAMES.COMPACT_CONTEXT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — checkpoint/rewind context pruning (no shell/file side
  // effects; only writes soft flags on the agent's own conversation
  // document — see CheckpointTools). Names are Prism-local strings,
  // not yet in the shared taxonomy's TOOL_NAMES.
  checkpoint: APPROVAL_TIERS.AUTO,
  rewind: APPROVAL_TIERS.AUTO,

  // Tier 2 — scheduling / notebook (creates persistent state)
  [TOOL_NAMES.CREATE_CRON]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.REMOTE_TRIGGER]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.CREATE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.LIST_CRON_JOBS]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.TRIGGER_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EDIT_NOTEBOOK]: APPROVAL_TIERS.WRITE,

  // Tier 1 — skill discovery and reading (read-only over the caller's
  // own skills; load_skill is Prism-local, not yet in TOOL_NAMES)
  [TOOL_NAMES.LIST_SKILLS]: APPROVAL_TIERS.AUTO,
  load_skill: APPROVAL_TIERS.AUTO,

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
  /** Which layer denied (set on every denial). */
  deniedBy?: "rule" | "classifier" | "hook" | "user" | "mode";
  tier: ApprovalTier;
  tierLabel: string;
  reason: string;
  /** Which layer of the permission stack decided (see permissions/types). */
  layer?: PermissionLayer;
  /** The rule (or policy name, or protected target) that decided, if any. */
  rule?: string;
  ruleId?: string;
  ruleScope?: PermissionScope;
  /** The permission mode the call was judged in. */
  mode?: PermissionMode;
  /**
   * An ask that "approve all" cannot answer — a protected path or a hook's
   * `ask`. Only a person's decision on the card lets it through.
   */
  alwaysAsks?: boolean;
  /** The protected path an `alwaysAsks` write names. */
  protectedPath?: string;
}

/** `check()` plus the evidence behind it — what the rules page's tester shows. */
export interface ApprovalExplanation extends ApprovalResult {
  capabilities: readonly Capability[];
  /** Every permission rule that matched, deciding rule first. */
  matchedRules: Array<{ id: string; rule: string; decision: PermissionDecision; scope: PermissionScope }>;
}

export interface ApprovedToolCall extends Omit<ToolCall, "_approval"> {
  _approval: ApprovalResult;
}

export interface AutoApprovalEngineOptions {
  fullAuto?: boolean;
  tierOverrides?: Record<string, ApprovalTier>;
  /** Declarative policies evaluated before the tier system. */
  policies?: PolicyRule[];
  /** The run's stored permission rules (`/permissions/rules`). */
  permissionRules?: PermissionRuleSet | null;
  /**
   * The run's permission mode — its live handle (read on every check, so a
   * mid-turn switch applies to the next call) or a fixed mode. Absent =
   * `default`.
   */
  permissionMode?: PermissionModeHandle | PermissionMode | null;
  /** The run's workspace root — where `acceptEdits` lets edits run. */
  workspaceRoot?: string | null;
}

const POLICY_DECISION: Record<PolicyDecision, PermissionDecision> = {
  APPROVE: "allow",
  ASK_USER: "ask",
  DENY: "deny",
};

/**
 * Whether an `_approval` stamp records a human's yes — the ApprovalGate's
 * `user_approved` reason, or a per-call `decidedBy: "user"`.
 */
function isUserApproval(approval: ApprovalResult): boolean {
  return (
    approval.reason === "user_approved" ||
    (approval as ApprovalResult & { decidedBy?: string }).decidedBy === "user"
  );
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
  private permissionRules: PermissionRuleSet | null;
  private permissionMode: PermissionModeHandle | PermissionMode | null;
  private workspaceRoot: string | null;

  constructor(options: AutoApprovalEngineOptions = {}) {
    this.fullAuto = options.fullAuto || false;
    this.tierOverrides = options.tierOverrides || {};
    this.policies = options.policies || [];
    this.permissionRules = options.permissionRules ?? null;
    this.permissionMode = options.permissionMode ?? null;
    this.workspaceRoot =
      options.workspaceRoot ?? options.permissionRules?.context.workspaceRoot ?? null;
  }

  /** The mode calls are judged in right now. */
  get mode(): PermissionMode {
    return modeOf(this.permissionMode);
  }

  /** Nobody can answer a card: `dontAsk`, or an unattended run in any mode. */
  private get cannotAsk(): boolean {
    const handle = this.permissionMode;
    return handle && typeof handle === "object" ? handle.cannotAsk : handle === "dontAsk";
  }
  getTier(toolName: string): ApprovalTier {
    if (this.tierOverrides[toolName] !== undefined) {
      return this.tierOverrides[toolName];
    }
    // SECURITY: MCP-namespaced tools are third-party code with unknown
    // side effects — they default to DANGER (Tier 3) so common
    // WRITE-auto settings never silently auto-approve them. The one way
    // down is a `readOnlyHint` on a server its owner marked trusted
    // (mcpTierFromAnnotations), looked up in the run's own scope;
    // `destructiveHint` is always DANGER, and rules and tierOverrides still
    // decide above the tier.
    // Research basis (harness_landscape_survey_2026-07.md, D4): VIPER-MCP
    // found 106 zero-days across ~40k MCP repos (arXiv 2605.21392,
    // https://arxiv.org/abs/2605.21392); see also Unit 42's OpenClaw
    // supply-chain report (cited in MCPClientService).
    if (toolName.startsWith("mcp__")) {
      return lookupMcpTool(toolName, toMcpScope(this.permissionRules?.identity))?.tier === "auto"
        ? APPROVAL_TIERS.AUTO
        : APPROVAL_TIERS.DANGER;
    }
    return DEFAULT_TIER_MAP[toolName] ?? APPROVAL_TIERS.WRITE; // Unknown tools default to Tier 2
  }
  getTierLabel(toolName: string): string {
    return TIER_LABELS[this.getTier(toolName)] || "write";
  }
  check(toolCall: ToolCall, overrides: { fullAuto?: boolean } = {}): ApprovalResult {
    const { matchedRules: _matchedRules, capabilities: _capabilities, ...result } =
      this.explain(toolCall, overrides);
    return result;
  }

  /**
   * The permission stack, top to bottom:
   *
   *   1. Self-protection — built in; an agent cannot reach its own
   *      permissions. Nothing below relaxes it.
   *   2. Deny — from permission rules or agent policies. Final in every
   *      mode, full auto and sub-agents included.
   *   3. The mode's refusals — `plan` refuses anything that is not
   *      read-only; a run nobody watches refuses tools that wait on a person.
   *   4. Protected paths — a write to one asks. Nothing below answers it:
   *      not an allow rule, not full auto, not `bypass`.
   *   5. Ask/allow — rules and policies together: deny > ask > allow across
   *      both layers, so a persona's APPROVE cannot undo a user's ASK. Full
   *      auto (the legacy "approve all") answers a rule's "ask" with yes;
   *      no mode does.
   *   6. Full auto — everything not stopped above runs.
   *   7. The mode — `bypass` runs everything; `acceptEdits` and `auto` run
   *      file edits inside the workspace.
   *   8. The tier — AUTO runs. For the rest, `auto` would consult its
   *      classifier (Landing 3; until then, and whenever it fails, it asks),
   *      and every other mode asks.
   *
   * Every "ask" is then checked against the run: where nobody can answer
   * (`dontAsk`, an unattended scheduled or timer run), it is a denial that
   * names what would have asked.
   *
   * The configured PreToolUse hooks ran before this (Claude Code's order:
   * hooks → rules → mode → ask) and stamped `_hookPermission`:
   *   - A rule DENY is final. No hook `allow` and no mode relaxes it.
   *   - A rule ASK asks, even when a hook said `allow` (and is answered
   *     "yes" by full auto unless a hook asked too).
   *   - A hook `ask` asks, whatever the rule, tier or mode — that is what it
   *     is for.
   *   - A hook `allow` stands in for the tier/mode prompt only.
   *
   * `overrides.fullAuto` judges the call as if "approve all" were on — the
   * mid-turn switch (options.autoApprove) without rebuilding the engine.
   *
   * Every result names the layer (and rule) that decided, and the mode.
   */
  explain(
    toolCall: ToolCall,
    { fullAuto = this.fullAuto }: { fullAuto?: boolean } = {},
  ): ApprovalExplanation {
    const tier = this.getTier(toolCall.name);
    const tierLabel = TIER_LABELS[tier] || "write";
    const mode = this.mode;
    const cannotAsk = this.cannotAsk;
    const hookPermission = toolCall._hookPermission;
    const hookAsks = hookPermission?.decision === "ask";
    const hookAskReason = `hook_ask${hookPermission?.reason ? `: ${hookPermission.reason}` : ""}`;
    const call = {
      name: toolCall.name,
      args: (toolCall.args ?? {}) as Record<string, unknown>,
    };
    const capabilities = resolveToolCapabilities(toolCall.name, toMcpScope(this.permissionRules?.identity));
    const base = {
      tier,
      tierLabel,
      mode,
      capabilities,
      matchedRules: [] as ApprovalExplanation["matchedRules"],
    };
    const deniedByMode = (reason: string): ApprovalExplanation => ({
      ...base,
      isApproved: false,
      isDenied: true,
      deniedBy: "mode",
      reason,
      layer: "mode",
    });
    // An ask where nobody can answer becomes a denial that names the ask.
    const ask = (result: Omit<ApprovalExplanation, "isApproved">): ApprovalExplanation =>
      cannotAsk
        ? {
            ...result,
            isApproved: false,
            isDenied: true,
            deniedBy: "mode",
            layer: "mode",
            reason: unattendedDenialReason(toolCall.name, mode, result.reason),
          }
        : { ...result, isApproved: false };

    const guard = checkSelfProtection(call, capabilities);
    if (guard) {
      return {
        ...base,
        isApproved: false,
        isDenied: true,
        deniedBy: "rule",
        reason: guard.reason,
        layer: "self_protection",
        rule: guard.target,
      };
    }

    const verdicts: PermissionVerdict[] = [];
    if (this.permissionRules) {
      const evaluation = this.permissionRules.explain(call, capabilities);
      base.matchedRules = evaluation.matched.map(({ id, rule, decision, scope }) => ({
        id,
        rule,
        decision,
        scope,
      }));
      if (evaluation.verdict) verdicts.push(evaluation.verdict);
    }
    if (this.policies.length > 0) {
      const policyResult = PolicyEngine.evaluate(this.policies, call.name, call.args);
      if (policyResult) {
        verdicts.push({
          decision: POLICY_DECISION[policyResult.decision],
          layer: "agent_policy",
          rule: policyResult.matchedPolicy.name || policyResult.matchedPolicy.tool,
          reason: policyResult.reason,
        });
      }
    }

    const decided = strongestVerdict(verdicts);
    const stamp = decided
      ? {
          ...base,
          reason: decided.reason,
          layer: decided.layer,
          ...(decided.rule !== undefined && { rule: decided.rule }),
          ...(decided.ruleId !== undefined && { ruleId: decided.ruleId }),
          ...(decided.scope !== undefined && { ruleScope: decided.scope }),
        }
      : null;
    if (decided?.decision === "deny") {
      // Terminal rejection — never downgraded to an approval prompt.
      return { ...stamp!, isApproved: false, isDenied: true, deniedBy: "rule" };
    }

    if (mode === "plan" && !isPlanSafe(capabilities)) {
      return deniedByMode(planModeDenialReason(toolCall.name));
    }
    if (cannotAsk && requiresUserInteraction(toolCall.name)) {
      return deniedByMode(userInteractionDenialReason(toolCall.name, mode));
    }

    const protectedWrite = findProtectedPathWrite(call, capabilities);
    if (protectedWrite) {
      return ask({
        ...base,
        reason: `protected path: ${protectedWrite.path} (${protectedWrite.target}) — writes to it always ask`,
        layer: "protected_path",
        rule: protectedWrite.target,
        alwaysAsks: true,
        protectedPath: protectedWrite.path,
      });
    }

    if (decided && stamp) {
      switch (decided.decision) {
        case "ask":
          if (!fullAuto || hookAsks) return ask({ ...stamp, ...(hookAsks && { alwaysAsks: true }) });
          break; // full auto answers "ask" with yes — unless a hook asked too
        case "allow":
          if (hookAsks) {
            return ask({ ...base, reason: hookAskReason, layer: "hook", alwaysAsks: true });
          }
          return { ...stamp, isApproved: true };
      }
    }

    if (hookAsks) {
      return ask({ ...base, reason: hookAskReason, layer: "hook", alwaysAsks: true });
    }
    if (hookPermission?.decision === "allow") {
      return { ...base, isApproved: true, reason: "hook_allow", layer: "hook" };
    }

    // Full Auto mode: everything not denied runs
    if (fullAuto) {
      return { ...base, isApproved: true, reason: "full_auto", layer: "full_auto" };
    }

    if (mode === "bypass") {
      return { ...base, isApproved: true, reason: "bypass_mode", layer: "mode" };
    }
    if (
      (mode === "acceptEdits" || mode === "auto") &&
      isWorkspaceEdit(call, capabilities, this.workspaceRoot)
    ) {
      return { ...base, isApproved: true, reason: "workspace_edit", layer: "mode" };
    }

    // Tier 1: always auto-approve
    if (tier === APPROVAL_TIERS.AUTO) {
      return { ...base, isApproved: true, reason: "read_only", layer: "tier" };
    }

    // The auto-mode classifier's slot. It isn't here yet (Landing 3), and a
    // classifier that cannot decide asks — it never allows.
    if (mode === "auto") {
      return ask({
        ...base,
        reason: "auto mode: the classifier is not available, so this asks",
        layer: "mode",
      });
    }

    // Tier 2 and 3: require approval
    return ask({ ...base, reason: "requires_approval", layer: "tier" });
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
        if (priorApproval.isApproved && isUserApproval(priorApproval)) {
          // A human said yes: name the layer, and log it so the rules page
          // can suggest the rule that would stop asking.
          const decided = { ...priorApproval, layer: "user" as const };
          toolCall._approval = decided;
          void recordUserApproval(
            {
              username: context?.username,
              profileId: context?.profileId,
              project: context?.project,
              conversationId: context?.conversationId,
              agent: context?.agent,
              workspaceRoot: context?.workspaceRoot,
            },
            { name: toolCall.name, args: (toolCall.args ?? {}) as Record<string, unknown> },
          );
          return decided;
        }
        return priorApproval;
      }
      // Mid-loop "approve all" flips options.autoApprove without rebuilding
      // this engine — honor it so already-permitted calls aren't blocked.
      if (context?.options?.autoApprove && !this.fullAuto) {
        const result = this.check(toolCall, { fullAuto: true });
        if (result.isDenied || !result.isApproved) return result; // a denial, or an ask no "approve all" answers
        return {
          ...result,
          reason: result.layer === "full_auto" ? "approve_all" : result.reason,
          layer: result.layer === "full_auto" ? "approve_all" : result.layer,
        };
      }
      return this.check(toolCall);
    };
  }
}
