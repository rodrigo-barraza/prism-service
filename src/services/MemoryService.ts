import {
  AGENT_IDS,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { getProvider } from "#src/providers/index";
import { MONGO_DB_NAME } from "#config";
import EmbeddingService from "./EmbeddingService.ts";
import PromptLocaleService from "./PromptLocaleService.ts";
import RequestLogger from "./RequestLogger.ts";
import logger from "#src/utils/logger";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS, MEMORY, LOG_PREVIEW } from "#src/constants";
import { scoreHybrid } from "./memory/HybridRetrieval.ts";
import SettingsService from "./SettingsService.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
// ─── Constants ────────────────────────────────────────────────────────────────
/** Single unified collection for all agent memories. */
const COLLECTION = COLLECTIONS.MEMORIES;
/** Resolve the current extraction provider + model from settings. */
async function getExtractionConfig() {
  return SettingsService.getMemoryModelConfig("extraction");
}
/**
 * Duplicate detection threshold — two memories with cosine similarity above
 * this are considered duplicates and the newer one is skipped.
 */
const DUPLICATE_THRESHOLD = MEMORY.DUPLICATE_THRESHOLD;
const RELEVANCE_THRESHOLD = MEMORY.RELEVANCE_THRESHOLD;
/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to these types. LUPOS additionally uses its own
 * category values (personal, preference, gaming, etc.) stored in the `type`
 * field — the schema is flexible per agent.
 */
export const CODING_MEMORY_TYPES = ["user", "feedback", "project", "reference"];
// ─── Types ────────────────────────────────────────────────────────────────────
export interface MemoryStoreParams {
  agent: string;
  project?: string | null;
  username?: string | null;
  type?: string;
  title?: string | null;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
  /**
   * Skip write-time duplicate detection. Used by consolidation when storing
   * a merged memory whose content is intentionally similar to the (about to
   * be soft-closed) sources.
   */
  dedupe?: boolean;
}

export interface MemoryInvalidateParams {
  /** Id of the memory that replaces this one (merge target or newer fact). */
  supersededBy?: string | null;
  /** Why the memory was closed — "merged", "invalidated", "rollback", ... */
  reason?: string | null;
}

export interface MemoryExtractAndStoreParams {
  guildId?: string;
  channelId?: string;
  messages: Record<string, unknown>[];
  participants: Record<string, unknown>[];
  sourceMessageId?: string;
  traceId?: string;
  project?: string;
  endpoint?: string;
}
export interface MemorySearchParams {
  agent: string;
  project?: string | null;
  guildId?: string;
  userIds?: string[];
  queryText: string;
  limit?: number;
  conversationId?: string;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
  username?: string;
}

export interface MemoryListParams {
  agent?: string;
  project?: string | null;
  guildId?: string;
  userId?: string;
  aboutUserId?: string;
  sourceUserId?: string;
  limit?: number;
  skip?: number;
  type?: string;
  /** Include soft-closed (superseded/invalidated) rows — history view. */
  includeSuperseded?: boolean;
}

export interface MemoryFacetsParams {
  agent?: string;
  project?: string | null;
  guildId?: string;
}

export interface MemoryUpdateParams {
  title?: string;
  content?: string;
  type?: string;
}

export interface EmbedOptions {
  source?: string;
  project?: string | null;
  conversationId?: string;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
  agent?: string;
  username?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function generateEmbedding(text: string, options: EmbedOptions = {}) {
  return EmbeddingService.embed(text, { source: "memory", ...options });
}
function memoryAgeDays(createdAt: string) {
  return daysSinceIso(createdAt);
}
/**
 * Human-readable age string. Models are poor at date arithmetic —
 * "47 days ago" triggers staleness reasoning better than a raw ISO timestamp.
 */
function memoryAge(createdAt: string) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}
/**
 * Staleness caveat for memories >1 day old.
 * Returns empty string for fresh memories.
 * Plain style is for conversational personas — "verify against current
 * code" is coding-agent language that leaks oddly into chat prompts.
 */
function freshnessCaveat(createdAt: string, plain: boolean = false) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays <= 1) return "";
  if (plain) return ` (may be out of date — noted ${ageDays} days ago)`;
  return ` ⚠️ ${ageDays} days old — verify against current code before acting on this.`;
}
interface ExtractedFact {
  fact: string;
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId?: string;
  sourceUsername?: string;
  category?: string;
  confidence?: number;
}

// ─── LUPOS Fact Extraction ────────────────────────────────────────────────────
/**
 * Call an AI provider to extract facts from a conversation.
 * Returns an array of { fact, aboutUserId, aboutUsername, category, confidence }.
 */
async function extractFactsFromConversation(
  messages: Record<string, unknown>[],
  participants: Record<string, unknown>[],
  meta: Record<string, unknown> = {},
): Promise<ExtractedFact[]> {
  const endpoint = meta.endpoint || null;
  const agent = meta.agent || null;
  const { provider: extractionProvider, model: extractionModel } =
    await getExtractionConfig();
  const provider = getProvider(extractionProvider);
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  const participantList = participants
    .map(
      (participant: Record<string, unknown>) =>
        `- ID: ${participant.id}, Username: ${participant.username}, Display: ${participant.displayName || participant.username}`,
    )
    .join("\n");
  const conversationText = messages
    .map(
      (message: Record<string, unknown>) =>
        `${message.name || message.role}: ${message.content}`,
    )
    .join("\n");
  const systemPrompt = PromptLocaleService.get(
    "en",
    "memory.discordExtractionPrompt",
    { participantList },
  );
  const aiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: PromptLocaleService.get(
        "en",
        "memory.discordExtractInstruction",
        { conversationText },
      ),
    },
  ];
  let result: { text: string; usage?: Record<string, unknown> } | undefined;
  let success = true;
  let errorMessage = null;
  try {
    result = await provider.generateText(aiMessages, extractionModel, {
      maxTokens: MEMORY.EXTRACTION_MAX_TOKENS,
      temperature: 0.1,
    });
  } catch (error: unknown) {
    success = false;
    errorMessage = getErrorMessage(error);
    throw error;
  } finally {
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint: endpoint as string | null,
      operation: "memory:extract",
      project: (meta.project as string) || null,
      username: (meta.username as string) || "system",
      agent: agent as string | null,
      provider: extractionProvider,
      model: extractionModel,
      traceId: (meta.traceId as string) || null,
      agentConversationId: (meta.agentConversationId as string) || null,
      aiMessages,
      resultText: result?.text || "",
      usage: result?.usage || null,
      success,
      errorMessage,
      requestStartMilliseconds: requestStart,
      extraRequestPayload: {
        participantCount: participants.length,
        messageCount: messages.length,
      },
    });
  }
  const facts = parseJsonFromLargeLanguageModelResponse(result?.text);
  if (!Array.isArray(facts)) return [];
  // Validate each fact has the required fields
  return (facts as Record<string, unknown>[]).filter(
    (fact: Record<string, unknown>) =>
      fact.fact &&
      fact.aboutUserId &&
      fact.aboutUsername &&
      typeof fact.confidence === "number" &&
      fact.confidence >= 0.5,
  ) as unknown as ExtractedFact[];
}
// ─── Unified Memory Service ──────────────────────────────────────────────────
/**
 * MemoryService — unified, agent-scoped memory system.
 *
 * All memories live in a single `memories` collection. Every document carries
 * an `agent` field ("LUPOS", "CODING", etc.) and all queries filter by it,
 * ensuring complete isolation between agents.
 *
 * LUPOS memories: personal facts about Discord users (guild-scoped)
 * CODING memories: project knowledge from coding sessions (project-scoped)
 *
 * Temporal model (bi-temporal-lite): memories are versioned, not destroyed.
 * `createdAt` doubles as valid-from; a superseded/invalidated memory gets
 * `validTo` (close of its valid-time window), `supersededBy` (id of the
 * replacement), and `closedReason` — never a delete. All read paths filter
 * to current rows ({ validTo: null } matches both null and missing).
 * Write-time dedup is ADD-only above the exact-duplicate bar: similar-but-
 * different facts are stored, and contradiction resolution is deferred to
 * retrieval ranking + consolidation.
 *
 * Research basis (harness_landscape_survey_2026-07.md, B1):
 *  - Graphiti (Zep) — on contradiction, close the old edge's valid-time
 *    window and open a new edge; history stays queryable, nothing deleted:
 *    https://github.com/getzep/graphiti
 *  - Mem0 v3 — single-pass ADD-only extraction; conflict resolution moves
 *    to retrieval-time ranking (LoCoMo 71.4→91.6):
 *    https://docs.mem0.ai/migration/platform-v2-to-v3
 *  - TOKI (Wang, arXiv 2606.06240) — contradiction resolution as write-time
 *    concurrency control over a bitemporal schema:
 *    https://arxiv.org/abs/2606.06240
 */

/**
 * Filter clause selecting only CURRENT (not superseded/invalidated) rows.
 * `{ validTo: null }` matches documents where the field is null OR missing,
 * so legacy documents predating the temporal model remain visible.
 */
export const CURRENT_MEMORY_FILTER = { validTo: null } as const;

const MemoryService = {
  // ── Store ──────────────────────────────────────────────────────────────────
  async store({
    agent,
    project,
    username,
    type,
    title,
    content,
    embedding,
    metadata = {},
    conversationId,
    traceId,
    agentConversationId,
    endpoint,
    dedupe = true,
  }: MemoryStoreParams) {
    if (!agent)
      throw new Error("MemoryService.store requires an agent identifier");
    if (!content) throw new Error("MemoryService.store requires content");
    // Validate type for CODING agent
    if (agent === AGENT_IDS.CODING) {
      type = CODING_MEMORY_TYPES.includes(type as string) ? type : "project";
    }
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    if (!collection) {
      logger.warn(`[MemoryService] store: collection ${COLLECTION} not available`);
      return null;
    }
    const embedText = title ? `${title}: ${content}` : content;
    // Generate embedding if not provided
    if (!embedding) {
      const embedOpts: EmbedOptions = { project };
      if (conversationId) embedOpts.conversationId = conversationId;
      if (traceId) embedOpts.traceId = traceId;
      if (agentConversationId)
        embedOpts.agentConversationId = agentConversationId;
      if (endpoint) embedOpts.endpoint = endpoint;
      if (agent) embedOpts.agent = agent;
      if (username) embedOpts.username = username;
      embedding = await generateEmbedding(embedText, embedOpts);
    }
    // Write-time duplicate detection — ADD-only policy (Mem0 v3):
    // only a verbatim re-extraction (similarity above the exact bar) is
    // skipped. A similar-but-different memory (e.g. "moved to Victoria" vs
    // "lives in Vancouver") is STORED — dropping it was silent data loss.
    // Contradiction resolution belongs to retrieval ranking + consolidation.
    if (dedupe) {
      const dedupFilter: Record<string, unknown> = {
        agent,
        ...CURRENT_MEMORY_FILTER,
      };
      if (project) dedupFilter.project = project;
      if (metadata.guildId) dedupFilter.guildId = metadata.guildId;
      if (metadata.aboutUserId) dedupFilter.aboutUserId = metadata.aboutUserId;
      const existing = await collection
        .find(dedupFilter)
        .project({ embedding: 1 })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      let maximumSimilarity = 0;
      for (const document of existing as Record<string, unknown>[]) {
        if (!document.embedding) continue;
        const similarity = cosineSimilarity(
          embedding as number[],
          document.embedding as number[],
        );
        if (similarity > maximumSimilarity) maximumSimilarity = similarity;
      }
      if (maximumSimilarity > MEMORY.EXACT_DUPLICATE_THRESHOLD) {
        logger.info(
          `[MemoryService] Skipping verbatim duplicate for ${agent}: "${(title || content).substring(0, LOG_PREVIEW.SHORT)}"`,
        );
        return null;
      }
      if (maximumSimilarity > DUPLICATE_THRESHOLD) {
        logger.info(
          `[MemoryService] Storing near-duplicate for ${agent} (similarity ${maximumSimilarity.toFixed(3)}, ADD-only policy): ` +
            `"${(title || content).substring(0, LOG_PREVIEW.SHORT)}"`,
        );
      }
    }
    const now = new Date().toISOString();
    const memory = {
      // Spread agent-specific metadata first — core fields below take precedence
      // to prevent accidental overwrites of id, agent, embedding, etc.
      ...metadata,
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      username: username || null,
      type: type || "other",
      title: title || null,
      content,
      embedding,
      conversationId: conversationId || null,
      agentConversationId: agentConversationId || null,
      createdAt: now,
      updatedAt: now,
      // Bi-temporal validity — createdAt doubles as valid-from; a soft-close
      // sets validTo + supersededBy + closedReason instead of deleting.
      validTo: null,
      supersededBy: null,
    };
    await collection.insertOne(memory);
    logger.info(
      `[MemoryService] Stored [${agent}/${memory.type}] "${(title || content).substring(0, LOG_PREVIEW.SHORT)}"`,
    );
    return memory;
  },
  // ── LUPOS: Extract & Store ─────────────────────────────────────────────────
  async extractAndStore({
    guildId,
    channelId,
    messages,
    participants,
    sourceMessageId,
    traceId,
    project,
    endpoint,
  }: MemoryExtractAndStoreParams) {
    // Extract facts from the conversation via AI
    const facts = await extractFactsFromConversation(messages, participants, {
      project,
      traceId,
      endpoint,
      agent: AGENT_IDS.LUPOS,
    });
    if (facts.length === 0) {
      logger.info(
        "[MemoryService] No personal facts extracted from conversation.",
      );
      return [];
    }
    logger.info(
      `[MemoryService] Extracted ${facts.length} fact(s), generating embeddings...`,
    );
    const storedMemories: Record<string, unknown>[] = [];
    for (const fact of facts) {
      try {
        const embedding = await generateEmbedding(fact.fact, {
          project,
          traceId,
          endpoint,
          agent: AGENT_IDS.LUPOS,
        });
        const memory = await this.store({
          agent: AGENT_IDS.LUPOS,
          project: project || null,
          username: fact.sourceUsername || null,
          type: fact.category || "other",
          title: null,
          content: fact.fact,
          embedding,
          metadata: {
            guildId,
            channelId,
            aboutUserId: fact.aboutUserId,
            aboutUsername: fact.aboutUsername,
            sourceUserId: fact.sourceUserId,
            sourceUsername: fact.sourceUsername,
            confidence: fact.confidence,
            sourceMessageId: sourceMessageId || null,
          },
        });
        if (memory) {
          storedMemories.push(memory);
          logger.info(
            `[MemoryService] Stored: "${fact.fact.substring(0, LOG_PREVIEW.SHORT)}..." (about: ${fact.aboutUsername})`,
          );
        }
      } catch (error: unknown) {
        logger.error(
          `[MemoryService] Failed to store fact: ${getErrorMessage(error)}`,
        );
      }
    }
    return storedMemories;
  },
  // ── Search ─────────────────────────────────────────────────────────────────
  /**
   * Search for relevant memories using cosine similarity.
   * Always scoped by `agent`.
   */
  async search({
    agent,
    project,
    guildId,
    userIds,
    queryText,
    limit = 10,
    conversationId,
    traceId,
    agentConversationId,
    endpoint,
    username,
  }: MemorySearchParams) {
    if (!agent)
      throw new Error("MemoryService.search requires an agent identifier");
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    if (!collection) {
      logger.warn(`[MemoryService] search: collection ${COLLECTION} not available`);
      return [];
    }
    // Generate embedding for the search query
    const embeddingOpts: EmbedOptions = {};
    if (conversationId) embeddingOpts.conversationId = conversationId;
    if (traceId) embeddingOpts.traceId = traceId;
    if (agentConversationId)
      embeddingOpts.agentConversationId = agentConversationId;
    if (project) embeddingOpts.project = project;
    if (endpoint) embeddingOpts.endpoint = endpoint;
    if (agent) embeddingOpts.agent = agent;
    if (username) embeddingOpts.username = username;
    const queryEmbedding = await generateEmbedding(queryText, embeddingOpts);
    // Build the filter — always scoped by agent, current rows only
    const filter: Record<string, unknown> = { agent, ...CURRENT_MEMORY_FILTER };
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userIds && userIds.length > 0) {
      filter.aboutUserId = { $in: userIds };
    }
    // Fetch all memories matching the filter
    const memories = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          type: 1,
          title: 1,
          content: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          confidence: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    if (memories.length === 0) return [];
    // Hybrid multi-signal scoring (semantic + BM25 + exact + recency, RRF-
    // fused) — recovers exact-attribute/keyword hits cosine alone misses.
    // Candidates without embeddings are still eligible via keyword channels.
    const hybridScores = scoreHybrid(
      memories.map((memory: Record<string, unknown>, index: number) => ({
        key: index,
        title: (memory.title as string) || "",
        content: (memory.content as string) || "",
        embedding:
          memory.embedding && (memory.embedding as number[]).length > 0
            ? (memory.embedding as number[])
            : null,
        createdAt: (memory.createdAt as string) || null,
      })),
      queryText,
      queryEmbedding as number[],
      { relevanceThreshold: RELEVANCE_THRESHOLD, limit },
    );
    const scored = hybridScores.map((hybrid) => {
      const memory = memories[hybrid.key] as Record<string, unknown>;
      return {
        id: memory._id,
        type: memory.type || "other",
        title:
          memory.title ||
          (memory.content
            ? (memory.content as string).substring(0, LOG_PREVIEW.SHORT)
            : "untitled"),
        content: memory.content || "",
        aboutUserId: memory.aboutUserId,
        aboutUsername: memory.aboutUsername,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
        age: memoryAge(memory.createdAt as string),
        ageDays: memoryAgeDays(memory.createdAt as string),
        // score stays cosine similarity for consumer compatibility;
        // ordering comes from the fused rank
        score: hybrid.semantic,
        matchSignals: {
          bm25: hybrid.bm25Hit,
          exact: hybrid.exactHit,
          fused: hybrid.fused,
        },
      };
    });
    logger.info(
      `[MemoryService] Hybrid search found ${scored.length} relevant memories for ${agent} (from ${memories.length} candidates)`,
    );
    return scored;
  },
  // ── List ────────────────────────────────────────────────────────────────────
  async list({
    agent,
    project,
    guildId,
    userId,
    aboutUserId,
    sourceUserId,
    limit = 50,
    skip = 0,
    type,
    includeSuperseded = false,
  }: MemoryListParams) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter: Record<string, unknown> = includeSuperseded
      ? {}
      : { ...CURRENT_MEMORY_FILTER };
    if (agent) filter.agent = agent;
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userId || aboutUserId) filter.aboutUserId = userId || aboutUserId;
    if (sourceUserId) filter.sourceUserId = sourceUserId;
    if (type) filter.type = type;
    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return { memories, total };
  },
  // ── Facets ──────────────────────────────────────────────────────────────────
  /**
   * Distinct filter facets for a project/agent scope: memory types plus the
   * Discord users memories are about (aboutUserId) and revealed by
   * (sourceUserId), each with counts. Powers the Memories tab filter dropdown.
   */
  async facets({ agent, project, guildId }: MemoryFacetsParams) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const match: Record<string, unknown> = { ...CURRENT_MEMORY_FILTER };
    if (agent) match.agent = agent;
    if (project) match.project = project;
    if (guildId) match.guildId = guildId;

    const userFacet = (idField: string, usernameField: string) =>
      collection
        .aggregate([
          { $match: { ...match, [idField]: { $type: "string", $ne: "" } } },
          {
            $group: {
              _id: `$${idField}`,
              username: { $max: `$${usernameField}` },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, userId: "$_id", username: 1, count: 1 } },
          { $sort: { count: -1, username: 1 } },
          { $limit: 100 },
        ])
        .toArray();

    const [types, aboutUsers, sourceUsers] = await Promise.all([
      collection
        .aggregate([
          { $match: match },
          { $group: { _id: "$type", count: { $sum: 1 } } },
          {
            $project: {
              _id: 0,
              type: { $ifNull: ["$_id", "other"] },
              count: 1,
            },
          },
          { $sort: { count: -1, type: 1 } },
        ])
        .toArray(),
      userFacet("aboutUserId", "aboutUsername"),
      userFacet("sourceUserId", "sourceUsername"),
    ]);
    return { types, aboutUsers, sourceUsers };
  },
  // ── Discover ───────────────────────────────────────────────────────────────
  /**
   * Aggregate all distinct project/agent combinations with memory counts.
   * Bypasses project scoping — used by the consolidation CLI's --all sweep.
   */
  async discoverCombos() {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    return collection
      .aggregate([
        { $match: { ...CURRENT_MEMORY_FILTER } },
        {
          $group: {
            _id: { project: "$project", agent: "$agent" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            project: { $ifNull: ["$_id.project", DEFAULT_PROJECT] },
            agent: "$_id.agent",
            count: 1,
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();
  },
  // ── Invalidate (soft-close) ────────────────────────────────────────────────
  /**
   * Close a memory's valid-time window instead of deleting it (Graphiti-style
   * edge invalidation). The row stays queryable for history/rollback but is
   * excluded from every current-rows read path. Reversible via reopen().
   */
  async invalidate(
    memoryId: string,
    { supersededBy = null, reason = null }: MemoryInvalidateParams = {},
  ) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();
    const result = await collection.updateOne(
      { id: memoryId, ...CURRENT_MEMORY_FILTER },
      {
        $set: {
          validTo: now,
          supersededBy,
          closedReason: reason,
          updatedAt: now,
        },
      },
    );
    return result.modifiedCount > 0;
  },
  /** Reverse an invalidate() — used by consolidation rollback. */
  async reopen(memoryId: string) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.updateOne(
      { id: memoryId, validTo: { $ne: null } },
      {
        $set: {
          validTo: null,
          supersededBy: null,
          closedReason: null,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    return result.modifiedCount > 0;
  },
  // ── Delete / Remove (hard — user-initiated purges only) ────────────────────
  async delete(memoryId: string) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },
  async remove(memoryId: string) {
    return this.delete(memoryId);
  },
  async removeAllByAgent(project: string, agent?: string) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter: Record<string, unknown> = { project };
    if (agent) filter.agent = agent;
    const result = await collection.deleteMany(filter);
    logger.info(
      `[MemoryService] removeAllByAgent project=${project} agent=${agent || "all"} deleted=${result.deletedCount}`,
    );
    return { deletedCount: result.deletedCount };
  },
  // ── Update ─────────────────────────────────────────────────────────────────
  async update(memoryId: string, { title, content, type }: MemoryUpdateParams) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const $set: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (title !== undefined) $set.title = title;
    if (content !== undefined) $set.content = content;
    if (type !== undefined) $set.type = type;
    // Re-generate embedding if content changed
    if (content !== undefined) {
      const document = await collection.findOne(
        { id: memoryId },
        { projection: { project: 1, title: 1 } },
      );
      const embedText =
        title || document?.title
          ? `${title || document?.title}: ${content}`
          : content;
      $set.embedding = await generateEmbedding(embedText, {
        project: document?.project,
      });
    }
    const result = await collection.updateOne({ id: memoryId }, { $set });
    return result.modifiedCount > 0;
  },
  // ── Format ─────────────────────────────────────────────────────────────────
  /**
   * Format memories for injection into the system prompt.
   * Adds type badges and staleness caveats.
   */
  formatForPrompt(
    memories: Record<string, unknown>[],
    options: { plainCaveats?: boolean } = {},
  ) {
    if (!memories || memories.length === 0) return "";
    return memories
      .filter((memory) => !!memory)
      .map((memory: Record<string, unknown>) => {
        const badge = `[${memory.type || "other"}]`;
        const plain = options.plainCaveats === true;
        const age =
          !plain && memory.age !== "today" ? ` (${memory.age || ""})` : "";
        const caveat = freshnessCaveat(memory.createdAt as string, plain);
        const title = memory.title || "Untitled";
        const content = memory.content || "";
        return `- ${badge} **${title}**${age}: ${content}${caveat}`;
      })
      .join("\n");
  },
  // ── Indexes ────────────────────────────────────────────────────────────────
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    // Primary lookup: by agent + project, with createdAt suffix so the
    // dedup/search paths' sort({createdAt:-1}).limit(N) walks the index
    // instead of fetching every ~12KB embedding doc and sorting in memory
    await collection.createIndex({ agent: 1, project: 1, createdAt: -1 });
    // LUPOS queries: agent + guild + user, same createdAt-suffix rationale
    await collection.createIndex({
      agent: 1,
      guildId: 1,
      aboutUserId: 1,
      createdAt: -1,
    });
    // Type-filtered queries
    await collection.createIndex({ agent: 1, project: 1, type: 1 });
    // Drop the old prefix-redundant variants superseded by the indexes above
    for (const staleIndex of [
      "agent_1_project_1",
      "agent_1_guildId_1_aboutUserId_1",
    ]) {
      await collection.dropIndex(staleIndex).catch(() => {});
    }
    // Conversation backlinks: memory → conversation provenance lookup
    await collection.createIndex({ agent: 1, conversationId: 1 });
    // Unique ID
    await collection.createIndex({ id: 1 }, { unique: true });
    // Chronological listing
    await collection.createIndex({ createdAt: -1 });
    // Current-rows scans (validTo: null matches null + missing)
    await collection.createIndex({ agent: 1, validTo: 1, createdAt: -1 });
    logger.info(
      "[MemoryService] Indexes ensured on unified memories collection.",
    );
  },
};
export default MemoryService;
