// ─── Memory Consolidation Prompts ────────────────────────────
// LLM system prompts and memory formatters for the consolidation pipeline.
// Extracted from MemoryConsolidationService.ts

import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "../PromptLocaleService.ts";
import type { MemoryDoc, PartitionMeta } from "./types.ts";

function daysSince(isoDate: string) {
  return daysSinceIso(isoDate);
}

// ─── System Prompts ─────────────────────────────────────────

export const CONSOLIDATION_PROMPT = PromptLocaleService.get("en", "memory.consolidationPrompt");

export const CONVERSATIONAL_CONSOLIDATION_PROMPT = PromptLocaleService.get("en", "memory.conversationalConsolidationPrompt");

// ─── Memory Formatters ──────────────────────────────────────

export function formatMemoryEntry(memory: MemoryDoc): string {
  const age = daysSince(memory.createdAt);
  return `- **ID**: ${memory.id}\n  **Type**: ${memory.type}\n  **Title**: ${memory.title || (memory.content ? memory.content.substring(0, 60) : "untitled")}\n  **Content**: ${memory.content}\n  **Age**: ${age} days`;
}

export function formatConversationalMemoryEntry(memory: MemoryDoc): string {
  const age = daysSince(memory.createdAt);
  return `- **ID**: ${memory.id}\n  **Category**: ${memory.type}\n  **About**: ${memory.aboutUsername || "any"} (${memory.aboutUserId || "?"})\n  **Source**: ${memory.sourceUsername || "any"} (${memory.sourceUserId || "?"})\n  **Content**: ${memory.content}\n  **Age**: ${age} days`;
}

// ─── Batch Input Builders ───────────────────────────────────

export function buildConversationalBatchInput(
  clusterBatch: MemoryDoc[][],
  staleBatch: MemoryDoc[],
  partitionMeta?: PartitionMeta,
): string | null {
  const sections: string[] = [];

  if (partitionMeta) {
    sections.push(`## Attribution Context`);
    sections.push(
      `- **About user**: ${partitionMeta.aboutUsername} (ID: ${partitionMeta.aboutUserId})`,
    );
    sections.push(
      `- **Observed by**: ${partitionMeta.sourceUsername} (ID: ${partitionMeta.sourceUserId})`,
    );
    sections.push("");
  }

  if (clusterBatch.length > 0) {
    sections.push("## Clusters of Similar Facts\n");
    clusterBatch.forEach((cluster, clusterIndex) => {
      sections.push(
        `### Cluster ${clusterIndex + 1} (${cluster.length} facts, likely overlap):`,
      );
      cluster.forEach((memory) => {
        sections.push(formatConversationalMemoryEntry(memory));
      });
      sections.push("");
    });
  }
  if (staleBatch.length > 0) {
    sections.push("## Potentially Stale Facts\n");
    staleBatch.forEach((memory) => {
      sections.push(formatConversationalMemoryEntry(memory));
    });
  }
  if (sections.length === 0) {
    return null;
  }
  return sections.join("\n");
}

/**
 * Build the LLM input for a single batch of clusters and stale memories.
 * Returns null if both arrays are empty.
 */
export function buildBatchInput(
  clusterBatch: MemoryDoc[][],
  staleBatch: MemoryDoc[],
): string | null {
  const sections: string[] = [];
  if (clusterBatch.length > 0) {
    sections.push("## Clusters of Similar Memories\n");
    clusterBatch.forEach((cluster, clusterIndex) => {
      sections.push(
        `### Cluster ${clusterIndex + 1} (${cluster.length} memories, likely overlap):`,
      );
      cluster.forEach((memory) => {
        sections.push(formatMemoryEntry(memory));
      });
      sections.push("");
    });
  }
  if (staleBatch.length > 0) {
    sections.push(
      "## Potentially Stale Memories (>30 days old, ephemeral types)\n",
    );
    staleBatch.forEach((memory) => {
      sections.push(formatMemoryEntry(memory));
    });
  }
  if (sections.length === 0) {
    return null;
  }
  return sections.join("\n");
}
