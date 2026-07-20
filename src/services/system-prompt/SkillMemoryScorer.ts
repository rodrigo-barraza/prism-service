import MemoryService from "#src/services/MemoryService";
import EmbeddingService from "#src/services/EmbeddingService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, MEMORY } from "#src/constants";
import logger from "#src/utils/logger";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { type MemoryFetchOptions, type SkillFetchOptions, type ScoredSkill } from "./types.ts";

const SKILL_RELEVANCE_THRESHOLD = MEMORY.SKILL_RELEVANCE_THRESHOLD;

export class SkillMemoryScorer {
  /**
   * Fetch relevant memories via embedding similarity search.
   * Queries the unified `memories` collection using cosine similarity,
   * scoped by agent and project.
   *
   * Already-injected memory IDs (sourced from the persisted conversation
   * document) are excluded before formatting to prevent the same memories
   * from being repeated across turns in long conversations.
   *
   * Returns both the formatted prompt text and the IDs of what was injected
   * so the caller can persist them for future deduplication.
   */
  async fetchMemories(
    agent: string,
    project: string | null,
    queryText: string,
    {
      traceId,
      agentConversationId,
      conversationId,
      endpoint,
      _username,
      guildId,
      userIds,
      excludeMemoryIds,
      conversationalStyle,
    }: MemoryFetchOptions = {},
  ): Promise<{ memoriesText: string; injectedMemoryIds: string[] }> {
    try {
      const memories = await MemoryService.search({
        agent,
        project,
        queryText,
        limit: 10,
        conversationId: conversationId || undefined,
        traceId: traceId || undefined,
        agentConversationId: agentConversationId || undefined,
        endpoint: endpoint || "/agent",
        username: _username || undefined,
        guildId: guildId || undefined,
        userIds: userIds || undefined,
      });

      if (!memories || memories.length === 0) {
        return { memoriesText: "", injectedMemoryIds: [] };
      }

      const novelMemories = excludeMemoryIds?.size
        ? memories.filter(
            (memory) => memory && !excludeMemoryIds.has(memory.id as string),
          )
        : memories.filter((memory) => !!memory);

      const excludedCount = memories.length - novelMemories.length;
      logger.info(
        `[SystemPromptAssembler] Memory search: ${memories.length} results for ${agent}` +
          (excludedCount > 0 ? `, ${excludedCount} already injected this conversation (skipped)` : ""),
      );

      if (novelMemories.length === 0) {
        return { memoriesText: "", injectedMemoryIds: [] };
      }

      // Conversational personas: keep the most relevant few guaranteed, then
      // rotate the rest randomly so consecutive replies don't riff on the
      // exact same set of remembered facts (which reads as recycled jokes).
      let selectedMemories = novelMemories;
      if (conversationalStyle && novelMemories.length > 6) {
        const anchors = novelMemories.slice(0, 3);
        const rotating = [...novelMemories.slice(3)];
        for (let index = rotating.length - 1; index > 0; index--) {
          const swap = Math.floor(Math.random() * (index + 1));
          [rotating[index], rotating[swap]] = [rotating[swap], rotating[index]];
        }
        selectedMemories = [...anchors, ...rotating.slice(0, 3)];
      }

      const injectedMemoryIds = selectedMemories.map(
        (memory) => memory.id as string,
      );
      const memoriesText = MemoryService.formatForPrompt(selectedMemories, {
        plainCaveats: conversationalStyle === true,
      });
      return { memoriesText, injectedMemoryIds };
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Memory fetch error: ${getErrorMessage(error)}`,
      );
      return { memoriesText: "", injectedMemoryIds: [] };
    }
  }

  async fetchSkills(
    project: string | null,
    username: string,
    queryText: string,
    { traceId, agentConversationId, endpoint, agent }: SkillFetchOptions = {},
  ): Promise<ScoredSkill[]> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return [];

      const skills = await db
        .collection(COLLECTIONS.AGENT_SKILLS)
        .find({ project, username, enabled: true })
        .project({ name: 1, content: 1, description: 1, embedding: 1 })
        .toArray();

      if (skills.length === 0) return [];

      // If no query or no skills have embeddings, return all (graceful fallback)
      const hasEmbeddings = skills.some(
        (skill) => Array.isArray(skill.embedding) && skill.embedding.length > 0,
      );
      if (!queryText || !hasEmbeddings) {
        logger.info(
          `[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`,
        );
        return skills.map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
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
          agentConversationId: agentConversationId || null,
          agent: agent || null,
        });
      } catch (error: unknown) {
        logger.warn(
          `[SystemPromptAssembler] Query embedding failed: ${getErrorMessage(error)} — returning all skills`,
        );
        return skills.map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
          score: 1,
        }));
      }

      // Score and filter by relevance threshold
      const scored: ScoredSkill[] = skills
        .filter((skill) => !!skill)
        .map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
          score: skill.embedding
            ? cosineSimilarity(queryEmbedding, skill.embedding as number[])
            : 0,
        }))
        .filter((skill) => skill.score >= SKILL_RELEVANCE_THRESHOLD)
        .sort((firstItem, b) => b.score - firstItem.score);

      logger.info(
        `[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((skill) => `${skill.name}:${skill.score.toFixed(2)}`).join(", ")})`,
      );

      return scored;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Skills fetch error: ${getErrorMessage(error)}`,
      );
      return [];
    }
  }
}
