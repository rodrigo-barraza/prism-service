import MemoryService from "../MemoryService.ts";
import EmbeddingService from "../EmbeddingService.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import logger from "../../utils/logger.ts";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import { MemoryFetchOptions, SkillFetchOptions, ScoredSkill } from "./types.ts";

const SKILL_RELEVANCE_THRESHOLD = 0.3;

export class SkillMemoryScorer {
  /**
   * Fetch relevant memories via embedding similarity search.
   * Queries the unified `memories` collection using cosine similarity,
   * scoped by agent and project.
   */
  async fetchMemories(
    agent: string,
    project: string | null,
    queryText: string,
    { traceId, agentSessionId, endpoint, _username, guildId, userIds }: MemoryFetchOptions = {}
  ): Promise<string> {
    try {
      const memories = await MemoryService.search({
        agent,
        project,
        queryText,
        limit: 10,
        traceId: traceId || undefined,
        agentSessionId: agentSessionId || undefined,
        endpoint: endpoint || "/agent",
        username: _username || undefined,
        guildId: guildId || undefined,
        userIds: userIds || undefined,
      });

      if (!memories || memories.length === 0) return "";

      logger.info(
        `[SystemPromptAssembler] Memory search returned ${memories.length} results for ${agent}`
      );
      return MemoryService.formatForPrompt(memories);
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Memory fetch error: ${getErrorMessage(error)}`
      );
      return "";
    }
  }

  async fetchSkills(
    project: string | null,
    username: string,
    queryText: string,
    { traceId, agentSessionId, endpoint, agent }: SkillFetchOptions = {}
  ): Promise<ScoredSkill[]> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return [];

      const skills = await db
        .collection("agent_skills")
        .find({ project, username, enabled: true })
        .project({ name: 1, content: 1, description: 1, embedding: 1 })
        .toArray();

      if (skills.length === 0) return [];

      // If no query or no skills have embeddings, return all (graceful fallback)
      const hasEmbeddings = skills.some((s) => Array.isArray(s.embedding) && s.embedding.length > 0);
      if (!queryText || !hasEmbeddings) {
        logger.info(
          `[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`
        );
        return skills.map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: 1,
        }));
      }

      // Generate query embedding
      let queryEmbedding: number[];
      try {
        queryEmbedding = await EmbeddingService.embed(queryText, {
          source: "skill-relevance",
          project,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentSessionId: agentSessionId || null,
          agent: agent || null,
        });
      } catch (error: unknown) {
        logger.warn(
          `[SystemPromptAssembler] Query embedding failed: ${getErrorMessage(error)} — returning all skills`
        );
        return skills.map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: 1,
        }));
      }

      // Score and filter by relevance threshold
      const scored: ScoredSkill[] = skills
        .map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: s.embedding
            ? cosineSimilarity(queryEmbedding, s.embedding as number[])
            : 0,
        }))
        .filter((s) => s.score >= SKILL_RELEVANCE_THRESHOLD)
        .sort((firstItem, b) => b.score - firstItem.score);

      logger.info(
        `[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((s) => `${s.name}:${s.score.toFixed(2)}`).join(", ")})`
      );

      return scored;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Skills fetch error: ${getErrorMessage(error)}`
      );
      return [];
    }
  }
}
