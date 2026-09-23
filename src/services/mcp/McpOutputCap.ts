import crypto from "crypto";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolResultOffloadService from "#src/services/compact/ToolResultOffloadService";
import { estimateTokens } from "#src/utils/CostCalculator";
import { MCP } from "#src/constants";

/**
 * Per-tool output caps for MCP results.
 *
 * An MCP server decides how much text a call returns, and nothing bounded it
 * — one `browser_snapshot` can fill a context window. Past the cap, the full
 * result goes to ToolResultOffloadService and the model gets the head plus a
 * pointer it can page through with retrieve_offloaded_content.
 */

export interface McpOutputCapSettings {
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number> | null;
}

export interface McpOutputCapContext {
  /** The namespaced tool name, recorded on the offload. */
  toolName: string;
  conversationId?: string | null;
  project?: string | null;
  username?: string | null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/** The cap for one tool: its own setting, then the server's, then the default. */
export function resolveOutputCapTokens(
  settings: McpOutputCapSettings,
  originalToolName: string,
): number {
  return (
    positiveInteger(settings.toolOutputCapTokens?.[originalToolName]) ??
    positiveInteger(settings.outputCapTokens) ??
    MCP.OUTPUT_CAP_TOKENS
  );
}

/**
 * Apply the cap. Errors pass through, and so does an `image` payload —
 * PostExecutionEmitter moves it to storage before the model sees the
 * result, so it doesn't count against the cap.
 */
export function capMcpToolResult<T extends Record<string, unknown>>(
  result: T,
  capTokens: number,
  context: McpOutputCapContext,
): T | Record<string, unknown> {
  if (!result || typeof result !== "object" || "error" in result) return result;

  const { image, ...rest } = result as Record<string, unknown>;
  const onlyText =
    Object.keys(rest).length === 1 && typeof rest.result === "string";
  const serialized = onlyText
    ? (rest.result as string)
    : JSON.stringify(rest, null, 2) ?? "";
  const totalTokens = estimateTokens(serialized);
  if (totalTokens <= capTokens) return result;

  const offloadId = `mcp-${crypto.randomUUID()}`;
  ToolResultOffloadService.offloadToolResult(
    { id: offloadId, name: context.toolName, result: serialized },
    {
      conversationId: context.conversationId ?? null,
      project: context.project ?? null,
      username: context.username ?? null,
    },
  );

  // estimateTokens is chars/4, so the head is the first cap×4 characters.
  const head = serialized.slice(0, capTokens * 4);
  return {
    result: head,
    outputCapped: {
      capTokens,
      totalTokens,
      offloadId,
    },
    note:
      `This result was ~${totalTokens} tokens, over the ${capTokens}-token cap for this tool, ` +
      `so only the first part is shown. The full result is stored: call ` +
      `${TOOL_NAMES.RETRIEVE_OFFLOADED_CONTENT} with offloadId "${offloadId}" and a pattern ` +
      `or startLine/endLine to read the rest.`,
    ...(image !== undefined && { image }),
  };
}
