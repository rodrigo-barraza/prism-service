import path from "node:path";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { canonicalValues } from "#src/services/permissions/PermissionMatcher";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import {
  rulesForFiles,
  throughWorktree,
  workspaceDisplayName,
  type WorkspaceRule,
  type WorktreeStandIn,
} from "#src/services/instructions/WorkspaceInstructions";
import type { LoadedInstruction } from "#src/services/instructions/InstructionsSection";
import { readTurnWorkspaceInstructions } from "#src/services/instructions/turnInstructions";
import { SYSTEM_MESSAGE_TAGS, wrapSystemMessage } from "#src/utils/SystemMessageTags";
import type AgentHooks from "#src/services/AgentHooks";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  AgenticContext,
  ConversationMessage,
  ToolCall,
  ToolResult,
} from "#src/services/harnesses/types";
import { fireInstructionsLoaded } from "./TurnHooks.ts";

// ────────────────────────────────────────────────────────────
// WorkspaceRuleStage — glob-scoped rules, when the agent touches a file
// ────────────────────────────────────────────────────────────
// A workspace rule with `paths:` (.claude/rules/*.md, .prism/rules/*.md —
// WorkspaceInstructions.ts) is not in the system prompt. It applies when
// the agent reads or edits a file it matches: after that batch, the rule
// arrives as one <workspace-rules> message beside the batch's results, and
// `InstructionsLoaded` fires with load_reason "path_glob_match".
//
// Once a conversation carries a rule's text it is not sent again: the
// message persists with the turn, so later turns see it in their history.
// A changed rule has new text and is sent again; a compacted-away one comes
// back the next time a matching file is touched.
// ────────────────────────────────────────────────────────────

/** Tools that read or edit a file. Their path arguments come from PermissionMatcher. */
const READ_OR_EDIT_TOOLS = new Set<string>([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.MULTI_FILE_READ,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.STRING_REPLACE_FILE,
  "apply_patch",
  TOOL_NAMES.MOVE_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.EDIT_NOTEBOOK,
]);

function failed(result: ToolResult | undefined): boolean {
  const outcome = result?.result as Record<string, unknown> | null | undefined;
  return !outcome || outcome.success === false || typeof outcome.error === "string";
}

/**
 * The files a batch read or edited, absolute (relative paths resolve against
 * the working directory, as tools-service resolves them; a path into the
 * repository a worktree stands in for is where the call really went, in
 * the worktree). Calls that failed touched nothing.
 */
export function touchedFiles(
  toolCalls: ToolCall[],
  results: ToolResult[],
  workingDirectory: string,
  worktree: WorktreeStandIn | null = null,
): string[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  const files: string[] = [];
  for (const call of toolCalls) {
    if (!READ_OR_EDIT_TOOLS.has(call.name) || failed(byId.get(call.id))) continue;
    const { kind, values } = canonicalValues({ name: call.name, args: call.args ?? {} });
    if (kind !== "path") continue;
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed) files.push(throughWorktree(path.posix.resolve(workingDirectory, trimmed), worktree));
    }
  }
  return [...new Set(files)];
}

function isRulesMessage(message: ConversationMessage): boolean {
  return (
    typeof message.content === "string" &&
    message.content.startsWith(`<${SYSTEM_MESSAGE_TAGS.WORKSPACE_RULES}>`)
  );
}

/** Is this rule's current text already in the conversation? */
function alreadyCarried(rule: WorkspaceRule, messages: ConversationMessage[]): boolean {
  return messages.some(
    (message) => isRulesMessage(message) && (message.content as string).includes(rule.content),
  );
}

function renderRules(
  matches: Array<{ rule: WorkspaceRule; files: string[] }>,
  locale: string,
): string {
  const blocks = matches.map(({ rule, files }) => {
    const label = PromptLocaleService.get(locale, "system-prompt.workspaceRuleLabel", {
      path: rule.path,
      globs: rule.globs.join(", "),
      files: files.join(", "),
    });
    return `${label}\n\n${rule.content}`;
  });
  return [PromptLocaleService.get(locale, "system-prompt.workspaceRulesHeader"), ...blocks].join(
    "\n\n",
  );
}

/**
 * Keep the workspace instructions the turn-start prompt assembly read
 * (`_workspaceInstructions` on the beforePrompt context) for the batches.
 */
export function rememberWorkspaceInstructions(
  state: AgenticLoopState,
  hookContext: Record<string, unknown>,
): void {
  state.workspaceInstructions =
    (hookContext._workspaceInstructions as AgenticLoopState["workspaceInstructions"]) ?? null;
}

/**
 * After a tool batch: send the glob-scoped workspace rules the batch's reads
 * and edits triggered, once per conversation. Call right after the batch's
 * assistant message (and its hook context) is pushed. Never throws.
 */
export async function applyWorkspaceRules(
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  hooks: AgentHooks | null | undefined,
  state: AgenticLoopState,
  toolCalls: ToolCall[],
  results: ToolResult[],
): Promise<void> {
  if (toolCalls.length === 0 || !toolCalls.some((call) => READ_OR_EDIT_TOOLS.has(call.name))) {
    return;
  }
  try {
    await sendTriggeredRules(currentMessages, context, hooks, state, toolCalls, results);
  } catch (error: unknown) {
    logger.warn(`[WorkspaceRuleStage] Workspace rules skipped for this batch: ${getErrorMessage(error)}`);
  }
}

async function sendTriggeredRules(
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  hooks: AgentHooks | null | undefined,
  state: AgenticLoopState,
  toolCalls: ToolCall[],
  results: ToolResult[],
): Promise<void> {
  // A turn re-driven after a restart skipped the prompt assembly that
  // read them: read them now, once.
  if (state.workspaceInstructions === undefined) {
    state.workspaceInstructions =
      context.options?.workspaceEnabled === false
        ? null
        : await readTurnWorkspaceInstructions({
            agentConversationId: context.agentConversationId,
            workspaceRoot: context.workspaceRoot,
          });
  }
  const instructions = state.workspaceInstructions;
  if (!instructions || !instructions.rules.some((rule) => rule.globs.length > 0)) return;

  const files = touchedFiles(
    toolCalls,
    results,
    instructions.workingDirectory,
    instructions.worktree ?? null,
  );
  const matches = rulesForFiles(instructions.rules, files).filter(
    ({ rule }) => !alreadyCarried(rule, currentMessages),
  );
  if (matches.length === 0) return;

  const locale = (context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();
  currentMessages.push({
    role: "system",
    content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.WORKSPACE_RULES, renderRules(matches, locale)),
  } as ConversationMessage);

  const loaded: LoadedInstruction[] = matches.map(({ rule, files: matched }) => ({
    instructionType: "workspace_rule",
    name: workspaceDisplayName(instructions.root, rule.path),
    content: rule.content,
    filePath: rule.path,
    loadReason: "path_glob_match",
    globs: rule.globs,
    triggerFilePath: matched[0],
  }));
  if (hooks) await fireInstructionsLoaded(context, hooks, loaded);
}
