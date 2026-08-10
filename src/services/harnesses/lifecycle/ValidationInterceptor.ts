import logger from "#src/utils/logger";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { TOOLS_SERVICE_URL } from "#config";
import path from "node:path";
import fs from "node:fs";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ToolCall,
  ToolResult,
  AgenticContext,
  ValidationFeedback,
} from "#src/services/harnesses/types";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { HARNESS } from "#src/constants";

/**
 * ValidationInterceptor — automatic linter/LSP feedback loop.
 *
 * After file-mutating tool calls (write_file, replace_in_file, patch_file),
 * runs language-aware validation and returns structured feedback. When errors
 * are detected, the harness injects them as a synthetic user message so the
 * model self-corrects on the next iteration without wasting a tool call.
 *
 * TypeScript validation goes through the tools-service LSP diagnostics batch
 * endpoint: ONE call per edited-file batch (deduped by workspace root), with
 * per-file results from a warm language server. This replaced the old path
 * that ran a whole-project `tsc --noEmit` once PER EDITED FILE
 * (improvement-plan §F-8) — the dominant validation cost in coding loops.
 * ESLint (.js/.jsx) still runs as a per-file shell command.
 */

const FILE_MUTATING_TOOLS: Set<string> = new Set([
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.STRING_REPLACE_FILE,
  TOOL_NAMES.PATCH_FILE,
  TOOL_NAMES.MOVE_FILE,
]);

/** Extensions validated via the tools-service LSP diagnostics batch. */
const LSP_VALIDATED_EXTENSIONS = new Set([".ts", ".tsx"]);

interface ValidatorConfig {
  command: string | null;
  type: string;
}

const EXTENSION_VALIDATORS: Record<string, ValidatorConfig> = {
  ".js": { command: "npx eslint --format compact", type: "eslint" },
  ".jsx": { command: "npx eslint --format compact", type: "eslint" },
  ".json": { command: null, type: "json-parse" },
};

const VALIDATION_TIMEOUT_MILLISECONDS = HARNESS.VALIDATION_TIMEOUT_MILLISECONDS;

/** Max files per LSP diagnostics call (mirrors the tools-service cap). */
const LSP_DIAGNOSTICS_BATCH_LIMIT = 20;

/**
 * Extract the file path from a tool call's arguments.
 * Different tools use different argument names for the target path.
 */
function extractFilePath(toolCall: ToolCall): string | null {
  const arguments_ = toolCall.args as Record<string, unknown>;
  const rawPath =
    arguments_.path ||
    arguments_.filePath ||
    arguments_.file ||
    arguments_.newPath;
  return typeof rawPath === "string" ? rawPath : null;
}

/**
 * Find the nearest directory containing a tsconfig.json or package.json starting from a file's directory.
 * Walks up the tree until it reaches the workspace root.
 */
function findNearestConfigDir(filePath: string, workspaceRoot: string): string {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(workspaceRoot, filePath);

  let currentDirectory = path.dirname(absoluteFilePath);

  while (
    currentDirectory.startsWith(workspaceRoot) &&
    currentDirectory !== workspaceRoot
  ) {
    const hasTsConfig = fs.existsSync(
      path.join(currentDirectory, "tsconfig.json"),
    );
    const hasPackageJson = fs.existsSync(
      path.join(currentDirectory, "package.json"),
    );
    if (hasTsConfig || hasPackageJson) {
      return currentDirectory;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }

  return workspaceRoot;
}

/**
 * Run inline JSON validation (no external process needed).
 */
function validateJsonInline(
  filePath: string,
  toolResult: ToolResult,
): ValidationFeedback | null {
  const resultObject = toolResult.result as Record<string, unknown> | null;
  if (!resultObject || resultObject.error) return null;

  // JSON parse validation only makes sense if we have the content.
  // Since the tool already succeeded writing it, we trust the write was valid JSON
  // unless the tool result explicitly mentions a parse error.
  return null;
}

/**
 * Run a shell-based validator command against a file path.
 */
async function runShellValidator(
  validatorConfig: ValidatorConfig,
  filePath: string,
  context: AgenticContext,
): Promise<ValidationFeedback | null> {
  if (!validatorConfig.command) return null;

  const workspaceRoot =
    context.workspaceRoot || ToolOrchestratorService.getWorkspaceRoot();
  if (!workspaceRoot) return null;

  const executionCwd = findNearestConfigDir(filePath, workspaceRoot);

  try {
    const shellResult = (await ToolOrchestratorService.executeTool(
      TOOL_NAMES.RUN_COMMAND,
      {
        command: validatorConfig.command,
        cwd: executionCwd,
        timeout: VALIDATION_TIMEOUT_MILLISECONDS,
      },
      {
        project: context.project,
        username: context.username,
        agent: context.agent || undefined,
        agentConversationId: context.agentConversationId,
        workspaceRoot,
        signal: context.signal || undefined,
      },
    )) as Record<string, unknown>;

    const exitCode = shellResult.exitCode ?? shellResult.code ?? 0;
    const standardOutput = (shellResult.stdout ||
      shellResult.output ||
      "") as string;
    const standardError = (shellResult.stderr || "") as string;
    const combinedOutput = (standardOutput + "\n" + standardError).trim();

    // Exit code 0 means no errors
    if (exitCode === 0 || !combinedOutput) return null;

    // Parse errors from output
    const errorLines = combinedOutput
      .split("\n")
      .filter(
        (line) =>
          line.includes("error") ||
          line.includes("Error") ||
          line.includes("✖"),
      )
      .slice(0, 10);

    if (errorLines.length === 0 && combinedOutput.length < 20) return null;

    return {
      toolName: TOOL_NAMES.RUN_COMMAND,
      filePath,
      validatorType: validatorConfig.type,
      errors:
        errorLines.length > 0 ? errorLines : [combinedOutput.slice(0, 500)],
      rawOutput: combinedOutput.slice(0, 2000),
    };
  } catch (validationError: unknown) {
    logger.warn(
      `[ValidationInterceptor] Validator failed for ${filePath}: ${getErrorMessage(validationError)}`,
    );
    return null;
  }
}

// ── LSP diagnostics batch (TypeScript) ───────────────────────

interface LspDiagnosticEntry {
  severity?: string;
  line?: number;
  character?: number;
  message?: string;
  code?: string | number;
  source?: string;
}

interface LspDiagnosticsFileResult {
  filePath?: string;
  status?: string;
  stale?: boolean;
  diagnostics?: LspDiagnosticEntry[];
  error?: string;
}

interface LspDiagnosticsBatchResponse {
  error?: string;
  files?: LspDiagnosticsFileResult[];
}

/** Format one LSP diagnostic like a compiler error line (keeps TS codes greppable). */
function formatLspDiagnostic(
  filePath: string,
  diagnostic: LspDiagnosticEntry,
): string {
  const code =
    typeof diagnostic.code === "number"
      ? `TS${diagnostic.code}`
      : (diagnostic.code ?? "");
  const codeLabel = code ? ` ${code}` : "";
  return `${filePath}(${diagnostic.line ?? 0},${diagnostic.character ?? 0}): error${codeLabel}: ${diagnostic.message ?? ""}`;
}

/**
 * Validate a batch of TypeScript files with ONE tools-service LSP
 * diagnostics call. Returns one feedback item per file that has errors.
 */
async function runLspBatchValidator(
  files: Array<{ argPath: string; absolutePath: string }>,
  workspaceRoot: string,
  context: AgenticContext,
): Promise<ValidationFeedback[]> {
  if (files.length === 0 || !TOOLS_SERVICE_URL) return [];

  const batch = files.slice(0, LSP_DIAGNOSTICS_BATCH_LIMIT);

  let response: Response;
  try {
    response = await fetch(`${TOOLS_SERVICE_URL}/agentic/lsp/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: batch.map((file) => file.absolutePath),
        workspacePath: workspaceRoot,
      }),
      signal:
        context.signal ?? AbortSignal.timeout(VALIDATION_TIMEOUT_MILLISECONDS),
    });
  } catch (fetchError: unknown) {
    logger.warn(
      `[ValidationInterceptor] LSP diagnostics call failed: ${getErrorMessage(fetchError)}`,
    );
    return [];
  }

  if (!response.ok) {
    logger.warn(
      `[ValidationInterceptor] LSP diagnostics returned ${response.status}`,
    );
    return [];
  }

  let payload: LspDiagnosticsBatchResponse;
  try {
    payload = (await response.json()) as LspDiagnosticsBatchResponse;
  } catch (parseError: unknown) {
    logger.warn(
      `[ValidationInterceptor] LSP diagnostics response unreadable: ${getErrorMessage(parseError)}`,
    );
    return [];
  }
  if (payload.error || !Array.isArray(payload.files)) return [];

  const argPathByAbsolute = new Map(
    batch.map((file) => [file.absolutePath, file.argPath]),
  );

  const feedbackItems: ValidationFeedback[] = [];
  for (const fileResult of payload.files) {
    if (!fileResult?.filePath || fileResult.error) continue;
    const errors = (fileResult.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length === 0) continue;

    const argPath =
      argPathByAbsolute.get(fileResult.filePath) ?? fileResult.filePath;
    const errorLines = errors
      .slice(0, 10)
      .map((diagnostic) => formatLspDiagnostic(argPath, diagnostic));

    feedbackItems.push({
      toolName: "code_intel",
      filePath: argPath,
      validatorType: "typescript",
      errors: errorLines,
      rawOutput: errorLines.join("\n").slice(0, 2000),
    });
  }

  return feedbackItems;
}

/**
 * Validate file-mutating tool results and return structured feedback.
 *
 * Called by harnesses after `executeToolBatch()` returns. Returns an empty
 * array when all validations pass or no file-mutating tools were called.
 */
export async function validateAfterToolExecution(
  toolCalls: ToolCall[],
  results: ToolResult[],
  context: AgenticContext,
  _state: AgenticLoopState,
): Promise<ValidationFeedback[]> {
  const feedbackItems: ValidationFeedback[] = [];
  // TypeScript files are batched into ONE LSP diagnostics call per workspace
  // root instead of a whole-project compile per edited file.
  const lspBatchesByRoot = new Map<
    string,
    Array<{ argPath: string; absolutePath: string }>
  >();

  for (const toolCall of toolCalls) {
    if (!FILE_MUTATING_TOOLS.has(toolCall.name)) continue;

    const matchingResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );
    if (!matchingResult) continue;

    // Skip if the tool itself errored
    const resultObject = matchingResult.result as Record<
      string,
      unknown
    > | null;
    if (resultObject?.error) continue;

    const filePath = extractFilePath(toolCall);
    if (!filePath) continue;

    const fileExtension = path.extname(filePath).toLowerCase();

    // TypeScript → collect for the batched LSP diagnostics call
    if (LSP_VALIDATED_EXTENSIONS.has(fileExtension)) {
      const workspaceRoot =
        context.workspaceRoot || ToolOrchestratorService.getWorkspaceRoot();
      if (!workspaceRoot) continue;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspaceRoot, filePath);
      const batch = lspBatchesByRoot.get(workspaceRoot) ?? [];
      if (!batch.some((entry) => entry.absolutePath === absolutePath)) {
        batch.push({ argPath: filePath, absolutePath });
      }
      lspBatchesByRoot.set(workspaceRoot, batch);
      continue;
    }

    const validatorConfig = EXTENSION_VALIDATORS[fileExtension];
    if (!validatorConfig) continue;

    // JSON gets inline validation (no shell needed)
    if (validatorConfig.type === "json-parse") {
      const jsonFeedback = validateJsonInline(filePath, matchingResult);
      if (jsonFeedback) feedbackItems.push(jsonFeedback);
      continue;
    }

    // Shell-based validators (ESLint)
    const shellFeedback = await runShellValidator(
      validatorConfig,
      filePath,
      context,
    );
    if (shellFeedback) {
      // Override filePath to the specific file that was edited
      shellFeedback.filePath = filePath;
      feedbackItems.push(shellFeedback);
    }
  }

  // One LSP diagnostics call per workspace root for the whole batch
  for (const [workspaceRoot, files] of lspBatchesByRoot) {
    const lspFeedback = await runLspBatchValidator(
      files,
      workspaceRoot,
      context,
    );
    feedbackItems.push(...lspFeedback);
  }

  if (feedbackItems.length > 0) {
    logger.info(
      `[ValidationInterceptor] Found ${feedbackItems.length} validation issue(s): ` +
        feedbackItems
          .map((feedback) => `${feedback.filePath} (${feedback.validatorType})`)
          .join(", "),
    );
  }

  return feedbackItems;
}
