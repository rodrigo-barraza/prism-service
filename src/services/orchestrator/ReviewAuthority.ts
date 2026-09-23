import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { SubAgentResult } from "#src/types/orchestrator";

// ────────────────────────────────────────────────────────────
// ReviewAuthority — when a reviewer may send work back
// ────────────────────────────────────────────────────────────
// A reviewer that can reject work and have it redone pays off only when it
// can VERIFY the work: a manager's "reject" authority cost 51.5% more tokens
// for no quality gain otherwise (arXiv 2609.14767). So, across topologies
// (TopologyRegistry `reviewAuthority`) and thought structures:
//   • selecting among independent work — a judge, a scorer — needs no proof;
//   • sending work back needs a check the reviewer RAN: tests, a type-check,
//     a schema or output validation. A verdict with none behind it is
//     returned as advice, and the work is not redone.
// ────────────────────────────────────────────────────────────

/** Tools that run something — the ways a reviewer checks work rather than reads it. */
export const VERIFYING_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.RUN_COMMAND,
  TOOL_NAMES.EXECUTE_SHELL,
  TOOL_NAMES.EXECUTE_PYTHON,
  TOOL_NAMES.EXECUTE_JAVASCRIPT,
  TOOL_NAMES.EXECUTE_CODE,
]);

/** The verifying tools a reviewer's run used; empty when it only read and judged. */
export function checksRunBy(review: Pick<SubAgentResult, "toolNames">): string[] {
  return Object.entries(review.toolNames ?? {})
    .filter(([toolName, count]) => count > 0 && VERIFYING_TOOL_NAMES.has(toolName))
    .map(([toolName]) => toolName);
}
