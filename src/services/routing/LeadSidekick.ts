import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

// ────────────────────────────────────────────────────────────
// LeadSidekick — the persistent sidekick of a lead_sidekick conversation
// ────────────────────────────────────────────────────────────
// The first create_subagent of a lead_sidekick conversation spawns its
// sidekick (on the `subagent` role's model); every later one CONTINUES
// that sidekick (resume_subagent) instead of spawning a stranger, so the
// sidekick's own context — and its prefix cache — carries across the
// conversation's delegations. The lead's side stays brief-only: a
// sub-agent's result never carries its transcript (SubAgentResultBuilder).
//
// Kept in memory and on the conversation (`modelRouting.sidekickAgentId`),
// so a restart still continues the same sidekick (resume rehydrates it).
// The lead's prompt addendum is the locale key `orchestrator.leadSidekick`
// (fixed text, so the lead's prefix stays stable), added by the assembler.
// ────────────────────────────────────────────────────────────

const sidekicks = new Map<string, string>();

function conversationsCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS);
}

/** The sidekick of `conversationId`, if it has one. */
export async function findSidekick({
  conversationId,
  project,
  username,
}: {
  conversationId: string;
  project: string;
  username: string;
}): Promise<string | null> {
  const known = sidekicks.get(conversationId);
  if (known) return known;
  try {
    const document = await conversationsCollection()?.findOne(
      { id: conversationId, project, username },
      { projection: { "modelRouting.sidekickAgentId": 1 } },
    );
    const stored = (document?.modelRouting as { sidekickAgentId?: unknown } | undefined)
      ?.sidekickAgentId;
    if (typeof stored === "string" && stored) {
      sidekicks.set(conversationId, stored);
      return stored;
    }
  } catch (error: unknown) {
    logger.warn(`[LeadSidekick] Could not read the sidekick of ${conversationId}: ${errorMessage(error)}`);
  }
  return null;
}

/** Record the sidekick `agentId` spawned for `conversationId`. */
export async function rememberSidekick({
  conversationId,
  project,
  username,
  agentId,
}: {
  conversationId: string;
  project: string;
  username: string;
  agentId: string;
}): Promise<void> {
  sidekicks.set(conversationId, agentId);
  try {
    await conversationsCollection()?.updateOne(
      { id: conversationId, project, username },
      { $set: { "modelRouting.sidekickAgentId": agentId } },
    );
  } catch (error: unknown) {
    logger.warn(`[LeadSidekick] Could not store the sidekick of ${conversationId}: ${errorMessage(error)}`);
  }
}

/** A sidekick that can no longer be resumed: the next delegation spawns a new one. */
export function forgetSidekick(conversationId: string): void {
  sidekicks.delete(conversationId);
}

/** Test hook. */
export function _clearSidekicks(): void {
  sidekicks.clear();
}
