import logger from "#src/utils/logger";
import { parsePermissionRule, type ParseResult } from "./PermissionRuleSyntax.ts";
import { ruleMatchesCall, type MatchableCall } from "./PermissionMatcher.ts";
import type {
  Capability,
  PermissionContext,
  PermissionDecision,
  PermissionRuleDocument,
  PermissionScope,
  PermissionVerdict,
} from "./types.ts";

/**
 * PermissionEvaluator — the rules layer: which stored rules apply here, which
 * of them match this call, and which one decides.
 *
 * Precedence is decision first — deny > ask > allow, whatever the scope —
 * so a broad profile-wide deny is never undone by a narrow conversation
 * allow. Among rules with the same decision, the most specific scope names
 * the verdict (conversation, then project, then profile; an agent-specific
 * rule before an agent-wide one; newest first), which only changes which
 * rule the denial message quotes.
 */

export type CompiledPermissionRule = Pick<
  PermissionRuleDocument,
  | "id"
  | "rule"
  | "decision"
  | "scope"
  | "project"
  | "agent"
  | "conversationId"
  | "enabled"
  | "createdAt"
> & { parsed: ParseResult };

const DECISION_RANK: Record<PermissionDecision, number> = { deny: 0, ask: 1, allow: 2 };
const SCOPE_RANK: Record<PermissionScope, number> = { conversation: 0, project: 1, profile: 2 };

const reportedInvalid = new Set<string>();

export function compileRule(
  document: Pick<
    PermissionRuleDocument,
    "id" | "rule" | "decision" | "scope" | "project" | "agent" | "conversationId"
  > &
    Partial<Pick<PermissionRuleDocument, "enabled" | "createdAt">>,
): CompiledPermissionRule {
  const parsed = parsePermissionRule(document.rule);
  const invalid = !parsed.ok
    ? parsed.error
    : parsed.rule.kind === "tool" && parsed.rule.argument?.error
      ? parsed.rule.argument.error
      : null;
  if (invalid) {
    const key = `${document.id}::${document.rule}`;
    if (!reportedInvalid.has(key)) {
      reportedInvalid.add(key);
      logger.warn(
        `[Permissions] Rule ${document.id} "${document.rule}" (${document.decision}) is invalid and fails closed — ` +
          `${document.decision === "allow" ? "it allows nothing" : `it ${document.decision}s every call it could cover`}: ${invalid}`,
      );
    }
  }
  return {
    id: document.id,
    rule: document.rule,
    decision: document.decision,
    scope: document.scope,
    project: document.project,
    agent: document.agent ?? null,
    conversationId: document.conversationId ?? null,
    enabled: document.enabled !== false,
    createdAt: document.createdAt ?? "",
    parsed,
  };
}

/** Does this rule's scope cover the run described by `context`? */
export function ruleAppliesTo(rule: CompiledPermissionRule, context: PermissionContext): boolean {
  if (!rule.enabled) return false;
  if (rule.agent && (!context.agent || rule.agent.toLowerCase() !== context.agent.toLowerCase())) {
    return false;
  }
  switch (rule.scope) {
    case "profile":
      return true;
    case "project":
      return rule.project === context.project;
    case "conversation":
      return Boolean(rule.conversationId) && context.conversationIds.includes(rule.conversationId!);
    default:
      return false;
  }
}

/**
 * Does `rule` match `call`? A rule whose text doesn't parse at all fails
 * closed like an invalid pattern: an allow matches nothing, an ask or deny
 * matches every call.
 */
export function compiledRuleMatches(
  rule: CompiledPermissionRule,
  call: MatchableCall,
  capabilities: readonly Capability[],
  workspaceRoot: string | null,
): boolean {
  if (!rule.parsed.ok) return rule.decision !== "allow";
  return ruleMatchesCall(rule.parsed.rule, rule.decision, call, capabilities, workspaceRoot);
}

function compareRules(first: CompiledPermissionRule, second: CompiledPermissionRule): number {
  return (
    DECISION_RANK[first.decision] - DECISION_RANK[second.decision] ||
    SCOPE_RANK[first.scope] - SCOPE_RANK[second.scope] ||
    Number(Boolean(second.agent)) - Number(Boolean(first.agent)) ||
    (second.createdAt > first.createdAt ? 1 : second.createdAt < first.createdAt ? -1 : 0)
  );
}

export function describeRuleVerdict(rule: CompiledPermissionRule): string {
  const where = `${rule.scope} scope`;
  switch (rule.decision) {
    case "deny":
      return `Denied by permission rule \`${rule.rule}\` (${where})`;
    case "ask":
      return `Requires approval: permission rule \`${rule.rule}\` (${where})`;
    default:
      return `Allowed by permission rule \`${rule.rule}\` (${where})`;
  }
}

export interface RulesEvaluation {
  verdict: PermissionVerdict | null;
  /** Every applicable rule that matched, deciding rule first. */
  matched: CompiledPermissionRule[];
}

export function evaluateRules(
  rules: readonly CompiledPermissionRule[],
  call: MatchableCall,
  capabilities: readonly Capability[],
  context: PermissionContext,
): RulesEvaluation {
  const matched = rules
    .filter(
      (rule) =>
        ruleAppliesTo(rule, context) &&
        compiledRuleMatches(rule, call, capabilities, context.workspaceRoot),
    )
    .sort(compareRules);
  if (matched.length === 0) return { verdict: null, matched };
  const deciding = matched[0];
  return {
    verdict: {
      decision: deciding.decision,
      layer: "rules",
      rule: deciding.rule,
      ruleId: deciding.id,
      scope: deciding.scope,
      reason: describeRuleVerdict(deciding),
    },
    matched,
  };
}

/** The strongest of several layer verdicts: deny > ask > allow; earlier wins ties. */
export function strongestVerdict(verdicts: readonly PermissionVerdict[]): PermissionVerdict | null {
  let strongest: PermissionVerdict | null = null;
  for (const verdict of verdicts) {
    if (!strongest || DECISION_RANK[verdict.decision] < DECISION_RANK[strongest.decision]) {
      strongest = verdict;
    }
  }
  return strongest;
}
