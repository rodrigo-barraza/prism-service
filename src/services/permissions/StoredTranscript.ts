/**
 * A conversation's stored transcript, for the taint check (prompt 22 L3):
 * what the conversation has read, whatever history the client sent.
 *
 * The history a route hands the loop is not that record. ChatRequestSchema
 * drops a tool call's `result` from the client's copy, a relay may send no
 * history at all, and a model carries what it read into later turns inside
 * its encrypted reasoning (a Gemini thought signature, an OpenAI reasoning
 * item) — seen live 2026-09-23: Gemini quoted a page's command exactly, one
 * turn after reading it, from a history that no longer held the page. The
 * Finalizer stores every tool result as a `tool` message, and every
 * external input, so a turn seeds its UntrustedSpans from here too.
 */
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type { ProvenanceMessage } from "#src/services/memory/MemoryProvenance";

export interface TranscriptOwner {
  conversationId?: string | null;
  project?: string | null;
  username?: string | null;
  agent?: string | null;
}

/** Same collection rule as Finalizer.getCollectionOpts (and workspaceSnapshots). */
async function conversationCollection(owner: TranscriptOwner): Promise<string> {
  const { default: AgentPersonaRegistry } = await import("#src/services/AgentPersonaRegistry");
  return owner.agent || AgentPersonaRegistry.isAgentProject(owner.project || "")
    ? COLLECTIONS.AGENT_CONVERSATIONS
    : COLLECTIONS.MODEL_CONVERSATIONS;
}

/**
 * The stored messages of the conversation a turn continues — none for a new
 * one. Fail-open, like the compaction boundary's read: the turn then knows
 * what the history it was sent and its own tool results hold.
 */
export async function loadStoredTranscript(owner: TranscriptOwner): Promise<ProvenanceMessage[]> {
  const { conversationId, project, username } = owner;
  if (!conversationId || !project || !username) return [];
  try {
    const document = await MongoWrapper.getCollection(
      MONGO_DB_NAME,
      await conversationCollection(owner),
    ).findOne({ id: conversationId, project, username }, { projection: { messages: 1 } });
    const messages = (document as { messages?: unknown } | null)?.messages;
    return Array.isArray(messages) ? (messages as ProvenanceMessage[]) : [];
  } catch (error: unknown) {
    logger.warn(
      `[UntrustedSpans] Could not read the stored transcript of ${conversationId} — ` +
        `the taint check knows only the history this turn was sent: ${errorMessage(error)}`,
    );
    return [];
  }
}
