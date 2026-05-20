// @ts-ignore
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { getProvider } from "../providers/index.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.ts";
import EmbeddingService from "./EmbeddingService.ts";
import RequestLogger from "./RequestLogger.ts";
import logger from "../utils/logger.ts";
import { cosineSimilarity } from "../utils/math.ts";
import { parseJsonFromLlmResponse } from "../utils/utilities.ts";
import { COLLECTIONS } from "../constants.ts";
import SettingsService from "./SettingsService.ts";
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
const DUPLICATE_THRESHOLD = 0.92;
/**
 * Minimum cosine similarity for a memory to be considered relevant during search.
 */
const RELEVANCE_THRESHOLD = 0.3;
/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to these types. LUPOS additionally uses its own
 * category values (personal, preference, gaming, etc.) stored in the `type`
 * field — the schema is flexible per agent.
 */
export const CODING_MEMORY_TYPES = ["user", "feedback", "project", "reference"];
// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Generate an embedding for text via EmbeddingService.


 */
async function generateEmbedding(text: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return EmbeddingService.embed(text, { source: "memory", ...options });
}
/**
 * Calculate days elapsed since a timestamp.
 */
function memoryAgeDays(createdAt: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  return daysSinceIso(createdAt);
}
/**
 * Human-readable age string. Models are poor at date arithmetic —
 * "47 days ago" triggers staleness reasoning better than a raw ISO timestamp.
 */
function memoryAge(createdAt: Record<string, unknown>) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}
/**
 * Staleness caveat for memories >1 day old.
 * Returns empty string for fresh memories.
 */
function freshnessCaveat(createdAt: Record<string, unknown>) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays <= 1) return "";
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
  messages: Record<string, unknown>,
  participants: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<ExtractedFact[]> {
  // @ts-ignore
  const endpoint = meta.endpoint || null;
  // @ts-ignore
  const agent = meta.agent || null;
  const { provider: extractionProvider, model: extractionModel } =
    await getExtractionConfig();
  const provider = getProvider(extractionProvider);
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  // @ts-ignore - TODO: strict typing
  const participantList = participants
    .map(
      (p: Record<string, unknown>) =>
        `- ID: ${p.id}, Username: ${p.username}, Display: ${p.displayName || p.username}`,
    )
    .join("\n");
  // @ts-ignore - TODO: strict typing
  const conversationText = messages
    .map((m: Record<string, unknown>) => `${m.name || m.role}: ${m.content}`)
    .join("\n");
  const systemPrompt = `You are a memory extraction system. Analyze the conversation and extract notable personal facts about the participants. Focus on:
- Personal information (location, occupation, hobbies, pets, family)
- Preferences (favorite things, likes, dislikes)
- Life events (moving, new job, relationships, achievements)
- Notable opinions or beliefs they express about themselves
- Information one user reveals about another user
Do NOT extract:
- Transient conversation topics (what they're currently discussing)
- Greetings, jokes, or casual banter
- Bot commands or technical requests
- Things the AI assistant says about itself
- Opinions about external topics (politics, movies, etc) unless they reveal something personal
For each fact, identify which user it's about. If a user mentions something about another user, the fact is ABOUT the other user but SOURCED from the speaker.
Respond ONLY with a JSON array. Each object must have:
- "fact": string — the personal fact in a concise sentence
- "aboutUserId": string — the Discord user ID this fact is about
- "aboutUsername": string — the username of the person this fact is about
- "sourceUserId": string — who said/revealed this (can be same as aboutUserId)
- "sourceUsername": string — username of the source
- "category": string — one of: "personal", "preference", "gaming", "work", "family", "hobby", "location", "relationship", "achievement", "other"
- "confidence": number — 0.0 to 1.0, how confident this is a real personal fact
If no facts are found, return an empty array: []
Here are the participants:
${participantList}`;
  const aiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Extract personal facts from this conversation:\n\n${conversationText}`,
    },
  ];
  let result: Record<string, unknown>;
  let success = true;
  let errorMessage = null;
  try {
    result = await provider.generateText(aiMessages, extractionModel, {
      maxTokens: 1000,
      temperature: 0.1,
    });
  } catch (error: unknown) {
    success = false;
    // @ts-ignore - TODO: strict typing
    errorMessage = error.message;
    throw error;
  } finally {
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint,
      operation: "memory:extract",
      // @ts-ignore
      project: meta.project || null,
      // @ts-ignore
      username: meta.username || "system",
      agent,
      provider: extractionProvider,
      model: extractionModel,
      // @ts-ignore
      traceId: meta.traceId || null,
      // @ts-ignore
      agentSessionId: meta.agentSessionId || null,
      aiMessages,
      // @ts-ignore - TODO: strict typing
      resultText: result?.text || "",
      // @ts-ignore - TODO: strict typing
      usage: result?.usage || null,
      success,
      errorMessage,
      requestStartMs: requestStart,
      extraRequestPayload: {
        participantCount: participants.length,
        messageCount: messages.length,
      },
    });
  }
  // @ts-ignore - TODO: strict typing
  const facts = parseJsonFromLlmResponse(result.text);
  if (!Array.isArray(facts)) return [];
  // Validate each fact has the required fields
  return facts.filter(
    // @ts-ignore - TODO: strict typing
    (f: Record<string, unknown>) =>
      f.fact &&
      f.aboutUserId &&
      f.aboutUsername &&
      typeof f.confidence === "number" &&
      f.confidence >= 0.5,
  ) as ExtractedFact[];
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
 */
const MemoryService = {
  // ── Store ──────────────────────────────────────────────────────────────────
  /**
   * Store a single memory with embedding generation and duplicate detection.
   *

   * @param {string} params.agent - Agent identifier ("LUPOS", "CODING", etc.)


   * @param {string} params.content - Full memory text


   * @returns {Promise<object|null>} Stored memory document, or null if duplicate
   */
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
    agentSessionId,
    endpoint,
  }: Record<string, unknown>) {
    if (!agent)
      throw new Error("MemoryService.store requires an agent identifier");
    if (!content) throw new Error("MemoryService.store requires content");
    // Validate type for CODING agent
    if (agent === "CODING") {
      // @ts-ignore - TODO: strict typing
      type = CODING_MEMORY_TYPES.includes(type) ? type : "project";
    }
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const embedText = title ? `${title}: ${content}` : content;
    // Generate embedding if not provided
    if (!embedding) {
      const embedOpts = { project };
      // @ts-ignore
      if (traceId) embedOpts.traceId = traceId;
      // @ts-ignore
      if (agentSessionId) embedOpts.agentSessionId = agentSessionId;
      // @ts-ignore
      if (endpoint) embedOpts.endpoint = endpoint;
      // @ts-ignore
      if (agent) embedOpts.agent = agent;
      // @ts-ignore - TODO: strict typing
      embedding = await generateEmbedding(embedText, embedOpts);
    }
    // Duplicate detection — compare against existing memories for the same agent
    const dedupFilter = { agent };
    // @ts-ignore
    if (project) dedupFilter.project = project;
    // @ts-ignore
    if (metadata.guildId) dedupFilter.guildId = metadata.guildId;
    // @ts-ignore
    if (metadata.aboutUserId) dedupFilter.aboutUserId = metadata.aboutUserId;
    const existing = await collection
      .find(dedupFilter)
      .project({ embedding: 1 })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const isDuplicate = existing.some((document: Record<string, unknown>) => {
      if (!document.embedding) return false;
      // @ts-ignore - TODO: strict typing
      return cosineSimilarity(embedding, document.embedding) > DUPLICATE_THRESHOLD;
    });
    if (isDuplicate) {
      logger.info(
        // @ts-ignore - TODO: strict typing
        `[MemoryService] Skipping duplicate for ${agent}: "${(title || content).substring(0, 60)}"`,
      );
      return null;
    }
    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      username: username || null,
      type: type || "other",
      title: title || null,
      content,
      embedding,
      conversationId: conversationId || null,
      createdAt: now,
      updatedAt: now,
      // Spread agent-specific metadata at top level for efficient querying
      // @ts-ignore - TODO: strict typing
      ...metadata,
    };
    await collection.insertOne(memory);
    logger.info(
      // @ts-ignore - TODO: strict typing
      `[MemoryService] Stored [${agent}/${memory.type}] "${(title || content).substring(0, 60)}"`,
    );
    return memory;
  },
  // ── LUPOS: Extract & Store ─────────────────────────────────────────────────
  /**
   * Extract and store LUPOS memories from a Discord conversation chunk.
   *

   * @param {string} params.guildId
   * @param {string} params.channelId
   * @param {Array} params.messages - Recent conversation messages
   * @param {Array} params.participants - Array of { id, username, displayName }

   * @returns {Promise<Array>} The stored memory documents
   */
  async extractAndStore({
    guildId,
    channelId,
    messages,
    participants,
    sourceMessageId,
    traceId,
    project,
    endpoint,
  }: Record<string, unknown>) {
    // Extract facts from the conversation via AI
    // @ts-ignore - TODO: strict typing
    const facts = await extractFactsFromConversation(messages, participants, {
      project,
      traceId,
      endpoint,
      agent: "LUPOS",
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
    for ( const fact of facts) {
      try {
        // @ts-ignore - TODO: strict typing
        const embedding = await generateEmbedding(fact.fact, {
          project,
          traceId,
          endpoint,
          agent: "LUPOS",
        });
        const memory = await this.store({
          agent: "LUPOS",
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
            `[MemoryService] Stored: "${fact.fact.substring(0, 60)}..." (about: ${fact.aboutUsername})`,
          );
        }
      } catch (error: unknown) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[MemoryService] Failed to store fact: ${error.message}`);
      }
    }
    return storedMemories;
  },
  // ── Search ─────────────────────────────────────────────────────────────────
  /**
   * Search for relevant memories using cosine similarity.
   * Always scoped by `agent`.
   *

   * @param {string} params.agent - Agent identifier


   * @param {string} params.queryText - Text to search for

   * @returns {Promise<Array>} Relevant memories sorted by relevance
   */
  async search({
    agent,
    project,
    guildId,
    userIds,
    queryText,
    limit = 10,
    traceId,
    agentSessionId,
    endpoint,
  }: Record<string, unknown>) {
    if (!agent)
      throw new Error("MemoryService.search requires an agent identifier");
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    // Generate embedding for the search query
    const embeddingOpts = {};
    // @ts-ignore
    if (traceId) embeddingOpts.traceId = traceId;
    // @ts-ignore
    if (agentSessionId) embeddingOpts.agentSessionId = agentSessionId;
    // @ts-ignore
    if (project) embeddingOpts.project = project;
    // @ts-ignore
    if (endpoint) embeddingOpts.endpoint = endpoint;
    // @ts-ignore
    if (agent) embeddingOpts.agent = agent;
    // @ts-ignore - TODO: strict typing
    const queryEmbedding = await generateEmbedding(queryText, embeddingOpts);
    // Build the filter — always scoped by agent
    const filter = { agent };
    // @ts-ignore
    if (project) filter.project = project;
    // @ts-ignore
    if (guildId) filter.guildId = guildId;
    // @ts-ignore - TODO: strict typing
    if (userIds && userIds.length > 0) {
      // @ts-ignore
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
    // Compute cosine similarity and sort
    const scored = memories
      // @ts-ignore - TODO: strict typing
      .filter((m: Record<string, unknown>) => m.embedding && m.embedding.length > 0)
      .map((m: Record<string, unknown>) => ({
        id: m._id,
        type: m.type || "other",
        // @ts-ignore - TODO: strict typing
        title: m.title || (m.content ? m.content.substring(0, 60) : "untitled"),
        content: m.content || "",
        aboutUserId: m.aboutUserId,
        aboutUsername: m.aboutUsername,
        confidence: m.confidence,
        createdAt: m.createdAt,
        // @ts-ignore - TODO: strict typing
        age: memoryAge(m.createdAt),
        // @ts-ignore - TODO: strict typing
        ageDays: memoryAgeDays(m.createdAt),
        // @ts-ignore - TODO: strict typing
        score: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      // @ts-ignore - TODO: strict typing
      .filter((m: Record<string, unknown>) => m.score > RELEVANCE_THRESHOLD)
      // @ts-ignore - TODO: strict typing
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => b.score - a.score)
      // @ts-ignore - TODO: strict typing
      .slice(0, limit);
    logger.info(
      `[MemoryService] Search found ${scored.length} relevant memories for ${agent} (from ${memories.length} total)`,
    );
    return scored;
  },
  // ── List ────────────────────────────────────────────────────────────────────
  /**
   * List memories for a specific agent, optionally filtered by project/guild/user.
   *

   * @param {string} params.agent - Agent identifier


   * @returns {Promise<{ memories: Array, total: number }>}
   */
  async list({ agent, project, guildId, userId, limit = 50, skip = 0 }: Record<string, unknown>) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter = {};
    // @ts-ignore
    if (agent) filter.agent = agent;
    // @ts-ignore
    if (project) filter.project = project;
    // @ts-ignore
    if (guildId) filter.guildId = guildId;
    // @ts-ignore
    if (userId) filter.aboutUserId = userId;
    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
        // @ts-ignore - TODO: strict typing
        .skip(skip)
        // @ts-ignore - TODO: strict typing
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return { memories, total };
  },
  // ── Discover ───────────────────────────────────────────────────────────────
  /**
   * Aggregate all distinct project/agent combinations with memory counts.
   * Bypasses project scoping — used by the consolidation CLI's --all sweep.
   *
   * @returns {Promise<Array<{ project: string, agent: string, count: number }>>}
   */
  async discoverCombos() {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    return collection
      .aggregate([
        {
          $group: {
            _id: { project: "$project", agent: "$agent" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            project: { $ifNull: ["$_id.project", "default"] },
            agent: { $ifNull: ["$_id.agent", "CODING"] },
            count: 1,
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();
  },
  // ── Delete / Remove ────────────────────────────────────────────────────────
  /**
   * Delete a specific memory by its id field.
   *

   * @returns {Promise<boolean>} Whether a document was deleted
   */
  async delete(memoryId: Record<string, unknown>) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },
  /**
   * Alias for delete — used by callers that preferred the AgentMemoryService naming.
   */
  async remove(memoryId: Record<string, unknown>) {
    return this.delete(memoryId);
  },
  // ── Update ─────────────────────────────────────────────────────────────────
  /**
   * Update an existing memory.
   *


   */
  async update(memoryId: Record<string, unknown>, { title, content, type }: Record<string, unknown>) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const $set = { updatedAt: new Date().toISOString() };
    // @ts-ignore
    if (title !== undefined) $set.title = title;
    // @ts-ignore
    if (content !== undefined) $set.content = content;
    // @ts-ignore
    if (type !== undefined) $set.type = type;
    // Re-generate embedding if content changed
    if (content !== undefined) {
      const document = await collection.findOne(
        { id: memoryId },
        { projection: { project: 1, title: 1 } },
      );
      const embedText =
        title || document?.title ? `${title || document?.title}: ${content}` : content;
      // @ts-ignore
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
   *

   * @returns {string} Formatted text block
   */
  formatForPrompt(memories: Record<string, unknown>) {
    if (!memories || memories.length === 0) return "";
    // @ts-ignore - TODO: strict typing
    return memories
      .map((m: Record<string, unknown>) => {
        const badge = `[${m.type}]`;
        const age = m.age !== "today" ? ` (${m.age})` : "";
        // @ts-ignore - TODO: strict typing
        const caveat = freshnessCaveat(m.createdAt);
        return `- ${badge} **${m.title}**${age}: ${m.content}${caveat}`;
      })
      .join("\n");
  },
  // ── Indexes ────────────────────────────────────────────────────────────────
  /**
   * Ensure indexes exist on the unified memories collection.
   */
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    // Primary lookup: by agent + project (covers CODING queries)
    await collection.createIndex({ agent: 1, project: 1 });
    // LUPOS queries: agent + guild + user
    await collection.createIndex({ agent: 1, guildId: 1, aboutUserId: 1 });
    // Type-filtered queries
    await collection.createIndex({ agent: 1, project: 1, type: 1 });
    // Unique ID
    await collection.createIndex({ id: 1 }, { unique: true });
    // Chronological listing
    await collection.createIndex({ createdAt: -1 });
    logger.info(
      "[MemoryService] Indexes ensured on unified memories collection.",
    );
  },
};
export default MemoryService;
