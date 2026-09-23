import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import type { ApprovalPreview } from "#src/services/ApprovalRegistry";
import type { AgenticContext, ToolCall } from "#src/services/harnesses/types";
import { createUnifiedDiff } from "#src/utils/UnifiedDiff";
import { APPROVALS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * ApprovalPreview — what a file-writing call would change, as a unified
 * diff for its approval card.
 *
 * tools-service has no dry-run endpoint for writes, so the diff is computed
 * here from the current file (read through the same `read_file` tool the
 * agent uses, so workspace roots and sandboxing apply) and the content the
 * call would leave behind:
 *   - write_file       current → `content`
 *   - replace_in_file  current → current with the hash-anchored edits applied
 *                      by line number (the tool itself re-checks the hashes)
 *   - apply_patch      the call already carries a unified diff: shown as is
 *
 * Best effort: any failure (tools-service down, a file too large, a malformed
 * edit) yields no preview, never a failed approval.
 */

const APPLY_PATCH_TOOL_NAME = "apply_patch";

/** Tools whose approval card carries a diff preview. */
export const FILE_WRITING_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.REPLACE_IN_FILE,
  TOOL_NAMES.PATCH_FILE,
  APPLY_PATCH_TOOL_NAME,
]);

/** Lines requested per read; tools-service caps a read below this anyway. */
const READ_PAGE_LINES = 2_000;
/** A hashline read line is `<line#>:<4-char hash>|<text>`. */
const HASHLINE_PREFIX = /^\d+:[0-9a-z]{4}\|/;

interface CurrentFile {
  /** null — the file does not exist yet. */
  text: string | null;
}

interface ReadResult {
  error?: unknown;
  content?: unknown;
  lineFormat?: unknown;
  truncated?: unknown;
  nextStartLine?: unknown;
}

function stripHashlines(content: string): string[] {
  if (content === "") return [];
  return content.split("\n").map((line) => line.replace(HASHLINE_PREFIX, ""));
}

async function readCurrentFile(
  filePath: string,
  context: AgenticContext,
  signal: AbortSignal,
): Promise<CurrentFile | null> {
  const lines: string[] = [];
  let characters = 0;
  let startLine = 1;
  for (;;) {
    const result = (await ToolOrchestratorService.executeTool(
      TOOL_NAMES.READ_FILE,
      { absolutePath: filePath, startLine, endLine: startLine + READ_PAGE_LINES - 1 },
      {
        project: context.project,
        username: context.username,
        agent: context.agent || null,
        agentContext: context.options?.agentContext,
        agentConversationId: context.agentConversationId || "",
        conversationId: context.conversationId,
        workspaceRoot: context.workspaceRoot,
        signal,
      },
    )) as ReadResult | null;

    if (!result || typeof result !== "object") return null;
    if (result.error !== undefined) {
      // A new file: nothing to diff against.
      return startLine === 1 && /not found|ENOENT|does not exist/i.test(String(result.error))
        ? { text: null }
        : null;
    }
    if (typeof result.content !== "string") return null;
    const page =
      result.lineFormat === "hashline"
        ? stripHashlines(result.content)
        : result.content.split("\n");
    lines.push(...page);
    characters += result.content.length;
    if (characters > APPROVALS.PREVIEW_MAXIMUM_CHARACTERS) return null;

    const nextStartLine = Number(result.nextStartLine);
    if (result.truncated !== true || !Number.isFinite(nextStartLine) || nextStartLine <= startLine) {
      break;
    }
    startLine = nextStartLine;
  }
  // tools-service splits the raw text on "\n" (a trailing newline reads as a
  // last, empty line), so rejoining the lines restores the file exactly.
  return { text: lines.join("\n") };
}

interface HashlineEdit {
  anchor?: unknown;
  endAnchor?: unknown;
  op?: unknown;
  content?: unknown;
}

function anchorLine(anchor: unknown): number | null {
  if (typeof anchor !== "string") return null;
  const match = anchor.trim().match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Apply hash-anchored edits by line number. Returns null for an edit the
 * tool would reject on structure alone (the hashes are its to check).
 */
function applyHashlineEdits(text: string, edits: HashlineEdit[]): string | null {
  const lines = text.split("\n");
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  const resolved = edits.map((edit) => {
    const start = anchorLine(edit.anchor);
    const end = edit.endAnchor !== undefined ? anchorLine(edit.endAnchor) : start;
    const op = typeof edit.op === "string" ? edit.op : "replace";
    const content = typeof edit.content === "string" ? edit.content : "";
    return { start, end, op, content };
  });
  if (
    resolved.some(
      (edit) =>
        edit.start === null ||
        edit.end === null ||
        edit.end < edit.start ||
        edit.end > lines.length ||
        (edit.op !== "insert_after" && edit.start < 1) ||
        !["replace", "insert_after", "delete"].includes(edit.op),
    )
  ) {
    return null;
  }

  // Bottom-up, so an earlier edit never shifts a later one's line numbers.
  resolved.sort((left, right) => right.start! - left.start!);
  for (const edit of resolved) {
    const replacement = edit.op === "delete" || edit.content === "" ? [] : edit.content.split("\n");
    if (edit.op === "insert_after") {
      lines.splice(edit.start!, 0, ...replacement);
    } else {
      lines.splice(edit.start! - 1, edit.end! - edit.start! + 1, ...replacement);
    }
  }
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** The path as the diff header shows it: relative to the workspace root when inside it. */
function displayPath(filePath: string, workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot) return filePath;
  const root = workspaceRoot.replace(/\/+$/, "");
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
}

function finish(filePath: string, diff: string, isNewFile: boolean): ApprovalPreview | null {
  if (!diff) return null;
  const isTruncated = diff.length > APPROVALS.PREVIEW_MAXIMUM_DIFF_CHARACTERS;
  return {
    kind: "diff",
    path: filePath,
    diff: isTruncated ? diff.slice(0, APPROVALS.PREVIEW_MAXIMUM_DIFF_CHARACTERS) : diff,
    ...(isNewFile ? { isNewFile: true } : {}),
    ...(isTruncated ? { isTruncated: true } : {}),
  };
}

export async function buildApprovalPreview(
  toolCall: ToolCall,
  context: AgenticContext,
): Promise<ApprovalPreview | null> {
  if (!FILE_WRITING_TOOL_NAMES.has(toolCall.name)) return null;
  const args = toolCall.args || {};
  const filePath = typeof args.path === "string" ? args.path : null;
  if (!filePath) return null;
  const headerPath = displayPath(filePath, context.workspaceRoot);

  try {
    if (toolCall.name === APPLY_PATCH_TOOL_NAME || toolCall.name === TOOL_NAMES.PATCH_FILE) {
      const patch = typeof args.patch === "string" ? args.patch : typeof args.diff === "string" ? args.diff : null;
      return patch ? finish(filePath, patch, false) : null;
    }

    const signal = AbortSignal.any([
      AbortSignal.timeout(APPROVALS.PREVIEW_TIMEOUT_MILLISECONDS),
      ...(context.signal ? [context.signal] : []),
    ]);
    const current = await readCurrentFile(filePath, context, signal);
    if (!current) return null;

    if (toolCall.name === TOOL_NAMES.WRITE_FILE) {
      if (typeof args.content !== "string") return null;
      if (args.content.length > APPROVALS.PREVIEW_MAXIMUM_CHARACTERS) return null;
      return finish(
        filePath,
        createUnifiedDiff(headerPath, current.text, args.content),
        current.text === null,
      );
    }

    if (toolCall.name === TOOL_NAMES.REPLACE_IN_FILE) {
      if (current.text === null || !Array.isArray(args.edits)) return null;
      const updated = applyHashlineEdits(current.text, args.edits as HashlineEdit[]);
      return updated === null
        ? null
        : finish(filePath, createUnifiedDiff(headerPath, current.text, updated), false);
    }
  } catch (error: unknown) {
    logger.warn(
      `[ApprovalPreview] No preview for ${toolCall.name} ${filePath}: ${getErrorMessage(error)}`,
    );
  }
  return null;
}
