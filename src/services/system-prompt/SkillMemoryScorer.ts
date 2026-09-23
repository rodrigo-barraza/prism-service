import MemoryService from "#src/services/MemoryService";
import EmbeddingService from "#src/services/EmbeddingService";
import SkillService, {
  catalogDescription,
  resolveSkillCaller,
} from "#src/services/SkillService";
import { MEMORY } from "#src/constants";
import logger from "#src/utils/logger";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  type MemoryFetchOptions,
  type SkillCatalogResult,
  type SkillFetchOptions,
} from "./types.ts";

const SKILL_RELEVANCE_THRESHOLD = MEMORY.SKILL_RELEVANCE_THRESHOLD;
/** At most this many catalog entries are highlighted for one turn. */
const SKILL_HIGHLIGHT_LIMIT = 3;

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
      profileId,
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
        profileId: profileId || undefined,
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

      // The exclusion set holds strings; `Set.has` compares by identity, so
      // an id that is still an ObjectId would never match. Compare by value.
      const novelMemories = excludeMemoryIds?.size
        ? memories.filter(
            (memory) => memory && !excludeMemoryIds.has(String(memory.id)),
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

      const injectedMemoryIds = selectedMemories.map((memory) =>
        String(memory.id),
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

  /**
   * The skill catalog for this caller (scope + persona), in name order so the
   * cached system prompt stays byte-stable, plus the entries this turn's
   * message looks relevant to. Relevance only highlights — it never adds a
   * body; bodies load through `load_skill`.
   */
  async fetchSkillCatalog(
    project: string | null,
    username: string,
    queryText: string,
    {
      traceId,
      agentConversationId,
      endpoint,
      agent,
      profileId,
    }: SkillFetchOptions = {},
  ): Promise<SkillCatalogResult> {
    try {
      const skills = await SkillService.catalog(
        resolveSkillCaller({ project, username, profileId, agent }),
      );
      const entries = skills.map((skill) => ({
        name: skill.name,
        description: catalogDescription(skill),
      }));
      if (skills.length === 0) return { entries, highlighted: [] };

      const embedded = skills.filter(
        (skill) => Array.isArray(skill.embedding) && skill.embedding.length > 0,
      );
      if (!queryText || embedded.length === 0) {
        return { entries, highlighted: [] };
      }

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
          `[SystemPromptAssembler] Skill relevance embedding failed: ${getErrorMessage(error)} — catalog without highlights`,
        );
        return { entries, highlighted: [] };
      }

      const scored = embedded
        .map((skill) => ({
          name: skill.name,
          score: cosineSimilarity(queryEmbedding, skill.embedding as number[]),
        }))
        .filter((skill) => skill.score >= SKILL_RELEVANCE_THRESHOLD)
        .sort((left, right) => right.score - left.score)
        .slice(0, SKILL_HIGHLIGHT_LIMIT);

      logger.info(
        `[SystemPromptAssembler] Skills: ${entries.length} in catalog, ${scored.length} highlighted (${scored.map((skill) => `${skill.name}:${skill.score.toFixed(2)}`).join(", ")})`,
      );
      return { entries, highlighted: scored.map((skill) => skill.name) };
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Skill catalog fetch error: ${getErrorMessage(error)}`,
      );
      return { entries: [], highlighted: [] };
    }
  }
}
