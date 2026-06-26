import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

// Use the taxonomy constant when available, fall back to string literal
// until prism-service refreshes its utilities-library dependency.
const SEARCH_CONVERSATIONS_NAME =
  (TOOL_NAMES as Record<string, string>).SEARCH_CONVERSATIONS ||
  "search_conversations";

// ────────────────────────────────────────────────────────────
// ConversationSearchTool — semantic search across past agent conversations
// ────────────────────────────────────────────────────────────
// Uses the summaryEmbedding field persisted by ConversationEmbeddingService
// to find past conversations relevant to a natural language query.
//
// Returns conversation metadata (title, summary, date, memory count)
// without loading the full message history — the agent can reference
// these in its response or use memory backlinks to dive deeper.
// ────────────────────────────────────────────────────────────

const RELEVANCE_THRESHOLD = 0.3;
const DEFAULT_SEARCH_LIMIT = 10;
const MAXIMUM_CANDIDATES = 200;

const searchConversations = {
  name: SEARCH_CONVERSATIONS_NAME,
  schema: {
    name: SEARCH_CONVERSATIONS_NAME,
    emoji: ["🔍", "💬"],
    description:
      "Search past agent conversations using a natural language query. " +
      "Finds previous sessions by semantic similarity to the query text. " +
      "Returns conversation titles, summaries, dates, and linked memory counts. " +
      "Use this when the user references a past session, asks 'remember when we...', " +
      "or when you need context from a previous coding session.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query describing what you're looking for. " +
            "Example: 'MCP connection debugging', 'the session where we fixed WebSocket drops'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Default: 10.",
        },
      },
      required: ["query"],
    },
  },
  labels: ["coding", "memory"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const query =
      typeof toolArguments.query === "string" ? toolArguments.query : "";
    const limit =
      typeof toolArguments.limit === "number"
        ? Math.min(Math.max(1, toolArguments.limit), 25)
        : DEFAULT_SEARCH_LIMIT;

    if (!query) return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.search_conversations.queryRequired") };

    const { default: EmbeddingService } =
      await import("../EmbeddingService.js");
    const { default: MongoWrapper } =
      await import("../../wrappers/MongoWrapper.js");
    const { MONGO_DB_NAME } = await import("../../../config.js");
    const { COLLECTIONS } = await import("../../constants.js");

    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.search_conversations.databaseUnavailable") };
    }

    // Generate query embedding
    const queryEmbedding = await EmbeddingService.embed(query, {
      source: "conversation-search",
      project: context.project || undefined,
      agent: null,
    });

    // Fetch conversations with embeddings
    const conversationCollection = database.collection(
      COLLECTIONS.AGENT_CONVERSATIONS,
    );
    const filter: Record<string, unknown> = {
      summaryEmbedding: { $exists: true, $ne: null },
    };
    if (context.project) filter.project = context.project;
    if (context.username) filter.username = context.username;

    const candidates = await conversationCollection
      .find(filter, {
        projection: {
          id: 1,
          title: 1,
          compactionSummary: 1,
          summaryEmbedding: 1,
          summaryUpdatedAt: 1,
          createdAt: 1,
          updatedAt: 1,
          agent: 1,
        },
      })
      .sort({ updatedAt: -1 })
      .limit(MAXIMUM_CANDIDATES)
      .toArray();

    if (candidates.length === 0) {
      return {
        count: 0,
        conversations: [],
        message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.search_conversations.noEmbeddings"),
      };
    }

    // Score by cosine similarity
    const scored = candidates
      .filter(
        (candidate) =>
          Array.isArray(candidate.summaryEmbedding) &&
          (candidate.summaryEmbedding as number[]).length > 0,
      )
      .map((candidate) => ({
        conversationId: candidate.id as string,
        title: (candidate.title as string) || "Untitled",
        summary: (candidate.compactionSummary as string) || null,
        agent: (candidate.agent as string) || null,
        createdAt: (candidate.createdAt as string) || null,
        updatedAt: (candidate.updatedAt as string) || null,
        score: cosineSimilarity(
          queryEmbedding,
          candidate.summaryEmbedding as number[],
        ),
      }))
      .filter((result) => result.score >= RELEVANCE_THRESHOLD)
      .sort(
        (firstResult, secondResult) => secondResult.score - firstResult.score,
      )
      .slice(0, limit);

    // Enrich with linked memory counts
    const memoryCollection = database.collection(COLLECTIONS.MEMORIES);
    const enrichedResults = await Promise.all(
      scored.map(async (result) => {
        const memoryCount = await memoryCollection.countDocuments({
          conversationId: result.conversationId,
        });
        return {
          ...result,
          score: parseFloat(result.score.toFixed(3)),
          linkedMemoryCount: memoryCount,
        };
      }),
    );

    logger.info(
      `[ConversationSearchTool] Found ${enrichedResults.length}/${candidates.length} ` +
        `conversations for query "${query.slice(0, 60)}"`,
    );

    return {
      count: enrichedResults.length,
      conversations: enrichedResults,
    };
  },
};

export default searchConversations;
