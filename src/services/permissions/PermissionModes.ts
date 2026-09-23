import { canonicalValues, normalizePath, type MatchableCall } from "./PermissionMatcher.ts";
import type { Capability } from "./types.ts";

/**
 * Permission modes — how much of the tier system asks a person.
 *
 * A conversation has one mode (stored on it; a default lives in settings).
 * The mode is one layer of the permission stack, evaluated by
 * AutoApprovalEngine after self-protection and the deny rules:
 *
 *   default      the tier decides: AUTO runs, WRITE and DANGER ask.
 *   plan         only read-only tools run; anything that writes, runs a
 *                shell or reaches the network is denied with a message that
 *                tells the model it is planning.
 *   acceptEdits  file edits inside the workspace run without asking;
 *                everything else is as in `default`.
 *   auto         read-only tools and workspace edits run; the rest goes to
 *                the auto-mode classifier (AutoModeClassifier.ts), which
 *                allows, denies with a named category, or asks. Handing a
 *                sub-agent a task goes to it too, and allow rules broad
 *                enough to skip it (any shell command, any delegation) are
 *                set aside while auto mode is on.
 *   dontAsk      anything that would ask is denied instead. The default for
 *                runs nobody is watching (scheduled tasks, timers).
 *   bypass       everything runs. Owner only, chosen per conversation, never
 *                a default; the client shows a banner while it is on.
 *
 * What no mode relaxes: self-protection, deny rules, ask rules (only the
 * legacy "approve all" answers those), a PreToolUse hook's `ask`, and
 * writes to protected paths (see ProtectedPaths.ts) — those still ask, and
 * in `dontAsk` (or any unattended run) are denied because nobody can answer.
 */

export const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypass",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/** The mode unattended runs get when their conversation names none. */
export const UNATTENDED_PERMISSION_MODE: PermissionMode = "dontAsk";

/** Env var naming the usernames allowed to turn `bypass` on. Empty = nobody. */
export const BYPASS_OWNERS_ENV_VAR = "PRISM_PERMISSION_BYPASS_OWNERS";

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask",
  plan: "Plan",
  acceptEdits: "Accept edits",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypass: "Bypass",
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: "Read-only tools run; writes, shell and other side effects ask.",
  plan: "Read-only tools only. Writes, shell and network calls are refused until you leave plan mode.",
  acceptEdits: "File edits inside the workspace run without asking; everything else asks.",
  auto: "Read-only tools and workspace edits run; a classifier reviews the rest.",
  dontAsk: "Anything that would ask is refused instead. For runs nobody is watching.",
  bypass: "Everything runs without asking, except deny rules, ask rules, hooks that ask and protected paths.",
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Claude Code's name for a mode, which is what a hook's `permission_mode`
 * carries — a hook written for Claude Code reads the same values here.
 */
export function hookPermissionModeName(mode: PermissionMode): string {
  return mode === "bypass" ? "bypassPermissions" : mode;
}

/** Usernames that may use `bypass` (read on every call, so a restart isn't needed in tests). */
export function bypassOwners(): Set<string> {
  return new Set(
    (process.env[BYPASS_OWNERS_ENV_VAR] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function canUseBypass(username: string | null | undefined): boolean {
  return Boolean(username) && bypassOwners().has(username!);
}

// ── What each mode lets through ──────────────────────────────────

/** Capabilities a plan-mode call may carry: reading, and delegating (sub-agents inherit the mode). */
const PLAN_SAFE_CAPABILITIES: ReadonlySet<Capability> = new Set(["fs_read", "subagent"]);

/**
 * Plan mode runs a call only when everything it can do is reading. A tool
 * with no side effects at all (control flow, the agent's own task list)
 * declares no capabilities and passes; an undeclared tool resolves to
 * `external_side_effect` and does not.
 */
export function isPlanSafe(capabilities: readonly Capability[]): boolean {
  return capabilities.every((capability) => PLAN_SAFE_CAPABILITIES.has(capability));
}

/** Tools whose whole effect is editing the files named in their path arguments. */
const FILE_EDIT_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "move_file",
  "delete_file",
  "edit_notebook",
]);

const FILE_EDIT_CAPABILITIES: ReadonlySet<Capability> = new Set(["fs_read", "fs_write"]);

/**
 * An edit `acceptEdits` (and `auto`) runs without asking: a file-edit tool
 * that can do nothing but touch files, every path it names inside the
 * workspace. No workspace root, a path that climbs out or is absolute
 * elsewhere, or a call with no path at all → not a workspace edit (it asks).
 * Protected paths are excluded by the engine before this is consulted.
 */
export function isWorkspaceEdit(
  call: MatchableCall,
  capabilities: readonly Capability[],
  workspaceRoot: string | null,
): boolean {
  if (!workspaceRoot || !FILE_EDIT_TOOLS.has(call.name)) return false;
  if (!capabilities.includes("fs_write")) return false;
  if (!capabilities.every((capability) => FILE_EDIT_CAPABILITIES.has(capability))) return false;
  const { kind, values } = canonicalValues(call);
  if (kind !== "path" || values.length === 0) return false;
  // With a root, `~/…` and absolute paths elsewhere read as outside.
  return values.every((value) => value.trim() !== "" && !normalizePath(value, workspaceRoot).isOutside);
}

/**
 * Tools that hand another agent instructions. In `auto` mode the classifier
 * reads the task before a sub-agent starts on it (Claude Code checks a
 * sub-agent at spawn, per action and on its report) — they are read-only
 * as tools, but what they delegate is not.
 */
const DELEGATION_TOOLS = new Set([
  "create_subagent",
  "create_subagents",
  "send_subagent_message",
  "resume_subagent",
]);

export function delegatesTask(toolName: string): boolean {
  return DELEGATION_TOOLS.has(toolName);
}

/** An argument pattern that matches anything: `*`, `**`, or the regex `.*` between slashes. */
function matchesAnything(argument: string): boolean {
  const pattern = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
  return /^(\*+|\/\^?\.\*\$?\/)$/.test(pattern.trim());
}

/**
 * An allow rule too broad for `auto` mode: it would let a call skip the
 * classifier where the classifier matters most. Claude Code drops the same
 * rules on entering auto mode (blanket `Bash(*)`, interpreters, `Agent`).
 *
 *   capability:shell / capability:subagent          always broad
 *   <tool> or <tool>(*) on a shell or delegation    broad
 *   `*` (every tool)                                 broad
 *
 * A narrow rule (`execute_shell(npm test)`) keeps working. The rule is set
 * aside only while the mode is `auto`; nothing is deleted.
 */
export function isTooBroadForAutoMode(ruleText: string, capabilities: readonly Capability[]): boolean {
  const text = ruleText.trim();
  if (text === "capability:shell" || text === "capability:subagent") return true;
  if (text.startsWith("capability:")) return false;
  const reachesShellOrDelegation = capabilities.includes("shell") || capabilities.includes("subagent");
  if (!reachesShellOrDelegation) return false;
  const open = text.indexOf("(");
  if (open === -1) return true;
  return text.endsWith(")") && matchesAnything(text.slice(open + 1, -1));
}

/** Tools that need a person to answer — refused where nobody will. */
const USER_INTERACTION_TOOLS = new Set(["ask_user", "exit_plan_mode"]);

export function requiresUserInteraction(toolName: string): boolean {
  return USER_INTERACTION_TOOLS.has(toolName);
}

// ── What the model is told ───────────────────────────────────────

export function planModeDenialReason(toolName: string): string {
  return (
    `[Plan mode] "${toolName}" was not run: this conversation is in plan mode, where only ` +
    `read-only tools run — no file writes, shell commands or network calls. Keep researching ` +
    `with read-only tools and present your plan (call exit_plan_mode if you have it). ` +
    `Nothing is changed until the user leaves plan mode or approves the plan.`
  );
}

export function unattendedDenialReason(
  toolName: string,
  mode: PermissionMode,
  askReason: string,
): string {
  const why = mode === "dontAsk" ? "this run is in don't-ask mode" : "nobody is watching this run";
  return (
    `[${mode === "dontAsk" ? "Don't-ask mode" : "Unattended run"}] "${toolName}" needs approval ` +
    `(${askReason}), and ${why}, so it was denied instead of asking. Continue with tools that ` +
    `need no approval, or finish and report what the user would have to allow.`
  );
}

export function userInteractionDenialReason(toolName: string, mode: PermissionMode): string {
  const instead =
    toolName === "exit_plan_mode"
      ? "Write the plan in your reply instead; the user will read it there."
      : "Decide on your own and say what you assumed.";
  return (
    `[${mode === "dontAsk" ? "Don't-ask mode" : "Unattended run"}] "${toolName}" waits for the ` +
    `user to answer, and nobody is watching this run. ${instead}`
  );
}
