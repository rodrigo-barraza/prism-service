import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { getProvider } from "../providers/index.ts";
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
async function generateEmbedding(text: any, options: any = {}) {
  return EmbeddingService.embed(text, { source: "memory", ...options });
}
function memoryAgeDays(createdAt: any) {
    return daysSinceIso((createdAt as any));
}
/**
 * Human-readable age string. Models are poor at date arithmetic —
 * "47 days ago" triggers staleness reasoning better than a raw ISO timestamp.
 */
function memoryAge(createdAt: any) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}
/**
 * Staleness caveat for memories >1 day old.
 * Returns empty string for fresh memories.
 */
function freshnessCaveat(createdAt: any) {
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
  messages: any,
  participants: any,
  meta: any = {},
): Promise<ExtractedFact[]> {
    const endpoint = meta.endpoint || null;
    const agent = meta.agent || null;
  const { provider: extractionProvider, model: extractionModel } =
    await getExtractionConfig();
  const provider = getProvider(extractionProvider);
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
    const participantList = (participants as any)
    .map(
      (p: any) =>
        `- ID: ${p.id}, Username: ${p.username}, Display: ${p.displayName || p.username}`,
    )
    .join("\n");
    const conversationText = (messages as any)
    .map((m: any) => `${m.name || m.role}: ${m.content}`)
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
  let result: any;
  let success = true;
  let errorMessage = null;
  try {
    result = await provider.generateText(aiMessages, extractionModel, {
      maxTokens: 1000,
      temperature: 0.1,
    });
  } catch (error: unknown) {
    success = false;
        errorMessage = (error as Error).message;
    throw error;
  } finally {
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint,
      operation: "memory:extract",
            project: meta.project || null,
            username: meta.username || "system",
      agent,
      provider: extractionProvider,
      model: extractionModel,
            traceId: meta.traceId || null,
            agentSessionId: meta.agentSessionId || null,
      aiMessages,
            resultText: result?.text || "",
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
    const facts = parseJsonFromLlmResponse((result.text as any | null | undefined));
  if (!Array.isArray(facts)) return [];
  // Validate each fact has the required fields
  return facts.filter(
        (f: any) =>
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
  }: any) {
    if (!agent)
      throw new Error("MemoryService.store requires an agent identifier");
    if (!content) throw new Error("MemoryService.store requires content");
    // Validate type for CODING agent
    if (agent === "CODING") {
            type = CODING_MEMORY_TYPES.includes((type as any)) ? type : "project";
    }
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const embedText = title ? `${title}: ${content}` : content;
    // Generate embedding if not provided
    if (!embedding) {
      const embedOpts = { project };
            if (traceId) (embedOpts as any).traceId = traceId;
            if (agentSessionId) (embedOpts as any).agentSessionId = agentSessionId;
            if (endpoint) (embedOpts as any).endpoint = endpoint;
            if (agent) (embedOpts as any).agent = agent;
            embedding = await generateEmbedding((embedText as any), embedOpts);
    }
    // Duplicate detection — compare against existing memories for the same agent
    const dedupFilter = { agent };
        if (project) (dedupFilter as any).project = project;
        if ((metadata as any).guildId) (dedupFilter as any).guildId = (metadata as any).guildId;
        if ((metadata as any).aboutUserId) (dedupFilter as any).aboutUserId = (metadata as any).aboutUserId;
    const existing = await collection
      .find(dedupFilter)
      .project({ embedding: 1 })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const isDuplicate = existing.some((document: any) => {
      if (!document.embedding) return false;
            return cosineSimilarity((embedding as any[] | null), (document.embedding as any[])) > DUPLICATE_THRESHOLD;
    });
    if (isDuplicate) {
      logger.info(
                `[MemoryService] Skipping duplicate for ${agent}: "${((title || content) as any).substring(0, 60)}"`,
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
            ...metadata,
    };
    await collection.insertOne(memory);
    logger.info(
            `[MemoryService] Stored [${agent}/${memory.type}] "${((title || content) as any).substring(0, 60)}"`,
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
  }: any) {
    // Extract facts from the conversation via AI
        const facts = await extractFactsFromConversation((messages as any), (participants as any), {
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
    const storedMemories: any[] = [];
    for ( const fact of facts) {
      try {
                const embedding = await generateEmbedding((fact.fact as any), {
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
                logger.error(`[MemoryService] Failed to store fact: ${(error as Error).message}`);
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
    traceId,
    agentSessionId,
    endpoint,
  }: any) {
    if (!agent)
      throw new Error("MemoryService.search requires an agent identifier");
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    // Generate embedding for the search query
    const embeddingOpts: any = {};
        if (traceId) embeddingOpts.traceId = traceId;
        if (agentSessionId) embeddingOpts.agentSessionId = agentSessionId;
        if (project) embeddingOpts.project = project;
        if (endpoint) embeddingOpts.endpoint = endpoint;
        if (agent) embeddingOpts.agent = agent;
        const queryEmbedding = await generateEmbedding((queryText as any), embeddingOpts);
    // Build the filter — always scoped by agent
    const filter = { agent };
        if (project) (filter as any).project = project;
        if (guildId) (filter as any).guildId = guildId;
        if (userIds && (userIds as any).length > 0) {
            (filter as any).aboutUserId = { $in: userIds };
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
            .filter((m: any) => m.embedding && (m.embedding as any).length > 0)
      .map((m: any) => ({
        id: m._id,
        type: m.type || "other",
                title: m.title || (m.content ? (m.content as any).substring(0, 60) : "untitled"),
        content: m.content || "",
        aboutUserId: m.aboutUserId,
        aboutUsername: m.aboutUsername,
        confidence: m.confidence,
        createdAt: m.createdAt,
                age: memoryAge((m.createdAt as any)),
                ageDays: memoryAgeDays((m.createdAt as any)),
                score: cosineSimilarity((queryEmbedding as any[] | null), (m.embedding as any[] | null)),
      }))
            .filter((m: any) => (m as any).score > RELEVANCE_THRESHOLD)
            .sort((a: any, b: any) => (b as any).score - (a as any).score)
            .slice(0, (limit as any | undefined));
    logger.info(
      `[MemoryService] Search found ${scored.length} relevant memories for ${agent} (from ${memories.length} total)`,
    );
    return scored;
  },
  // ── List ────────────────────────────────────────────────────────────────────
  async list({ agent, project, guildId, userId, limit = 50, skip = 0 }: any) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter: any = {};
        if (agent) filter.agent = agent;
        if (project) filter.project = project;
        if (guildId) filter.guildId = guildId;
        if (userId) filter.aboutUserId = userId;
    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
                .skip((skip as any))
                .limit((limit as any))
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return { memories, total };
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
  async delete(memoryId: any) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },
  async remove(memoryId: any) {
    return this.delete(memoryId);
  },
  // ── Update ─────────────────────────────────────────────────────────────────
  async update(memoryId: any, { title, content, type }: any) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const $set = { updatedAt: new Date().toISOString() };
        if (title !== undefined) ($set as any).title = title;
        if (content !== undefined) ($set as any).content = content;
        if (type !== undefined) ($set as any).type = type;
    // Re-generate embedding if content changed
    if (content !== undefined) {
      const document = await collection.findOne(
        { id: memoryId },
        { projection: { project: 1, title: 1 } },
      );
      const embedText =
        title || document?.title ? `${title || document?.title}: ${content}` : content;
            ($set as any).embedding = await generateEmbedding((embedText as any), {
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
  formatForPrompt(memories: any) {
    if (!memories || memories.length === 0) return "";
        return (memories as any)
      .map((m: any) => {
        const badge = `[${m.type}]`;
        const age = m.age !== "today" ? ` (${m.age})` : "";
                const caveat = freshnessCaveat((m.createdAt as any));
        return `- ${badge} **${m.title}**${age}: ${m.content}${caveat}`;
      })
      .join("\n");
  },
  // ── Indexes ────────────────────────────────────────────────────────────────
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
