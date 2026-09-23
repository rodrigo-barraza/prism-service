/**
 * Permission rules — shared vocabulary.
 *
 * A rule is one line of text (`execute_shell(git *)`, `capability:network`)
 * plus a decision and the scope it was saved in. The rule text is the whole
 * matcher: nothing about how a rule matches lives outside it, so the settings
 * page, the approval card and the evaluator all speak the same string.
 */

export const PERMISSION_DECISIONS = ["allow", "ask", "deny"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/**
 * Where a rule applies. `profile` spans every project of one user profile,
 * `project` one project, `conversation` one conversation and the sub-agents
 * it spawns.
 */
export const PERMISSION_SCOPES = ["conversation", "project", "profile"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** How a rule came to exist — shown on the settings page. */
export const PERMISSION_RULE_ORIGINS = ["user", "approval", "suggestion"] as const;
export type PermissionRuleOrigin = (typeof PERMISSION_RULE_ORIGINS)[number];

/**
 * Capability tags a tool declares. A `capability:<tag>` rule matches every
 * tool that carries the tag, so one rule can cover tools that don't exist yet.
 */
export const CAPABILITIES = [
  "fs_read",
  "fs_write",
  "shell",
  "network",
  "mcp",
  "subagent",
  "memory_write",
  "external_side_effect",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Which layer of the permission stack produced a decision. Recorded on every
 * tool call's `_approval` so a denial can name who said no.
 */
export type PermissionLayer =
  | "self_protection"
  | "rules"
  | "agent_policy"
  | "tier"
  | "full_auto"
  | "approve_all"
  | "user"
  /** A configured PreToolUse hook's `ask` / `allow` (hooks run before rules). */
  | "hook"
  /** The conversation's permission mode (PermissionModes.ts). */
  | "mode"
  /** A write to a protected path (ProtectedPaths.ts) — always asks. */
  | "protected_path";

/** A stored rule, as the API returns it. */
export interface PermissionRuleDocument {
  id: string;
  username: string;
  profileId: string;
  /** Project the rule was saved from. Only binding for project/conversation scope. */
  project: string;
  /** `null` applies to every agent; otherwise one agent id. */
  agent: string | null;
  /** Set only for `conversation` scope. */
  conversationId: string | null;
  scope: PermissionScope;
  rule: string;
  decision: PermissionDecision;
  origin: PermissionRuleOrigin;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The identity a rule set is evaluated for. */
export interface PermissionContext {
  project: string;
  /** Current agent, compared case-insensitively. */
  agent: string | null;
  /**
   * The conversation and every ancestor conversation. A sub-agent runs in its
   * own conversation, and a rule saved for "this conversation" must still
   * hold inside the sub-agents that conversation spawns.
   */
  conversationIds: string[];
  workspaceRoot: string | null;
}

/** The verdict of the permission stack for one tool call. */
export interface PermissionVerdict {
  decision: PermissionDecision;
  layer: PermissionLayer;
  /** The rule text that decided, when a rule decided. */
  rule?: string;
  ruleId?: string;
  scope?: PermissionScope;
  reason: string;
}
