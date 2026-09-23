import type { SkillUpsertResult } from "#src/services/SkillService";

// ────────────────────────────────────────────────────────────
// importSummary — what an import did (or, in a dry run, would do)
// ────────────────────────────────────────────────────────────
// Shared by the Claude config and Agent Plugins importers so the client's
// Import page renders one preview shape for both: counts for the summary
// line, `items` for the table, `skipped` for the reasons.
// ────────────────────────────────────────────────────────────

export interface ImportSkipped {
  name: string;
  reason: string;
}

export interface SkillImportItem {
  name: string;
  description: string;
  allowedTools: string[] | null;
  /** The folder's files, SKILL.md included. */
  files: string[];
  status: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

export interface SkillImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: ImportSkipped[];
  items: SkillImportItem[];
}

export interface McpImportItem {
  name: string;
  transport: string | null;
  /** The command line or URL, as it will be stored. */
  target: string;
  status: "imported" | "unchanged" | "skipped";
  reason?: string;
}

export interface McpImportSummary {
  imported: number;
  unchanged: number;
  skipped: ImportSkipped[];
  items: McpImportItem[];
}

export function emptySkillSummary(): SkillImportSummary {
  return { created: 0, updated: 0, unchanged: 0, skipped: [], items: [] };
}

export function emptyMcpSummary(): McpImportSummary {
  return { imported: 0, unchanged: 0, skipped: [], items: [] };
}

export function recordSkippedSkill(
  summary: SkillImportSummary,
  item: Omit<SkillImportItem, "status" | "reason">,
  reason: string,
): void {
  summary.skipped.push({ name: item.name, reason });
  summary.items.push({ ...item, status: "skipped", reason });
}

/** Fold one SkillService.upsertImported result into the summary. */
export function recordSkillResult(
  summary: SkillImportSummary,
  item: Omit<SkillImportItem, "status" | "reason">,
  result: SkillUpsertResult,
): void {
  if (result.error) {
    recordSkippedSkill(summary, item, result.error);
  } else if (result.status === "created" || result.status === "updated" || result.status === "unchanged") {
    summary[result.status] += 1;
    summary.items.push({ ...item, status: result.status });
  } else {
    recordSkippedSkill(summary, item, result.reason || "skipped");
  }
}

export function recordSkippedServer(
  summary: McpImportSummary,
  name: string,
  reason: string,
  transport: string | null = null,
  target = "",
): void {
  summary.skipped.push({ name, reason });
  summary.items.push({ name, transport, target, status: "skipped", reason });
}
