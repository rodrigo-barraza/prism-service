// ─── Memory Consolidation Prompts ────────────────────────────
// LLM system prompts and memory formatters for the consolidation pipeline.
// Extracted from MemoryConsolidationService.ts

import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import type { MemoryDoc, PartitionMeta } from "./types.ts";

function daysSince(isoDate: string) {
  return daysSinceIso(isoDate);
}

// ─── System Prompts ─────────────────────────────────────────

export const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. You review a set of stored memories and determine how to optimize them.
## Your Goals
1. **Merge** redundant or overlapping memories into a single, more comprehensive memory
2. **Resolve contradictions** — if two memories disagree, the NEWER one is more authoritative
3. **Promote patterns** — if multiple memories point to the same insight, synthesize into one clear rule
4. **Flag stale** — memories about ephemeral state (bugs, deadlines, in-progress work) that are >30 days old should be deleted
## Rules
- Preserve the original TYPE (user, feedback, project, reference) when merging
- If merging memories of different types, pick the most appropriate type
- Each merged memory should be self-contained — don't reference "the original memories"
- Be conservative: only merge when there's clear overlap. Leave distinct memories alone
- Never invent new information — only combine what exists
## Output Format
Respond with ONLY a JSON object:
\`\`\`json
{
  "actions": [
    {
      "type": "merge",
      "sourceIds": ["id1", "id2"],
      "merged": {
        "type": "feedback",
        "title": "Short title",
        "content": "Consolidated content"
      },
      "reason": "Brief explanation"
    },
    {
      "type": "delete",
      "id": "id3",
      "reason": "Stale: referenced deadline that passed"
    }
  ],
  "summary": "Brief description of what was consolidated"
}
\`\`\`
If no consolidation is needed, return: { "actions": [], "summary": "No consolidation needed" }`;

export const CONVERSATIONAL_CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a conversational AI agent. You review personal facts that the agent has learned about users from conversations.

All memories in this batch are from the SAME source user about the SAME subject user. Preserve this attribution.

## Your Goals
1. **Merge** redundant or overlapping facts into a single, richer fact
2. **Resolve contradictions** — the NEWER fact is more authoritative, but SELF-REPORTED facts always override third-party reports regardless of age
3. **Promote patterns** — if multiple facts point to the same trait, synthesize into one clear memory
4. **Flag stale** — gaming interests >60 days old, work/achievement details >90 days old may be outdated and should be deleted

## Rules
- Preserve the original CATEGORY (personal, preference, gaming, work, family, hobby, location, relationship, achievement, other) when merging
- Each merged memory must be self-contained — write it as a standalone personal fact
- Be conservative: only merge when there's clear overlap. Distinct facts should remain separate
- Never invent new information — only combine what exists
- Do NOT merge facts from different life domains (e.g. don't combine a gaming preference with a food preference just because they're both "preferences")
- Personal, preference, family, and location facts are generally durable — do NOT delete them for age alone

## Output Format
Respond with ONLY a JSON object:
\`\`\`json
{
  "actions": [
    {
      "type": "merge",
      "sourceIds": ["id1", "id2"],
      "merged": {
        "type": "preference",
        "content": "Consolidated fact text"
      },
      "reason": "Brief explanation"
    },
    {
      "type": "delete",
      "id": "id3",
      "reason": "Stale: gaming interest from 3 months ago"
    }
  ],
  "summary": "Brief description of what was consolidated"
}
\`\`\`
If no consolidation is needed, return: { "actions": [], "summary": "No consolidation needed" }`;

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
export function buildBatchInput(clusterBatch: MemoryDoc[][], staleBatch: MemoryDoc[]): string | null {
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
