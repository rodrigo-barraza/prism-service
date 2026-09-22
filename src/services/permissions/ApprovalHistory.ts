import path from "node:path";
import type { Db, Filter } from "mongodb";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "#src/constants";
import { profileFilter } from "#src/utils/ProfileScope";
import { parsePermissionRule } from "./PermissionRuleSyntax.ts";
import {
  canonicalValues,
  normalizePath,
  ruleMatchesCall,
  splitShellCommand,
  type MatchableCall,
} from "./PermissionMatcher.ts";
import { resolveToolCapabilities } from "./ToolCapabilities.ts";
import type { PermissionIdentity } from "./PermissionRuleStore.ts";

/**
 * ApprovalHistory — what the user keeps approving, and the rule that would
 * stop asking.
 *
 *   - `proposeRule` turns one call into the rule "Always allow" offers:
 *     a command prefix (`execute_shell(git status:*)`), a directory
 *     (`write_file(src/components/**)`), an origin
 *     (`read_web_page(https://docs.python.org/*)`), or the bare tool.
 *   - `recordUserApproval` logs each call a human approved, keyed by that
 *     proposed rule. Only the rule text and tool name are stored, never the
 *     arguments — a `write_file` approval must not copy the file into Mongo.
 *   - `suggestRules` counts those records: "allowed `read_file(src/**)` 5×".
 */

export const APPROVAL_HISTORY = {
  /** Approvals of the same proposed rule before it is suggested. */
  SUGGESTION_THRESHOLD: 3,
  LOOKBACK_DAYS: 30,
  MAX_RECORDS_SCANNED: 2_000,
  MAX_SUGGESTIONS: 10,
  /** Records expire (TTL index on `at`). */
  RETENTION_DAYS: 90,
} as const;

export interface PermissionDecisionDocument {
  username: string;
  profileId: string;
  project: string;
  conversationId: string | null;
  agent: string | null;
  toolName: string;
  suggestedRule: string;
  decision: "allow";
  at: Date;
}

/** Commands whose first word alone says little — keep the subcommand too. */
const SUBCOMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "bun", "docker", "kubectl", "cargo",
  "go", "pip", "pip3", "uv", "make", "gh", "node", "python", "python3",
]);

function escapeGlob(text: string): string {
  return text.replace(/[\\*?]/g, "\\$&");
}

function proposeCommandPattern(command: string): string | null {
  const split = splitShellCommand(command);
  const first = split?.segments[0];
  if (!first) return null;
  const tokens = first.split(" ");
  const keepSubcommand =
    SUBCOMMAND_TOOLS.has(tokens[0]) && tokens.length > 1 && !tokens[1].startsWith("-");
  const prefix = tokens.slice(0, keepSubcommand ? 2 : 1).join(" ");
  return `${escapeGlob(prefix)}:*`;
}

export interface RuleProposal {
  rule: string;
  /** Whether the proposed allow rule covers this exact call (a compound command may not). */
  coversCall: boolean;
}

export function proposeRule(call: MatchableCall, workspaceRoot: string | null): RuleProposal {
  const canonical = canonicalValues(call);
  const first = canonical.values[0];
  let pattern: string | null = null;

  if (first && canonical.kind === "command") {
    pattern = proposeCommandPattern(first);
  } else if (first && canonical.kind === "path") {
    const normalized = normalizePath(first, workspaceRoot);
    const directory = path.posix.dirname(normalized.display);
    pattern =
      normalized.isOutside || directory === "." || !normalized.display
        ? escapeGlob(normalized.display)
        : `${escapeGlob(directory)}/**`;
  } else if (first && canonical.kind === "text" && /^https?:\/\//i.test(first)) {
    try {
      pattern = `${escapeGlob(new URL(first).origin)}/*`;
    } catch {
      pattern = null;
    }
  }

  const rule = pattern ? `${call.name}(${pattern})` : call.name;
  const parsed = parsePermissionRule(rule);
  const coversCall =
    parsed.ok &&
    ruleMatchesCall(parsed.rule, "allow", call, resolveToolCapabilities(call.name), workspaceRoot);
  return { rule: parsed.ok ? rule : call.name, coversCall };
}

async function getDb(): Promise<Db | null> {
  const [{ default: MongoWrapper }, { MONGO_DB_NAME }] = await Promise.all([
    import("#src/wrappers/MongoWrapper"),
    import("#config"),
  ]);
  return MongoWrapper.getDb(MONGO_DB_NAME) ?? null;
}

/** Log one human approval. Never throws — history is advisory. */
export async function recordUserApproval(
  scope: {
    username?: string | null;
    profileId?: string | null;
    project?: string | null;
    conversationId?: string | null;
    agent?: string | null;
    workspaceRoot?: string | null;
  },
  call: MatchableCall,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const document: PermissionDecisionDocument = {
      username: scope.username || "any",
      profileId: scope.profileId || "default",
      project: scope.project || "any",
      conversationId: scope.conversationId ?? null,
      agent: scope.agent ?? null,
      toolName: call.name,
      suggestedRule: proposeRule(call, scope.workspaceRoot ?? null).rule,
      decision: "allow",
      at: new Date(),
    };
    await db.collection<PermissionDecisionDocument>(COLLECTIONS.PERMISSION_DECISIONS).insertOne(document);
  } catch (error: unknown) {
    logger.warn(`[Permissions] Could not record approval of "${call.name}": ${errorMessage(error)}`);
  }
}

export interface RuleSuggestion {
  rule: string;
  toolName: string;
  count: number;
  lastApprovedAt: string;
}

/**
 * Proposed rules the user approved at least `SUGGESTION_THRESHOLD` times in
 * the lookback window, most-approved first, skipping any rule text that
 * already exists.
 */
export async function suggestRules(
  db: Db,
  identity: PermissionIdentity,
  existingRuleTexts: Iterable<string>,
): Promise<RuleSuggestion[]> {
  const since = new Date(Date.now() - APPROVAL_HISTORY.LOOKBACK_DAYS * 86_400_000);
  const records = await db
    .collection<PermissionDecisionDocument>(COLLECTIONS.PERMISSION_DECISIONS)
    .find({
      username: identity.username,
      profileId: profileFilter(identity.profileId),
      at: { $gte: since },
    } as Filter<PermissionDecisionDocument>)
    .sort({ at: -1 })
    .limit(APPROVAL_HISTORY.MAX_RECORDS_SCANNED)
    .toArray();

  const existing = new Set(existingRuleTexts);
  const tally = new Map<string, RuleSuggestion>();
  for (const record of records) {
    if (record.decision !== "allow" || existing.has(record.suggestedRule)) continue;
    const at = record.at instanceof Date ? record.at : new Date(record.at);
    if (at < since) continue;
    const entry = tally.get(record.suggestedRule);
    if (entry) {
      entry.count++;
      if (at.toISOString() > entry.lastApprovedAt) entry.lastApprovedAt = at.toISOString();
    } else {
      tally.set(record.suggestedRule, {
        rule: record.suggestedRule,
        toolName: record.toolName,
        count: 1,
        lastApprovedAt: at.toISOString(),
      });
    }
  }
  return [...tally.values()]
    .filter((suggestion) => suggestion.count >= APPROVAL_HISTORY.SUGGESTION_THRESHOLD)
    .sort((first, second) => second.count - first.count || (second.lastApprovedAt > first.lastApprovedAt ? 1 : -1))
    .slice(0, APPROVAL_HISTORY.MAX_SUGGESTIONS);
}
