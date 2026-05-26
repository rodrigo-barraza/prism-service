import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import MemoryService from "./MemoryService.ts";
import RequestLogger from "./RequestLogger.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { cosineSimilarity } from "../utils/math.ts";
import { parseJsonFromLlmResponse } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "../constants.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import SettingsService from "./SettingsService.ts";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "../utils/CostCalculator.ts";
import { TYPES, getPricing } from "../config.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/** Memory document shape from MongoDB */
interface MemoryDoc {
  id: string;
  type: string;
  title?: string | null;
  content: string;
  createdAt: string;
  embedding?: number[] | null;
  aboutUserId?: string;
  aboutUsername?: string;
  sourceUserId?: string;
  sourceUsername?: string;
  guildId?: string;
  [key: string]: unknown;
}

/** Consolidation action from the LLM */
interface ConsolidationAction {
  type: "merge" | "delete";
  sourceIds?: string[];
  merged?: { type: string; title?: string; content: string };
  id?: string;
  reason?: string;
}

/** Partition attribution metadata for conversational agents */
interface PartitionMeta {
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId: string;
  sourceUsername: string;
}

/** Single batch of work for the LLM */
interface ConsolidationBatch {
  clusters: MemoryDoc[][];
  stale: MemoryDoc[];
  partitionMeta?: PartitionMeta;
}

/** Options for processBatch */
interface ProcessBatchOptions {
  provider: Record<string, unknown>;
  consolidationProvider: string;
  consolidationModel: string;
  agent: string;
  project: string | null;
  username: string;
  trigger: string;
  endpoint?: string | null;
  traceId?: string | null;
  agentSessionId?: string | null;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  systemPrompt?: string;
  inputBuilder?: (clusters: MemoryDoc[][], stale: MemoryDoc[], meta?: PartitionMeta) => string | null;
}

/** Options for applyActions */
interface ApplyActionsOptions {
  traceId?: string | null;
  endpoint?: string | null;
  memoryLookup?: Map<string, MemoryDoc>;
}

/** Options for consolidate() */
interface ConsolidateOptions {
  agent?: string;
  project?: string | null;
  username?: string;
  trigger?: string;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  endpoint?: string | null;
  traceId?: string | null;
  agentSessionId?: string | null;
  guildId?: string | null;
}

/** Options for checkAndRun() */
interface CheckAndRunOptions {
  project?: string | null;
  username?: string;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  endpoint?: string | null;
  agent?: string | null;
  traceId?: string | null;
  agentSessionId?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────
/** Resolve the current consolidation provider + model from settings. */
async function getConsolidationConfig() {
  return SettingsService.getMemoryModelConfig("consolidation");
}
/** Cosine similarity above which two memories are clustered together */
const CLUSTER_THRESHOLD = 0.75;
/** Conversational agents use a higher threshold — personal facts are shorter and more distinct */
const CONVERSATIONAL_CLUSTER_THRESHOLD = 0.8;
/** Max memories per cluster sent to the LLM (avoid token blowup) */
const MAX_CLUSTER_SIZE = 8;
/** Memories older than this (days) with ephemeral types get flagged for staleness review */
const STALENESS_DAYS = 30;
/** Conversational agent type-aware staleness — only fast-decaying categories get flagged */
const CONVERSATIONAL_STALENESS_CONFIG: Record<string, number> = {
  gaming: 60,
  work: 90,
  achievement: 90,
};
/** Min sessions between consolidation runs */
const SESSIONS_BETWEEN_RUNS = 5;
/** Max consolidation runs per project per day (cost guard) */
const DAILY_MAX_CONSOLIDATIONS = 20;
/** Max clusters per LLM batch — keeps input well under context window limits */
const BATCH_MAX_CLUSTERS = 5;
/** Max stale memories per LLM batch */
const BATCH_MAX_STALE = 10;
/** Soft token budget for the user message portion of a batch (leaves room for system prompt + output) */
const BATCH_INPUT_TOKEN_BUDGET = 12_000;
/** Output token limit per LLM call — 2000 was too low for complex merges */
const LLM_MAX_OUTPUT_TOKENS = 4096;
const RUNS_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_RUNS;
const HISTORY_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_HISTORY;
function daysSince(isoDate: string) {
  return daysSinceIso(isoDate);
}
// ─── Cluster Detection ───────────────────────────────────────────────────────
/**
 * Find clusters of semantically similar memories using Union-Find.
 * Returns arrays of memory groups (each group has 2+ memories).
 */
function findClusters(memories: MemoryDoc[], threshold: number = CLUSTER_THRESHOLD): MemoryDoc[][] {
  const memoryCount = memories.length;
  if (memoryCount < 2) return [];

  // Union-Find
  const parent = Array.from({ length: memoryCount }, (_, i) => i);
  const rank = new Array(memoryCount).fill(0);

  function find(x: number): number {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  }

  function union(x: number, y: number): void {
    const px = find(x);
    const py = find(y);
    if (px === py) return;
    if (rank[px] < rank[py]) {
      parent[px] = py;
    } else if (rank[px] > rank[py]) {
      parent[py] = px;
    } else {
      parent[py] = px;
      rank[px]++;
    }
  }

  // Pairwise comparison — O(n²) but fine for <500 memories
  for (let i = 0; i < memoryCount; i++) {
    for (let j = i + 1; j < memoryCount; j++) {
      if (!memories[i].embedding || !memories[j].embedding) continue;
      const sim = cosineSimilarity(
        memories[i].embedding!,
        memories[j].embedding!,
      );
      if (sim > threshold) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, MemoryDoc[]>();
  for (let i = 0; i < memoryCount; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(memories[i]);
  }

  // Only return clusters with 2+ members, capped at MAX_CLUSTER_SIZE
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => g.slice(0, MAX_CLUSTER_SIZE));
}
// ─── LLM Prompts ─────────────────────────────────────────────────────────────
const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. You review a set of stored memories and determine how to optimize them.
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

const CONVERSATIONAL_CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a conversational AI agent. You review personal facts that the agent has learned about users from conversations.

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
// ─── Conversational Agent Partitioning ──────────────────────────────────────
/**
 * Partition conversational agent memories by (aboutUserId, sourceUserId) so each
 * partition represents one observer's perspective about one subject. This ensures
 * we never merge facts across different people or different observers.
 *
 * Returns a Map where keys are "aboutUserId::sourceUserId" and values are
 * arrays of memory documents.
 */
function partitionConversationalMemories(memories: MemoryDoc[]): Map<string, MemoryDoc[]> {
  const partitions = new Map<string, MemoryDoc[]>();
  for (const message of memories) {
    const about = message.aboutUserId || "_unknown";
    const source = message.sourceUserId || "_unknown";
    const key = `${about}::${source}`;
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key)!.push(message);
  }
  return partitions;
}

/**
 * Identify stale conversational agent memories using type-aware thresholds.
 * Only fast-decaying categories (gaming, work, achievement) are flagged.
 */
function findStaleConversationalMemories(memories: MemoryDoc[]): MemoryDoc[] {
  return memories.filter((message) => {
    const threshold = CONVERSATIONAL_STALENESS_CONFIG[message.type];
    if (!threshold) return false; // durable types (personal, preference, etc.) are never stale
    return daysSince(message.createdAt) > threshold;
  });
}

// ─── Batch Building ──────────────────────────────────────────────────────────
function formatMemoryEntry(m: MemoryDoc): string {
  const age = daysSince(m.createdAt);
  return `- **ID**: ${m.id}\n  **Type**: ${m.type}\n  **Title**: ${m.title || (m.content ? m.content.substring(0, 60) : "untitled")}\n  **Content**: ${m.content}\n  **Age**: ${age} days`;
}
function formatConversationalMemoryEntry(m: MemoryDoc): string {
  const age = daysSince(m.createdAt);
  return `- **ID**: ${m.id}\n  **Category**: ${m.type}\n  **About**: ${m.aboutUsername || "any"} (${m.aboutUserId || "?"})\n  **Source**: ${m.sourceUsername || "any"} (${m.sourceUserId || "?"})\n  **Content**: ${m.content}\n  **Age**: ${age} days`;
}
function buildConversationalBatchInput(
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
    clusterBatch.forEach((cluster, i) => {
      sections.push(
        `### Cluster ${i + 1} (${cluster.length} facts, likely overlap):`,
      );
      cluster.forEach((message) => {
        sections.push(formatConversationalMemoryEntry(message));
      });
      sections.push("");
    });
  }
  if (staleBatch.length > 0) {
    sections.push("## Potentially Stale Facts\n");
    staleBatch.forEach((message) => {
      sections.push(formatConversationalMemoryEntry(message));
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
function buildBatchInput(clusterBatch: MemoryDoc[][], staleBatch: MemoryDoc[]): string | null {
  const sections: string[] = [];
  if (clusterBatch.length > 0) {
    sections.push("## Clusters of Similar Memories\n");
    clusterBatch.forEach((cluster, i) => {
      sections.push(
        `### Cluster ${i + 1} (${cluster.length} memories, likely overlap):`,
      );
      cluster.forEach((message) => {
        sections.push(formatMemoryEntry(message));
      });
      sections.push("");
    });
  }
  if (staleBatch.length > 0) {
    sections.push(
      "## Potentially Stale Memories (>30 days old, ephemeral types)\n",
    );
    staleBatch.forEach((message) => {
      sections.push(formatMemoryEntry(message));
    });
  }
  if (sections.length === 0) {
    return null;
  }
  return sections.join("\n");
}

/**
 * Partition clusters and stale memories into batches that stay within
 * the input token budget. Each batch gets up to BATCH_MAX_CLUSTERS
 * clusters and BATCH_MAX_STALE stale memories, with a hard token cap.
 */
function buildBatches(clusters: MemoryDoc[][], staleMemories: MemoryDoc[]): ConsolidationBatch[] {
  const batches: ConsolidationBatch[] = [];

  let clusterIdx = 0;
  let staleIdx = 0;

  // First, batch clusters (primary merge candidates)
  while (clusterIdx < clusters.length) {
    const batchClusters: MemoryDoc[][] = [];
    let batchTokens = 0;

    while (
      clusterIdx < clusters.length &&
      batchClusters.length < BATCH_MAX_CLUSTERS
    ) {
      const clusterText = clusters[clusterIdx]
        .map(formatMemoryEntry)
        .join("\n");
      const clusterTokens = estimateTokens(clusterText);

      if (
        batchTokens + clusterTokens > BATCH_INPUT_TOKEN_BUDGET &&
        batchClusters.length > 0
      ) {
        break; // This cluster would exceed budget — start a new batch
      }

      batchClusters.push(clusters[clusterIdx]);
      batchTokens += clusterTokens;
      clusterIdx++;
    }

    // Attach stale memories to the first cluster batch that has room
    const batchStale: MemoryDoc[] = [];
    while (
      staleIdx < staleMemories.length &&
      batchStale.length < BATCH_MAX_STALE
    ) {
      const entryText = formatMemoryEntry(staleMemories[staleIdx]);
      const entryTokens = estimateTokens(entryText);

      if (
        batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
        batchStale.length > 0
      ) {
        break;
      }

      batchStale.push(staleMemories[staleIdx]);
      batchTokens += entryTokens;
      staleIdx++;
    }

    if (batchClusters.length > 0 || batchStale.length > 0) {
      batches.push({ clusters: batchClusters, stale: batchStale });
    }
  }

  // Any remaining stale memories that didn't fit into cluster batches
  while (staleIdx < staleMemories.length) {
    const batchStale: MemoryDoc[] = [];
    let batchTokens = 0;

    while (
      staleIdx < staleMemories.length &&
      batchStale.length < BATCH_MAX_STALE
    ) {
      const entryText = formatMemoryEntry(staleMemories[staleIdx]);
      const entryTokens = estimateTokens(entryText);

      if (
        batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
        batchStale.length > 0
      ) {
        break;
      }

      batchStale.push(staleMemories[staleIdx]);
      batchTokens += entryTokens;
      staleIdx++;
    }

    if (batchStale.length > 0) {
      batches.push({ clusters: [], stale: batchStale });
    }
  }

  return batches;
}

// ─── Action Execution ────────────────────────────────────────────────────────
/**
 * Apply consolidation actions. For conversational agent merges, memoryLookup
 * is used to preserve source attribution metadata on the merged document.
 */
async function applyActions(
  actions: ConsolidationAction[],
  agent: string,
  agentType: string,
  project: string | null,
  username: string,
  { traceId, endpoint, memoryLookup }: ApplyActionsOptions = {},
) {
  const results = { merged: 0, deleted: 0, errors: 0 };
  const isConversational = agentType === "conversational";

  for (const action of actions) {
    try {
      if (
        action.type === "merge" &&
        action.sourceIds?.length &&
        action.sourceIds.length >= 2 &&
        action.merged
      ) {
        // Collect conversational agent metadata from source memories before deletion
        let attributionMetadata: Record<string, unknown> = {};
        if (isConversational && memoryLookup) {
          const sources = action.sourceIds
            .map((id: string) => memoryLookup.get(id))
            .filter(Boolean) as MemoryDoc[];

          if (sources.length > 0) {
            // All memories in a merge share the same about/source (partitioned)
            const primary = sources[0];
            // Collect all unique sources for the mergedSources attribution chain
            const uniqueSources = new Map<string, { sourceUserId: string; sourceUsername: string }>();
            for (const s of sources) {
              if (s.sourceUserId && !uniqueSources.has(s.sourceUserId)) {
                uniqueSources.set(s.sourceUserId, {
                  sourceUserId: s.sourceUserId,
                  sourceUsername: s.sourceUsername || "",
                });
              }
            }
            attributionMetadata = {
              metadata: {
                aboutUserId: primary.aboutUserId,
                aboutUsername: primary.aboutUsername,
                sourceUserId: primary.sourceUserId,
                sourceUsername: primary.sourceUsername,
                guildId: primary.guildId,
                mergedSources: [...uniqueSources.values()],
              },
            };
          }
        }

        // Delete source memories
        for (const id of action.sourceIds) {
          await MemoryService.remove(id);
        }
        // Store consolidated memory
        await MemoryService.store({
          agent,
          project,
          username: username || "system",
          type: action.merged.type || (isConversational ? "other" : "project"),
          title: action.merged.title || null,
          content: action.merged.content,
          conversationId: null,
          traceId: traceId || undefined,
          endpoint: endpoint || undefined,
          ...attributionMetadata,
        });
        results.merged += action.sourceIds.length;
        logger.info(
          `[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title || action.merged.content?.substring(0, 60)}" (${action.reason || ""})`,
        );
      } else if (action.type === "delete" && action.id) {
        await MemoryService.remove(action.id);
        results.deleted++;
        logger.info(
          `[MemoryConsolidation] Deleted "${action.id}" (${action.reason || ""})`,
        );
      }
    } catch (error: unknown) {
      results.errors++;
      logger.error(
        `[MemoryConsolidation] Failed to apply action: ${(error as Error).message}`,
      );
    }
  }
  return results;
}
// ─── Run Tracking ────────────────────────────────────────────────────────────
async function getRunCount(project: string) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;
  const document = await db.collection(RUNS_COLLECTION).findOne({ project });
  return (document?.sessionsSinceLastRun as number) || 0;
}
async function incrementRunCount(project: string) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db
    .collection(RUNS_COLLECTION)
    .updateOne(
      { project },
      { $inc: { sessionsSinceLastRun: 1 } },
      { upsert: true },
    );
}
async function resetRunCount(project: string) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db.collection(RUNS_COLLECTION).updateOne(
    { project },
    {
      $set: {
        sessionsSinceLastRun: 0,
        lastConsolidatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}
// ─── History & Cost Guard ────────────────────────────────────────────────────
async function recordHistory(
  project: string,
  trigger: string,
  memoriesBefore: number,
  actions: ConsolidationAction[],
  summary: string,
  durationMs: number,
) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  const mergeCount = actions
    .filter((first) => first.type === "merge")
    .reduce((sum, first) => sum + (first.sourceIds?.length || 0), 0);
  const deleteCount = actions.filter((first) => first.type === "delete").length;
  await db.collection(HISTORY_COLLECTION).insertOne({
    project,
    runAt: new Date().toISOString(),
    trigger,
    memoriesBefore,
    memoriesAfter:
      memoriesBefore -
      mergeCount -
      deleteCount +
      actions.filter((first) => first.type === "merge").length,
    actionsApplied: actions.length,
    actions: actions.map((first) => ({
      type: first.type,
      ...(first.sourceIds && { sourceIds: first.sourceIds }),
      ...(first.merged && { mergedTitle: first.merged.title }),
      ...(first.id && { deletedId: first.id }),
      reason: first.reason || "",
    })),
    summary,
    durationMs,
  });
}
/**
 * Check if the daily consolidation budget is exhausted.
 * Returns true if more runs are allowed.
 */
async function canRunToday(project: string) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return true;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await db.collection(HISTORY_COLLECTION).countDocuments({
    project,
    runAt: { $gte: startOfDay.toISOString() },
  });
  if (todayCount >= DAILY_MAX_CONSOLIDATIONS) {
    logger.warn(
      `[MemoryConsolidation] Daily limit reached for "${project}" (${todayCount}/${DAILY_MAX_CONSOLIDATIONS})`,
    );
    return false;
  }
  return true;
}

// ─── Single Batch LLM Call ───────────────────────────────────────────────────
/**
 * Run a single LLM consolidation call for one batch.
 * Returns parsed actions array, or empty array on failure.
 */
async function processBatch(
  batch: ConsolidationBatch,
  batchIndex: number,
  totalBatches: number,
  {
    provider,
    consolidationProvider,
    consolidationModel,
    agent,
    project,
    username,
    trigger,
    endpoint,
    traceId,
    agentSessionId,
    broadcast,
    systemPrompt = CONSOLIDATION_PROMPT,
    inputBuilder,
  }: ProcessBatchOptions,
): Promise<ConsolidationAction[]> {
  const input = inputBuilder
    ? inputBuilder(batch.clusters, batch.stale, batch.partitionMeta)
    : buildBatchInput(batch.clusters, batch.stale);
  if (!input) return [];

  const batchLabel = `[batch ${batchIndex + 1}/${totalBatches}]`;
  const clusterCount = batch.clusters.length;
  const staleCount = batch.stale.length;
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Processing ${clusterCount} clusters, ${staleCount} stale memories`,
  );

  const aiMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input },
  ];

  const inputText = aiMessages.map((message) => message.content).join("\n");
  const approxInputTokens = estimateTokens(inputText);
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Input: ~${approxInputTokens} tokens`,
  );

  const llmRequestId = crypto.randomUUID();
  const llmStart = performance.now();
  let llmSuccess = true;
  let llmError: string | null = null;
  let result: { text?: string; usage?: Record<string, number> } | null = null;

  try {
    result = await (provider as { generateText: (msgs: { role: string; content: string }[], model: string, opts: Record<string, unknown>) => Promise<{ text?: string; usage?: Record<string, number> }> }).generateText(aiMessages, consolidationModel, {
      maxTokens: LLM_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
    });
  } catch (error: unknown) {
    llmSuccess = false;
    llmError = (error as Error).message;
    logger.error(
      `[MemoryConsolidation] ${batchLabel} LLM call failed: ${(error as Error).message}`,
    );
  }

  // Use real API-reported usage when available; fall back to heuristic
  const realUsage = result?.usage || null;
  const inputTokens = realUsage
    ? getTotalInputTokens(realUsage)
    : estimateTokens(inputText);
  const outputTokens = realUsage
    ? realUsage.outputTokens || 0
    : result?.text
      ? estimateTokens(result.text)
      : 0;
  RequestLogger.logBackgroundLlmCall({
    requestId: llmRequestId,
    endpoint: endpoint || null,
    operation: "memory:consolidate",
    project,
    username: username || "system",
    agent: agent || null,
    provider: consolidationProvider,
    model: consolidationModel,
    traceId: traceId || null,
    agentSessionId: agentSessionId || null,
    aiMessages,
    resultText: result?.text || "",
    usage: realUsage,
    success: llmSuccess,
    errorMessage: llmError,
    requestStartMs: llmStart,
    extraRequestPayload: {
      trigger,
      batchIndex,
      totalBatches,
      clusterCount,
      staleCount,
    },
  });

  // Broadcast incremental usage with cost
  if (typeof broadcast === "function" && llmSuccess) {
    try {
      const consolidatePricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
        consolidationModel
      ];
      const consolidateCost = consolidatePricing
        ? calculateTextCost(
            realUsage || { inputTokens, outputTokens },
            consolidatePricing,
          )
        : null;
      broadcast({
        type: "usage_update",
        operation: "memory:consolidate",
        usage: {
          requests: 1,
          inputTokens,
          outputTokens,
          estimatedCost: consolidateCost,
        },
      });
    } catch {
      /* SSE channel may be closed */
    }
  }

  if (!llmSuccess || !result?.text) {
    return [];
  }

  // Parse response with enhanced diagnostics
  const parsed = parseJsonFromLlmResponse(result.text) as { actions?: ConsolidationAction[] } | null;
  if (!parsed) {
    const responseLen = result.text?.length || 0;
    const snippet = result.text?.substring(0, 300) || "(empty)";
    const tail =
      responseLen > 300 ? result.text.substring(responseLen - 200) : "";
    logger.warn(
      `[MemoryConsolidation] ${batchLabel} Failed to parse LLM response ` +
        `(${responseLen} chars, ~${outputTokens} tokens). ` +
        `Head: ${snippet}${tail ? `\n  Tail: ${tail}` : ""}`,
    );
    return [];
  }

  return parsed.actions || [];
}

// ─── Public API ──────────────────────────────────────────────────────────────
const MemoryConsolidationService = {
  /**
   * Run memory consolidation for a specific agent within a project.
   * Processes memories in batches to avoid context window overflow.
   */
  async consolidate({
    agent = "CODING",
    project,
    username,
    trigger = "manual",
    broadcast,
    endpoint,
    traceId,
    agentSessionId,
    guildId,
  }: ConsolidateOptions) {
    const startTime = performance.now();
    const agentId = agent || "CODING";
    const persona = AgentPersonaRegistry.get(agentId);
    const agentType = persona?.type || "";
    const isConversational = agentType === "conversational";
    logger.info(
      `[MemoryConsolidation] Starting ${agentType || "general"} consolidation for agent "${agentId}", project "${project}" (trigger: ${trigger})`,
    );

    // Cost guard — check daily budget
    if (!(await canRunToday(project || guildId || "global"))) {
      return { skipped: true, reason: "daily_limit_reached", total: 0 };
    }

    // Load all memories with embeddings (LUPOS needs extra fields)
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");

    const query: Record<string, unknown> = { agent: agentId };
    if (project) query.project = project;
    if (isConversational && guildId) query.guildId = guildId;

    const projection = isConversational
      ? {
          embedding: 1,
          id: 1,
          type: 1,
          title: 1,
          content: 1,
          createdAt: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          sourceUserId: 1,
          sourceUsername: 1,
          guildId: 1,
        }
      : { embedding: 1, id: 1, type: 1, title: 1, content: 1, createdAt: 1 };

    const allMemories = await db
      .collection(COLLECTIONS.MEMORIES)
      .find(query)
      .project(projection)
      .toArray() as MemoryDoc[];

    if (allMemories.length < 2) {
      logger.info(
        `[MemoryConsolidation] Only ${allMemories.length} memories — skipping`,
      );
      await resetRunCount(project || guildId || "global");
      return {
        skipped: true,
        reason: "insufficient memories",
        total: allMemories.length,
      };
    }

    logger.info(
      `[MemoryConsolidation] Loaded ${allMemories.length} memories for clustering`,
    );

    // Resolve the consolidation model
    const { provider: consolidationProvider, model: consolidationModel } =
      await getConsolidationConfig();
    const provider = getProvider(consolidationProvider);

    // Build a lookup map for metadata preservation during merges
    const memoryLookup = new Map<string, MemoryDoc>(allMemories.map((message) => [message.id, message]));

    let allActions: ConsolidationAction[] = [];
    let batches: ConsolidationBatch[] = [];

    if (isConversational) {
      // ── Conversational Path: partition by (aboutUserId, sourceUserId) ────
      const partitions = partitionConversationalMemories(allMemories);
      logger.info(
        `[MemoryConsolidation] Conversational (${agentId}): ${partitions.size} partitions (unique observer→subject pairs)`,
      );

      for (const [key, memories] of partitions) {
        if (memories.length < 2) continue;

        // Cluster within this partition using the higher conversational threshold
        const partitionClusters = findClusters(
          memories,
          CONVERSATIONAL_CLUSTER_THRESHOLD,
        );
        const partitionStale = findStaleConversationalMemories(memories);

        // ── Release embeddings after clustering ──────────────────────
        // Embeddings (1536-dim float arrays, ~12KB each) are only needed
        // for cosine similarity in findClusters(). Strip them now so
        // GC can reclaim before the LLM batch loop.
        for (const message of memories) {
          message.embedding = null;
        }

        if (partitionClusters.length === 0 && partitionStale.length === 0)
          continue;

        // Extract metadata for the partition header
        const sample = memories[0];
        const partitionMeta: PartitionMeta = {
          aboutUserId: sample.aboutUserId || "",
          aboutUsername: sample.aboutUsername || "",
          sourceUserId: sample.sourceUserId || "",
          sourceUsername: sample.sourceUsername || "",
        };

        // Build batches for this partition
        const partitionBatches = buildBatches(
          partitionClusters,
          partitionStale,
        );
        for (const b of partitionBatches) {
          b.partitionMeta = partitionMeta;
        }
        batches.push(...partitionBatches);

        logger.info(
          `[MemoryConsolidation] Conversational partition ${key}: ${memories.length} memories → ${partitionClusters.length} clusters, ${partitionStale.length} stale`,
        );
      }

      if (batches.length === 0) {
        logger.info(
          `[MemoryConsolidation] Conversational (${agentId}): No consolidation candidates across partitions`,
        );
        await resetRunCount(project || guildId || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      // Process conversational batches with the conversational-specific prompt
      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentSessionId,
          broadcast,
          systemPrompt: CONVERSATIONAL_CONSOLIDATION_PROMPT,
          inputBuilder: buildConversationalBatchInput,
        });
        allActions.push(...batchActions);
      }
    } else {
      // ── Coding / Default Path: original flow ───────────────────────
      const clusters = findClusters(allMemories);

      // ── Release embeddings after clustering ──────────────────────
      // Embeddings (1536-dim float arrays, ~12KB each) are only needed
      // for cosine similarity in findClusters(). Strip them now so
      // GC can reclaim before the LLM batch loop.
      for (const message of allMemories) {
        message.embedding = null;
      }

      logger.info(
        `[MemoryConsolidation] Found ${clusters.length} clusters from ${allMemories.length} memories`,
      );

      const staleMemories = allMemories.filter((message) => {
        const age = daysSince(message.createdAt);
        return (
          age > STALENESS_DAYS &&
          (message.type === "project" || message.type === "reference")
        );
      });
      logger.info(
        `[MemoryConsolidation] Found ${staleMemories.length} stale memories (>${STALENESS_DAYS} days, ephemeral types)`,
      );

      if (clusters.length === 0 && staleMemories.length === 0) {
        logger.info(
          "[MemoryConsolidation] No clusters or stale memories — nothing to consolidate",
        );
        await resetRunCount(project || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      batches = buildBatches(clusters, staleMemories);
      logger.info(
        `[MemoryConsolidation] Split into ${batches.length} batch(es) ` +
          `(${clusters.length} clusters, ${staleMemories.length} stale)`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentSessionId,
          broadcast,
        });
        allActions.push(...batchActions);
      }
    }

    if (allActions.length === 0) {
      logger.info(
        "[MemoryConsolidation] LLM found no actions needed across all batches",
      );
      await resetRunCount(project || guildId || "global");
      return {
        actions: 0,
        summary: "No consolidation needed",
        total: allMemories.length,
      };
    }

    // Apply all accumulated actions
    logger.info(
      `[MemoryConsolidation] Applying ${allActions.length} actions from ${batches.length} batch(es)`,
    );
    const results = await applyActions(
      allActions,
      agentId,
      agentType,
      project || null,
      username || "system",
      {
        traceId,
        endpoint,
        memoryLookup: isConversational ? memoryLookup : undefined,
      },
    );
    await resetRunCount(project || guildId || "global");
    const summary = `Merged ${results.merged}, deleted ${results.deleted} (${batches.length} batches)`;
    const durationMs = Math.round(performance.now() - startTime);
    logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMs}ms)`);

    // Record history for audit trail
    await recordHistory(
      project || guildId || "global",
      trigger || "manual",
      allMemories.length,
      allActions,
      summary,
      durationMs,
    );
    const consolidationResult = {
      ...results,
      actionsApplied: allActions.length,
      batchCount: batches.length,
      summary,
      total: allMemories.length,
      trigger,
      durationMs,
    };
    // Broadcast to connected clients if callback provided
    if (typeof broadcast === "function") {
      try {
        broadcast({
          type: "memory_consolidation_complete",
          project: project || null,
          ...consolidationResult,
        });
      } catch (error: unknown) {
        logger.warn(`[MemoryConsolidation] Broadcast failed: ${(error as Error).message}`);
      }
    }
    return consolidationResult;
  },
  /**
   * Check if consolidation should run and trigger if needed.
   * Called by MemoryExtractor after storing new memories.
   */
  async checkAndRun({
    project,
    username,
    broadcast,
    endpoint,
    agent,
    traceId,
    agentSessionId,
  }: CheckAndRunOptions) {
    try {
      await incrementRunCount(project || "global");
      const count = await getRunCount(project || "global");
      if (count >= SESSIONS_BETWEEN_RUNS) {
        logger.info(
          `[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`,
        );
        // Fire-and-forget
        MemoryConsolidationService.consolidate({
          agent: agent || "CODING",
          project,
          username,
          trigger: "session_threshold",
          broadcast,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentSessionId: agentSessionId || null,
        }).catch((error: unknown) =>
          logger.error(
            `[MemoryConsolidation] Background consolidation failed: ${(error as Error).message}`,
          ),
        );
      }
    } catch (error: unknown) {
      logger.error(
        `[MemoryConsolidation] checkAndRun failed: ${(error as Error).message}`,
      );
    }
  },
  async getHistory(project: string, limit: number = 10) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];
    return db
      .collection(HISTORY_COLLECTION)
      .find({ project })
      .sort({ runAt: -1 })
      .limit(limit)
      .project({ _id: 0 })
      .toArray();
  },
};
export default MemoryConsolidationService;
