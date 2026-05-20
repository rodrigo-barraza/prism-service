// @ts-ignore
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import MemoryService from "./MemoryService.js";
import RequestLogger from "./RequestLogger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { parseJsonFromLlmResponse } from "../utils/utilities.js";
import { COLLECTIONS } from "../constants.js";
import AgentPersonaRegistry from "./AgentPersonaRegistry.js";
import SettingsService from "./SettingsService.js";
import { estimateTokens, calculateTextCost, getTotalInputTokens, } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";
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
const CONVERSATIONAL_STALENESS_CONFIG = {
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
function daysSince(isoDate) {
    // @ts-ignore - TODO: strict typing
    return daysSinceIso(isoDate);
}
// ─── Cluster Detection ───────────────────────────────────────────────────────
/**
 * Find clusters of semantically similar memories using Union-Find.
 * Returns arrays of memory groups (each group has 2+ memories).
 */
// @ts-ignore - TODO: strict typing
function findClusters(memories, threshold = CLUSTER_THRESHOLD) {
    const n = memories.length;
    // @ts-ignore - TODO: strict typing
    if (n < 2)
        return [];
    // Union-Find
    // @ts-ignore - TODO: strict typing
    const parent = Array.from({ length: n }, (_, i) => i);
    const rank = new Array(n).fill(0);
    function find(x) {
        // @ts-ignore - TODO: strict typing
        if (parent[x] !== x)
            parent[x] = find(parent[x]);
        // @ts-ignore - TODO: strict typing
        return parent[x];
    }
    function union(x, y) {
        const px = find(x), py = find(y);
        if (px === py)
            return;
        // @ts-ignore - TODO: strict typing
        if (rank[px] < rank[py])
            parent[px] = py;
        // @ts-ignore - TODO: strict typing
        else if (rank[px] > rank[py])
            parent[py] = px;
        else {
            parent[py] = px;
            // @ts-ignore - TODO: strict typing
            rank[px]++;
        }
    }
    // Pairwise comparison — O(n²) but fine for <500 memories
    // @ts-ignore - TODO: strict typing
    for (let i = 0; i < n; i++) {
        // @ts-ignore - TODO: strict typing
        for (let j = i + 1; j < n; j++) {
            // @ts-ignore - TODO: strict typing
            if (!memories[i].embedding || !memories[j].embedding)
                continue;
            const sim = cosineSimilarity(
            // @ts-ignore - TODO: strict typing
            memories[i].embedding, 
            // @ts-ignore - TODO: strict typing
            memories[j].embedding);
            // @ts-ignore - TODO: strict typing
            if (sim > threshold) {
                // @ts-ignore - TODO: strict typing
                union(i, j);
            }
        }
    }
    // Group by root
    const groups = new Map();
    // @ts-ignore - TODO: strict typing
    for (let i = 0; i < n; i++) {
        // @ts-ignore - TODO: strict typing
        const root = find(i);
        if (!groups.has(root))
            groups.set(root, []);
        groups.get(root).push(memories[i]);
    }
    // Only return clusters with 2+ members, capped at MAX_CLUSTER_SIZE
    return [...groups.values()]
        // @ts-ignore - TODO: strict typing
        .filter((g) => g.length >= 2)
        // @ts-ignore - TODO: strict typing
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
function partitionConversationalMemories(memories) {
    const partitions = new Map();
    // @ts-ignore
    for (const m of memories) {
        const about = m.aboutUserId || "_unknown";
        const source = m.sourceUserId || "_unknown";
        const key = `${about}::${source}`;
        if (!partitions.has(key))
            partitions.set(key, []);
        partitions.get(key).push(m);
    }
    return partitions;
}
/**
 * Identify stale conversational agent memories using type-aware thresholds.
 * Only fast-decaying categories (gaming, work, achievement) are flagged.
 */
function findStaleConversationalMemories(memories) {
    // @ts-ignore - TODO: strict typing
    return memories.filter((m) => {
        // @ts-ignore
        const threshold = CONVERSATIONAL_STALENESS_CONFIG[m.type];
        if (!threshold)
            return false; // durable types (personal, preference, etc.) are never stale
        // @ts-ignore - TODO: strict typing
        return daysSince(m.createdAt) > threshold;
    });
}
// ─── Batch Building ──────────────────────────────────────────────────────────
/**
 * Format a single coding-type memory into the text representation used in LLM input.
 */
function formatMemoryEntry(m) {
    // @ts-ignore - TODO: strict typing
    const age = daysSince(m.createdAt);
    // @ts-ignore - TODO: strict typing
    return `- **ID**: ${m.id}\n  **Type**: ${m.type}\n  **Title**: ${m.title || (m.content ? m.content.substring(0, 60) : "untitled")}\n  **Content**: ${m.content}\n  **Age**: ${age} days`;
}
/**
 * Format a conversational agent memory entry with source attribution.
 */
function formatConversationalMemoryEntry(m) {
    // @ts-ignore - TODO: strict typing
    const age = daysSince(m.createdAt);
    return `- **ID**: ${m.id}\n  **Category**: ${m.type}\n  **About**: ${m.aboutUsername || "unknown"} (${m.aboutUserId || "?"})\n  **Source**: ${m.sourceUsername || "unknown"} (${m.sourceUserId || "?"})\n  **Content**: ${m.content}\n  **Age**: ${age} days`;
}
/**
 * Build the LLM input for a conversational agent batch — includes observer/subject context.
 */
function buildConversationalBatchInput(clusterBatch, staleBatch, partitionMeta) {
    const sections = [];
    if (partitionMeta) {
        // @ts-ignore - TODO: strict typing
        sections.push(`## Attribution Context`);
        sections.push(
        // @ts-ignore - TODO: strict typing
        `- **About user**: ${partitionMeta.aboutUsername} (ID: ${partitionMeta.aboutUserId})`);
        sections.push(
        // @ts-ignore - TODO: strict typing
        `- **Observed by**: ${partitionMeta.sourceUsername} (ID: ${partitionMeta.sourceUserId})`);
        // @ts-ignore - TODO: strict typing
        sections.push("");
    }
    // @ts-ignore - TODO: strict typing
    if (clusterBatch.length > 0) {
        // @ts-ignore - TODO: strict typing
        sections.push("## Clusters of Similar Facts\n");
        // @ts-ignore - TODO: strict typing
        clusterBatch.forEach((cluster, i) => {
            sections.push(
            // @ts-ignore - TODO: strict typing
            `### Cluster ${i + 1} (${cluster.length} facts, likely overlap):`);
            // @ts-ignore - TODO: strict typing
            cluster.forEach((m) => {
                // @ts-ignore - TODO: strict typing
                sections.push(formatConversationalMemoryEntry(m));
            });
            // @ts-ignore - TODO: strict typing
            sections.push("");
        });
    }
    // @ts-ignore - TODO: strict typing
    if (staleBatch.length > 0) {
        // @ts-ignore - TODO: strict typing
        sections.push("## Potentially Stale Facts\n");
        // @ts-ignore - TODO: strict typing
        staleBatch.forEach((m) => {
            // @ts-ignore - TODO: strict typing
            sections.push(formatConversationalMemoryEntry(m));
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
function buildBatchInput(clusterBatch, staleBatch) {
    const sections = [];
    // @ts-ignore - TODO: strict typing
    if (clusterBatch.length > 0) {
        // @ts-ignore - TODO: strict typing
        sections.push("## Clusters of Similar Memories\n");
        // @ts-ignore - TODO: strict typing
        clusterBatch.forEach((cluster, i) => {
            sections.push(
            // @ts-ignore - TODO: strict typing
            `### Cluster ${i + 1} (${cluster.length} memories, likely overlap):`);
            // @ts-ignore - TODO: strict typing
            cluster.forEach((m) => {
                // @ts-ignore - TODO: strict typing
                sections.push(formatMemoryEntry(m));
            });
            // @ts-ignore - TODO: strict typing
            sections.push("");
        });
    }
    // @ts-ignore - TODO: strict typing
    if (staleBatch.length > 0) {
        sections.push(
        // @ts-ignore - TODO: strict typing
        "## Potentially Stale Memories (>30 days old, ephemeral types)\n");
        // @ts-ignore - TODO: strict typing
        staleBatch.forEach((m) => {
            // @ts-ignore - TODO: strict typing
            sections.push(formatMemoryEntry(m));
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
function buildBatches(clusters, staleMemories) {
    const batches = [];
    let clusterIdx = 0;
    let staleIdx = 0;
    // First, batch clusters (primary merge candidates)
    // @ts-ignore - TODO: strict typing
    while (clusterIdx < clusters.length) {
        const batchClusters = [];
        let batchTokens = 0;
        while (
        // @ts-ignore - TODO: strict typing
        clusterIdx < clusters.length &&
            batchClusters.length < BATCH_MAX_CLUSTERS) {
            // @ts-ignore - TODO: strict typing
            const clusterText = clusters[clusterIdx]
                .map(formatMemoryEntry)
                .join("\n");
            const clusterTokens = estimateTokens(clusterText);
            if (batchTokens + clusterTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchClusters.length > 0) {
                break; // This cluster would exceed budget — start a new batch
            }
            // @ts-ignore - TODO: strict typing
            batchClusters.push(clusters[clusterIdx]);
            batchTokens += clusterTokens;
            clusterIdx++;
        }
        // Attach stale memories to the first cluster batch that has room
        const batchStale = [];
        while (
        // @ts-ignore - TODO: strict typing
        staleIdx < staleMemories.length &&
            batchStale.length < BATCH_MAX_STALE) {
            // @ts-ignore - TODO: strict typing
            const entryText = formatMemoryEntry(staleMemories[staleIdx]);
            // @ts-ignore - TODO: strict typing
            const entryTokens = estimateTokens(entryText);
            if (batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchStale.length > 0) {
                break;
            }
            // @ts-ignore - TODO: strict typing
            batchStale.push(staleMemories[staleIdx]);
            batchTokens += entryTokens;
            staleIdx++;
        }
        if (batchClusters.length > 0 || batchStale.length > 0) {
            batches.push({ clusters: batchClusters, stale: batchStale });
        }
    }
    // Any remaining stale memories that didn't fit into cluster batches
    // @ts-ignore - TODO: strict typing
    while (staleIdx < staleMemories.length) {
        const batchStale = [];
        let batchTokens = 0;
        while (
        // @ts-ignore - TODO: strict typing
        staleIdx < staleMemories.length &&
            batchStale.length < BATCH_MAX_STALE) {
            // @ts-ignore - TODO: strict typing
            const entryText = formatMemoryEntry(staleMemories[staleIdx]);
            // @ts-ignore - TODO: strict typing
            const entryTokens = estimateTokens(entryText);
            if (batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchStale.length > 0) {
                break;
            }
            // @ts-ignore - TODO: strict typing
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
// @ts-ignore
async function applyActions(actions, agent, agentType, project, username, 
// @ts-ignore
{ traceId, endpoint, memoryLookup } = {}) {
    const results = { merged: 0, deleted: 0, errors: 0 };
    // @ts-ignore - TODO: strict typing
    const isConversational = agentType === "conversational";
    // @ts-ignore
    for (const action of actions) {
        try {
            if (action.type === "merge" &&
                action.sourceIds?.length >= 2 &&
                action.merged) {
                // Collect conversational agent metadata from source memories before deletion
                let attributionMetadata = {};
                if (isConversational && memoryLookup) {
                    const sources = action.sourceIds
                        // @ts-ignore - TODO: strict typing
                        .map((id) => memoryLookup.get(id))
                        .filter(Boolean);
                    if (sources.length > 0) {
                        // All memories in a merge share the same about/source (partitioned)
                        const primary = sources[0];
                        // Collect all unique sources for the mergedSources attribution chain
                        const uniqueSources = new Map();
                        // @ts-ignore
                        for (const s of sources) {
                            if (s.sourceUserId && !uniqueSources.has(s.sourceUserId)) {
                                uniqueSources.set(s.sourceUserId, {
                                    sourceUserId: s.sourceUserId,
                                    sourceUsername: s.sourceUsername,
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
                // @ts-ignore
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
                    traceId: traceId || null,
                    endpoint: endpoint || null,
                    ...attributionMetadata,
                });
                results.merged += action.sourceIds.length;
                logger.info(`[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title || action.merged.content?.substring(0, 60)}" (${action.reason || ""})`);
            }
            else if (action.type === "delete" && action.id) {
                await MemoryService.remove(action.id);
                results.deleted++;
                logger.info(`[MemoryConsolidation] Deleted "${action.id}" (${action.reason || ""})`);
            }
        }
        catch (error) {
            results.errors++;
            logger.error(
            // @ts-ignore - TODO: strict typing
            `[MemoryConsolidation] Failed to apply action: ${error.message}`);
        }
    }
    return results;
}
// ─── Run Tracking ────────────────────────────────────────────────────────────
async function getRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return 0;
    const document = await db.collection(RUNS_COLLECTION).findOne({ project });
    return document?.sessionsSinceLastRun || 0;
}
async function incrementRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    await db
        .collection(RUNS_COLLECTION)
        .updateOne({ project }, { $inc: { sessionsSinceLastRun: 1 } }, { upsert: true });
}
async function resetRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    await db.collection(RUNS_COLLECTION).updateOne({ project }, {
        $set: {
            sessionsSinceLastRun: 0,
            lastConsolidatedAt: new Date().toISOString(),
        },
    }, { upsert: true });
}
// ─── History & Cost Guard ────────────────────────────────────────────────────
/**
 * Record a consolidation run for audit trail.
 */
async function recordHistory(project, trigger, memoriesBefore, actions, summary, durationMs) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    // @ts-ignore - TODO: strict typing
    const mergeCount = actions
        .filter((a) => a.type === "merge")
        // @ts-ignore - TODO: strict typing
        .reduce((sum, a) => sum + (a.sourceIds?.length || 0), 0);
    // @ts-ignore - TODO: strict typing
    const deleteCount = actions.filter((a) => a.type === "delete").length;
    await db.collection(HISTORY_COLLECTION).insertOne({
        project,
        runAt: new Date().toISOString(),
        trigger,
        memoriesBefore,
        memoriesAfter: 
        // @ts-ignore - TODO: strict typing
        memoriesBefore -
            mergeCount -
            deleteCount +
            // @ts-ignore - TODO: strict typing
            actions.filter((a) => a.type === "merge").length,
        actionsApplied: actions.length,
        // @ts-ignore - TODO: strict typing
        actions: actions.map((a) => ({
            type: a.type,
            // @ts-ignore - TODO: strict typing
            ...(a.sourceIds && { sourceIds: a.sourceIds }),
            // @ts-ignore - TODO: strict typing
            ...(a.merged && { mergedTitle: a.merged.title }),
            // @ts-ignore - TODO: strict typing
            ...(a.id && { deletedId: a.id }),
            reason: a.reason || "",
        })),
        summary,
        durationMs,
    });
}
/**
 * Check if the daily consolidation budget is exhausted.
 * Returns true if more runs are allowed.
 */
async function canRunToday(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return true;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.collection(HISTORY_COLLECTION).countDocuments({
        project,
        runAt: { $gte: startOfDay.toISOString() },
    });
    if (todayCount >= DAILY_MAX_CONSOLIDATIONS) {
        logger.warn(`[MemoryConsolidation] Daily limit reached for "${project}" (${todayCount}/${DAILY_MAX_CONSOLIDATIONS})`);
        return false;
    }
    return true;
}
// ─── Single Batch LLM Call ───────────────────────────────────────────────────
/**
 * Run a single LLM consolidation call for one batch.
 * Returns parsed actions array, or empty array on failure.
 */
async function processBatch(batch, batchIndex, totalBatches, { provider, consolidationProvider, consolidationModel, agent, project, username, trigger, endpoint, traceId, agentSessionId, broadcast, systemPrompt = CONSOLIDATION_PROMPT, inputBuilder, }) {
    const input = inputBuilder
        // @ts-ignore - TODO: strict typing
        ? inputBuilder(batch.clusters, batch.stale, batch.partitionMeta)
        // @ts-ignore - TODO: strict typing
        : buildBatchInput(batch.clusters, batch.stale);
    if (!input)
        return [];
    // @ts-ignore - TODO: strict typing
    const batchLabel = `[batch ${batchIndex + 1}/${totalBatches}]`;
    // @ts-ignore - TODO: strict typing
    const clusterCount = batch.clusters.length;
    // @ts-ignore - TODO: strict typing
    const staleCount = batch.stale.length;
    logger.info(`[MemoryConsolidation] ${batchLabel} Processing ${clusterCount} clusters, ${staleCount} stale memories`);
    const aiMessages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
    ];
    const inputText = aiMessages.map((m) => m.content).join("\n");
    // @ts-ignore - TODO: strict typing
    const approxInputTokens = estimateTokens(inputText);
    logger.info(`[MemoryConsolidation] ${batchLabel} Input: ~${approxInputTokens} tokens`);
    const llmRequestId = crypto.randomUUID();
    const llmStart = performance.now();
    let llmSuccess = true;
    let llmError = null;
    let result;
    try {
        // @ts-ignore - TODO: strict typing
        result = await provider.generateText(aiMessages, consolidationModel, {
            maxTokens: LLM_MAX_OUTPUT_TOKENS,
            temperature: 0.1,
        });
    }
    catch (error) {
        llmSuccess = false;
        // @ts-ignore - TODO: strict typing
        llmError = error.message;
        logger.error(
        // @ts-ignore - TODO: strict typing
        `[MemoryConsolidation] ${batchLabel} LLM call failed: ${error.message}`);
    }
    // Use real API-reported usage when available; fall back to heuristic
    // @ts-ignore - TODO: strict typing
    const realUsage = result?.usage || null;
    const inputTokens = realUsage
        // @ts-ignore - TODO: strict typing
        ? getTotalInputTokens(realUsage)
        // @ts-ignore - TODO: strict typing
        : estimateTokens(inputText);
    const outputTokens = realUsage
        // @ts-ignore - TODO: strict typing
        ? realUsage.outputTokens || 0
        // @ts-ignore - TODO: strict typing
        : result?.text
            // @ts-ignore - TODO: strict typing
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
        // @ts-ignore - TODO: strict typing
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
            // @ts-ignore
            const consolidatePricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
            // @ts-ignore - TODO: strict typing
            consolidationModel];
            const consolidateCost = consolidatePricing
                ? calculateTextCost(
                // @ts-ignore - TODO: strict typing
                realUsage || { inputTokens, outputTokens }, consolidatePricing)
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
        }
        catch {
            /* SSE channel may be closed */
        }
    }
    // @ts-ignore - TODO: strict typing
    if (!llmSuccess || !result?.text) {
        return [];
    }
    // Parse response with enhanced diagnostics
    // @ts-ignore - TODO: strict typing
    const parsed = parseJsonFromLlmResponse(result.text);
    if (!parsed) {
        // @ts-ignore - TODO: strict typing
        const responseLen = result.text?.length || 0;
        // @ts-ignore - TODO: strict typing
        const snippet = result.text?.substring(0, 300) || "(empty)";
        const tail = 
        // @ts-ignore - TODO: strict typing
        responseLen > 300 ? result.text.substring(responseLen - 200) : "";
        logger.warn(`[MemoryConsolidation] ${batchLabel} Failed to parse LLM response ` +
            `(${responseLen} chars, ~${outputTokens} tokens). ` +
            `Head: ${snippet}${tail ? `\n  Tail: ${tail}` : ""}`);
        return [];
    }
    return parsed.actions || [];
}
// ─── Public API ──────────────────────────────────────────────────────────────
const MemoryConsolidationService = {
    /**
     * Run memory consolidation for a specific agent within a project.
     * Processes memories in batches to avoid context window overflow.
     *
  
     * @param {string} params.agent - Agent identifier
     * @param {string} params.project - Project identifier
  
  
     * @returns {Promise<object>} Consolidation results
     */
    async consolidate({ agent = "CODING", project, username, trigger = "manual", broadcast, endpoint, traceId, agentSessionId, guildId, }) {
        const startTime = performance.now();
        const agentId = agent || "CODING";
        // @ts-ignore - TODO: strict typing
        const persona = AgentPersonaRegistry.get(agentId);
        const agentType = persona?.type || "";
        const isConversational = agentType === "conversational";
        logger.info(`[MemoryConsolidation] Starting ${agentType || "general"} consolidation for agent "${agentId}", project "${project}" (trigger: ${trigger})`);
        // Cost guard — check daily budget
        // @ts-ignore - TODO: strict typing
        if (!(await canRunToday(project))) {
            return { skipped: true, reason: "daily_limit_reached", total: 0 };
        }
        // Load all memories with embeddings (LUPOS needs extra fields)
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            throw new Error("Database not available");
        const query = { agent: agentId };
        // @ts-ignore
        if (project)
            query.project = project;
        // @ts-ignore
        if (isConversational && guildId)
            query.guildId = guildId;
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
            .toArray();
        if (allMemories.length < 2) {
            logger.info(`[MemoryConsolidation] Only ${allMemories.length} memories — skipping`);
            // @ts-ignore - TODO: strict typing
            await resetRunCount(project || guildId || "global");
            return {
                skipped: true,
                reason: "insufficient memories",
                total: allMemories.length,
            };
        }
        logger.info(`[MemoryConsolidation] Loaded ${allMemories.length} memories for clustering`);
        // Resolve the consolidation model
        const { provider: consolidationProvider, model: consolidationModel } = await getConsolidationConfig();
        const provider = getProvider(consolidationProvider);
        // Build a lookup map for metadata preservation during merges
        const memoryLookup = new Map(allMemories.map((m) => [m.id, m]));
        let allActions;
        let batches;
        if (isConversational) {
            // ── Conversational Path: partition by (aboutUserId, sourceUserId) ────
            // @ts-ignore - TODO: strict typing
            const partitions = partitionConversationalMemories(allMemories);
            logger.info(`[MemoryConsolidation] Conversational (${agentId}): ${partitions.size} partitions (unique observer→subject pairs)`);
            // @ts-ignore - TODO: strict typing
            batches = [];
            // @ts-ignore
            for (const [key, memories] of partitions) {
                if (memories.length < 2)
                    continue;
                // Cluster within this partition using the higher conversational threshold
                const partitionClusters = findClusters(memories, 
                // @ts-ignore - TODO: strict typing
                CONVERSATIONAL_CLUSTER_THRESHOLD);
                const partitionStale = findStaleConversationalMemories(memories);
                // ── Release embeddings after clustering ──────────────────────
                // Embeddings (1536-dim float arrays, ~12KB each) are only needed
                // for cosine similarity in findClusters(). Strip them now so
                // GC can reclaim before the LLM batch loop.
                // @ts-ignore
                for (const m of memories) {
                    m.embedding = null;
                }
                if (partitionClusters.length === 0 && partitionStale.length === 0)
                    continue;
                // Extract metadata for the partition header
                const sample = memories[0];
                const partitionMeta = {
                    aboutUserId: sample.aboutUserId,
                    aboutUsername: sample.aboutUsername,
                    sourceUserId: sample.sourceUserId,
                    sourceUsername: sample.sourceUsername,
                };
                // Build batches for this partition
                const partitionBatches = buildBatches(
                // @ts-ignore - TODO: strict typing
                partitionClusters, partitionStale);
                // @ts-ignore
                for (const b of partitionBatches) {
                    // @ts-ignore
                    b.partitionMeta = partitionMeta;
                }
                // @ts-ignore - TODO: strict typing
                batches.push(...partitionBatches);
                logger.info(`[MemoryConsolidation] Conversational partition ${key}: ${memories.length} memories → ${partitionClusters.length} clusters, ${partitionStale.length} stale`);
            }
            if (batches.length === 0) {
                logger.info(`[MemoryConsolidation] Conversational (${agentId}): No consolidation candidates across partitions`);
                // @ts-ignore - TODO: strict typing
                await resetRunCount(project || guildId || "global");
                return {
                    skipped: true,
                    reason: "no candidates",
                    total: allMemories.length,
                };
            }
            // Process conversational batches with the conversational-specific prompt
            // @ts-ignore - TODO: strict typing
            allActions = [];
            // @ts-ignore - TODO: strict typing
            for (let i = 0; i < batches.length; i++) {
                // @ts-ignore - TODO: strict typing
                const batchActions = await processBatch(batches[i], i, batches.length, {
                    provider,
                    consolidationProvider,
                    consolidationModel,
                    agent: agentId,
                    project,
                    username,
                    trigger,
                    endpoint,
                    traceId,
                    agentSessionId,
                    broadcast,
                    systemPrompt: CONVERSATIONAL_CONSOLIDATION_PROMPT,
                    inputBuilder: buildConversationalBatchInput,
                });
                // @ts-ignore - TODO: strict typing
                allActions.push(...batchActions);
            }
        }
        else {
            // ── Coding / Default Path: original flow ───────────────────────
            // @ts-ignore - TODO: strict typing
            const clusters = findClusters(allMemories);
            // ── Release embeddings after clustering ──────────────────────
            // Embeddings (1536-dim float arrays, ~12KB each) are only needed
            // for cosine similarity in findClusters(). Strip them now so
            // GC can reclaim before the LLM batch loop.
            // @ts-ignore
            for (const m of allMemories) {
                m.embedding = null;
            }
            logger.info(`[MemoryConsolidation] Found ${clusters.length} clusters from ${allMemories.length} memories`);
            const staleMemories = allMemories.filter((m) => {
                // @ts-ignore - TODO: strict typing
                const age = daysSince(m.createdAt);
                return (age > STALENESS_DAYS &&
                    (m.type === "project" || m.type === "reference"));
            });
            logger.info(`[MemoryConsolidation] Found ${staleMemories.length} stale memories (>${STALENESS_DAYS} days, ephemeral types)`);
            if (clusters.length === 0 && staleMemories.length === 0) {
                logger.info("[MemoryConsolidation] No clusters or stale memories — nothing to consolidate");
                // @ts-ignore - TODO: strict typing
                await resetRunCount(project);
                return {
                    skipped: true,
                    reason: "no candidates",
                    total: allMemories.length,
                };
            }
            // @ts-ignore - TODO: strict typing
            batches = buildBatches(clusters, staleMemories);
            logger.info(`[MemoryConsolidation] Split into ${batches.length} batch(es) ` +
                `(${clusters.length} clusters, ${staleMemories.length} stale)`);
            // @ts-ignore - TODO: strict typing
            allActions = [];
            // @ts-ignore - TODO: strict typing
            for (let i = 0; i < batches.length; i++) {
                // @ts-ignore - TODO: strict typing
                const batchActions = await processBatch(batches[i], i, batches.length, {
                    provider,
                    consolidationProvider,
                    consolidationModel,
                    agent: agentId,
                    project,
                    username,
                    trigger,
                    endpoint,
                    traceId,
                    agentSessionId,
                    broadcast,
                });
                // @ts-ignore - TODO: strict typing
                allActions.push(...batchActions);
            }
        }
        if (allActions.length === 0) {
            logger.info("[MemoryConsolidation] LLM found no actions needed across all batches");
            // @ts-ignore - TODO: strict typing
            await resetRunCount(project || guildId || "global");
            return {
                actions: 0,
                summary: "No consolidation needed",
                total: allMemories.length,
            };
        }
        // Apply all accumulated actions
        logger.info(`[MemoryConsolidation] Applying ${allActions.length} actions from ${batches.length} batch(es)`);
        const results = await applyActions(allActions, 
        // @ts-ignore - TODO: strict typing
        agentId, agentType, project, username, {
            traceId,
            endpoint,
            memoryLookup: isConversational ? memoryLookup : undefined,
        });
        // @ts-ignore - TODO: strict typing
        await resetRunCount(project || guildId || "global");
        const summary = `Merged ${results.merged}, deleted ${results.deleted} (${batches.length} batches)`;
        const durationMs = Math.round(performance.now() - startTime);
        logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMs}ms)`);
        // Record history for audit trail
        await recordHistory(
        // @ts-ignore - TODO: strict typing
        project || guildId || "global", trigger, allMemories.length, allActions, summary, durationMs);
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
                    project,
                    ...consolidationResult,
                });
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                logger.warn(`[MemoryConsolidation] Broadcast failed: ${error.message}`);
            }
        }
        return consolidationResult;
    },
    /**
     * Check if consolidation should run and trigger if needed.
     * Called by MemoryExtractor after storing new memories.
     *
  
     * @param {string} params.project - Project identifier
  
  
     */
    async checkAndRun({ project, username, broadcast, endpoint, agent, traceId, agentSessionId, }) {
        try {
            // @ts-ignore - TODO: strict typing
            await incrementRunCount(project);
            // @ts-ignore - TODO: strict typing
            const count = await getRunCount(project);
            if (count >= SESSIONS_BETWEEN_RUNS) {
                logger.info(`[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`);
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
                }).catch((error) => logger.error(`[MemoryConsolidation] Background consolidation failed: ${error.message}`));
            }
        }
        catch (error) {
            logger.error(
            // @ts-ignore - TODO: strict typing
            `[MemoryConsolidation] checkAndRun failed: ${error.message}`);
        }
    },
    /**
     * Get consolidation run history for a project.
     *
  
  
     * @returns {Promise<Array>} Consolidation history entries, newest first
     */
    // @ts-ignore - TODO: strict typing
    async getHistory(project, limit = 10) {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return [];
        return db
            .collection(HISTORY_COLLECTION)
            .find({ project })
            .sort({ runAt: -1 })
            // @ts-ignore - TODO: strict typing
            .limit(limit)
            .project({ _id: 0 })
            .toArray();
    },
};
export default MemoryConsolidationService;
//# sourceMappingURL=MemoryConsolidationService.js.map