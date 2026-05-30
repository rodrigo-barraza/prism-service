import type { Db } from "mongodb";
import { COLLECTIONS } from "../constants.ts";

const MAX_SESSION_DEPTH = 10;

/**
 * Recursively discover all descendant session IDs by walking the
 * `parentAgentSessionId` chain in the requests collection.
 *
 * Returns a Set containing the root session ID plus all descendants.
 * Used by admin session stats, session requests, and ConversationService.
 */
export async function discoverDescendantSessionIds(
  database: Db,
  rootSessionId: string,
  additionalFilter: Record<string, unknown> = {},
): Promise<Set<string>> {
  const allSessionIds = new Set([rootSessionId]);
  let frontier = [rootSessionId];

  for (let depth = 0; depth < MAX_SESSION_DEPTH && frontier.length > 0; depth++) {
    const childIds = await database
      .collection(COLLECTIONS.REQUESTS)
      .distinct("agentSessionId", {
        parentAgentSessionId: { $in: frontier },
        agentSessionId: { $nin: [...allSessionIds] },
        ...additionalFilter,
      });

    if (childIds.length === 0) break;

    const newIds = childIds.filter(Boolean);
    for (const id of newIds) allSessionIds.add(id);
    frontier = newIds;
  }

  return allSessionIds;
}
