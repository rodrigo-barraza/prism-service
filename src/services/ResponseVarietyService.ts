import MongoWrapper from "#src/wrappers/MongoWrapper";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * Anti-repetition context for conversational personas.
 *
 * Discord-style agents hold a separate conversation per user, so the agent
 * never sees what it just said to OTHER people — and converges on the same
 * openers, jokes, and sentence shapes across the whole server. This service
 * surfaces the agent's most recent replies across ALL conversations plus a
 * per-turn "delivery seasoning", both injected into self-context so each
 * reply lands on a different beat.
 */

const CONVERSATIONS_TO_SCAN = 10;
const RECENT_UTTERANCE_LIMIT = 6;
const UTTERANCE_TRUNCATE_CHARS = 220;
const MESSAGES_TAIL_PER_CONVERSATION = 6;

interface RecentUtterance {
  text: string;
  at: string;
}

let indexEnsured = false;

async function ensureIndex(): Promise<void> {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    await db
      .collection(COLLECTIONS.AGENT_CONVERSATIONS)
      .createIndex({ project: 1, agent: 1, updatedAt: -1 });
  } catch (error: unknown) {
    logger.warn(
      `[ResponseVarietyService] Index creation failed: ${getErrorMessage(error)}`,
    );
  }
}

function extractLastAssistantText(
  messages: Array<Record<string, unknown>> | undefined,
): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content !== "string") continue;
    const text = message.content.trim();
    if (text) return text;
  }
  return null;
}

function truncate(text: string): string {
  if (text.length <= UTTERANCE_TRUNCATE_CHARS) return text;
  return `${text.slice(0, UTTERANCE_TRUNCATE_CHARS)}…`;
}

async function fetchRecentUtterances(
  agentId: string,
  project: string | null,
  excludeConversationId: string | null,
): Promise<RecentUtterance[]> {
  try {
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.AGENT_CONVERSATIONS,
    );
    if (!collection) return [];
    await ensureIndex();

    const filter: Record<string, unknown> = { agent: agentId };
    if (project) filter.project = project;
    if (excludeConversationId) filter.id = { $ne: excludeConversationId };

    const documents = await collection
      .find(filter, {
        projection: {
          id: 1,
          updatedAt: 1,
          messages: { $slice: -MESSAGES_TAIL_PER_CONVERSATION },
        },
      })
      .sort({ updatedAt: -1 })
      .limit(CONVERSATIONS_TO_SCAN)
      .toArray();

    const utterances: RecentUtterance[] = [];
    const seenTexts = new Set<string>();
    for (const document of documents) {
      const text = extractLastAssistantText(
        document.messages as Array<Record<string, unknown>>,
      );
      if (!text || seenTexts.has(text)) continue;
      seenTexts.add(text);
      utterances.push({
        text: truncate(text),
        at: (document.updatedAt as string) || "",
      });
    }

    utterances.sort((first, second) => second.at.localeCompare(first.at));
    return utterances.slice(0, RECENT_UTTERANCE_LIMIT);
  } catch (error: unknown) {
    logger.warn(
      `[ResponseVarietyService] Recent utterance fetch failed: ${getErrorMessage(error)}`,
    );
    return [];
  }
}

function pickSeasoning(locale: string): string | null {
  try {
    const seasonings = Object.values(
      PromptLocaleService.getRecord(locale, "variety.seasonings"),
    ).filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0,
    );
    if (seasonings.length === 0) return null;
    return seasonings[Math.floor(Math.random() * seasonings.length)];
  } catch {
    return null;
  }
}

const ResponseVarietyService = {
  /**
   * Render the variety self-context block. Returns null when there's
   * nothing useful to say (no history and no seasonings).
   */
  async renderBlock(options: {
    agentId: string;
    project: string | null;
    currentConversationId: string | null;
    locale: string;
  }): Promise<string | null> {
    const { agentId, project, currentConversationId, locale } = options;

    const utterances = await fetchRecentUtterances(
      agentId,
      project,
      currentConversationId,
    );
    const seasoning = pickSeasoning(locale);

    const lines: string[] = [];

    if (utterances.length > 0) {
      lines.push(PromptLocaleService.get(locale, "variety.recentRepliesHeader"));
      lines.push(
        PromptLocaleService.get(locale, "variety.recentRepliesDirective"),
      );
      for (const utterance of utterances) {
        lines.push(`- "${utterance.text}"`);
      }
    }

    if (seasoning) {
      if (lines.length > 0) lines.push("");
      lines.push(
        PromptLocaleService.get(locale, "variety.seasoningLine", {
          seasoning,
        }),
      );
    }

    return lines.length > 0 ? lines.join("\n") : null;
  },

  /** Test hook: reset the memoized index guard. */
  _resetForTests(): void {
    indexEnsured = false;
  },
};

export default ResponseVarietyService;
