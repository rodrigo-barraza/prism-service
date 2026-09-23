/**
 * ToolExecutionRecord — one executed tool call as its iteration's request
 * row keeps it (`toolExecutions`, written by logIteration). The row's own
 * timings are the model call's; these are the tool's, and they are what
 * /admin/stats/tools reports tool latency and error rate from.
 */
export interface ToolExecutionRecord {
  id: string | null;
  name: string;
  /** Wall-clock time of the call itself, timeout included. */
  durationMilliseconds: number;
  success: boolean;
  /** Set when the call failed — see toolResultErrorType. */
  errorType?: string;
}

/**
 * The low-cardinality error class of a failed tool result: its error code
 * when it carries one (TOOL_TIMEOUT, MALFORMED_TOOL_CALL_JSON, …), else
 * `tool_error`. Undefined for a result that did not fail.
 */
export function toolResultErrorType(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const { success, error } = result as { success?: unknown; error?: unknown };
  if (success !== false && !error) return undefined;
  return typeof error === "string" && /^[A-Z][A-Z0-9_]+$/.test(error)
    ? error
    : "tool_error";
}

export function buildToolExecutionRecord(
  toolCall: { id: string | null; name: string },
  result: unknown,
  durationMilliseconds: number,
): ToolExecutionRecord {
  const errorType = toolResultErrorType(result);
  return {
    id: toolCall.id,
    name: toolCall.name,
    durationMilliseconds,
    success: !errorType,
    ...(errorType && { errorType }),
  };
}
