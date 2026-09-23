import crypto from "node:crypto";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type { RoleDecision } from "./RoleModelResolver.ts";

// ────────────────────────────────────────────────────────────
// RoutingDecisionLog — one row per routing decision, labelled later
// ────────────────────────────────────────────────────────────
// Collection `model_routing_decisions`. A row records the role, the
// model, why (the precedence layer and a reason), and a cache-warmth
// ESTIMATE: was this model's prefix used in the last five minutes —
// in this conversation, else by this agent (whose system prompt and
// tools are the shared prefix). The provider's own cache report arrives
// later on the request rows (prompt 10); this is what the router could
// know when it decided.
//
// Outcome, implicit: when the conversation's NEXT user turn arrives,
// every still-unlabelled decision of the conversation is labelled —
// `negative` when that turn corrects or redoes the last one, else
// `accepted`. A heuristic by design; the label is a signal to aggregate,
// not a verdict on one row.
// ────────────────────────────────────────────────────────────

/** How long a provider keeps a prompt prefix warm (Anthropic's 5-minute TTL; Gemini implicit ≈ minutes). */
export const CACHE_WARMTH_WINDOW_MILLISECONDS = 5 * 60 * 1000;

export type CacheWarmthScope = "conversation" | "agent";

export interface CacheWarmth {
  warm: boolean;
  /** What the warm prefix was shared with; null when cold. */
  scope: CacheWarmthScope | null;
  lastUsedAt: string | null;
}

export type RoutingOutcome = "negative" | "accepted";

export interface RoutingDecisionRow {
  id: string;
  createdAt: string;
  role: string;
  provider: string;
  model: string;
  effort: string | null;
  source: string;
  reason: string;
  pinnedBy: string | null;
  project: string | null;
  username: string | null;
  /** The ROOT conversation — outcome labels are keyed by it. */
  conversationId: string | null;
  agentConversationId: string | null;
  agent: string | null;
  /** A spawn's sub-agent id and the agent type it runs as. */
  subAgentId?: string | null;
  memberAgent?: string | null;
  preset: string | null;
  cacheWarmth: CacheWarmth;
  outcome: RoutingOutcome | null;
  outcomeReason?: "correction" | "redo" | null;
  outcomeAt?: string | null;
}

export interface RecordDecisionInput {
  decision: RoleDecision;
  project?: string | null;
  username?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
  agent?: string | null;
  subAgentId?: string | null;
  memberAgent?: string | null;
  preset?: string | null;
  /** Conversations whose requests share the decided model's prefix. */
  relatedConversationIds?: string[];
  now?: number;
}

function decisionsCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.MODEL_ROUTING_DECISIONS);
}

/**
 * Was `provider/model`'s prefix used in the last five minutes? Reads the
 * request log (agent iterations only — background calls carry other
 * prefixes): first this conversation's rows, then the agent's.
 */
export async function estimateCacheWarmth({
  provider,
  model,
  agent,
  conversationIds,
  now = Date.now(),
}: {
  provider: string;
  model: string;
  agent?: string | null;
  conversationIds?: string[];
  now?: number;
}): Promise<CacheWarmth> {
  const cold: CacheWarmth = { warm: false, scope: null, lastUsedAt: null };
  try {
    const requests = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.REQUESTS);
    if (!requests) return cold;
    const since = new Date(now - CACHE_WARMTH_WINDOW_MILLISECONDS).toISOString();
    const base = { provider, model, operation: "agent:iteration", createdAt: { $gte: since } };
    const scopes: Array<[CacheWarmthScope, Record<string, unknown> | null]> = [
      [
        "conversation",
        conversationIds && conversationIds.length > 0
          ? {
              $or: [
                { conversationId: { $in: conversationIds } },
                { agentConversationId: { $in: conversationIds } },
              ],
            }
          : null,
      ],
      ["agent", agent ? { agent } : null],
    ];
    for (const [scope, filter] of scopes) {
      if (!filter) continue;
      const latest = await requests.findOne(
        { ...base, ...filter },
        { sort: { createdAt: -1 }, projection: { createdAt: 1 } },
      );
      if (latest) {
        return { warm: true, scope, lastUsedAt: String(latest.createdAt) };
      }
    }
    return cold;
  } catch (error: unknown) {
    logger.warn(`[RoutingDecisionLog] Cache warmth unknown: ${errorMessage(error)}`);
    return cold;
  }
}

/** Write one decision row. Best-effort: routing never fails on its log. */
export async function recordRoutingDecision(
  input: RecordDecisionInput,
): Promise<RoutingDecisionRow | null> {
  const { decision } = input;
  const now = input.now ?? Date.now();
  const cacheWarmth = await estimateCacheWarmth({
    provider: decision.provider,
    model: decision.model,
    agent: input.memberAgent || input.agent,
    conversationIds: [
      ...(input.relatedConversationIds ?? []),
      ...(input.conversationId ? [input.conversationId] : []),
    ],
    now,
  });
  const row: RoutingDecisionRow = {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    role: decision.role,
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    source: decision.source,
    reason: decision.reason,
    pinnedBy: decision.pinnedBy ?? null,
    project: input.project ?? null,
    username: input.username ?? null,
    conversationId: input.conversationId ?? null,
    agentConversationId: input.agentConversationId ?? null,
    agent: input.agent ?? null,
    ...(input.subAgentId ? { subAgentId: input.subAgentId } : {}),
    ...(input.memberAgent ? { memberAgent: input.memberAgent } : {}),
    preset: input.preset ?? null,
    cacheWarmth,
    outcome: null,
  };
  logger.info(
    `[Routing] ${row.role} → ${row.provider}/${row.model}` +
      `${row.effort ? ` @${row.effort}` : ""} (${row.source}: ${row.reason}; ` +
      `cache ${cacheWarmth.warm ? `warm by ${cacheWarmth.scope}` : "cold"})` +
      `${row.conversationId ? ` conversation=${row.conversationId}` : ""}`,
  );
  try {
    const collection = decisionsCollection();
    if (collection) await collection.insertOne({ ...row });
  } catch (error: unknown) {
    logger.warn(`[RoutingDecisionLog] Could not store a ${row.role} decision: ${errorMessage(error)}`);
  }
  return row;
}

// ── Outcome ──────────────────────────────────────────────────

/**
 * A turn that opens like this corrects the one before it. Matched at the
 * start of the user's message only — "no" inside a sentence is not a
 * correction.
 */
const CORRECTION_PATTERN =
  /^\s*(?:no\b|nope\b|wrong\b|incorrect\b|that(?:'s| is) (?:not|wrong|incorrect)\b|not what i\b|try again\b|redo\b|do it again\b|undo\b|revert\b|you (?:didn'?t|did not|forgot|missed|broke)\b|it (?:still )?(?:doesn'?t|does not|didn'?t|did not) work\b|still (?:wrong|broken|failing|not)\b)/i;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** How the next user turn judges the previous one: a correction, a redo, or neither. */
export function classifyFollowUp(
  userText: string | null | undefined,
  previousUserText: string | null | undefined,
): "correction" | "redo" | null {
  if (!userText) return null;
  if (previousUserText && normalizeText(userText) === normalizeText(previousUserText)) {
    return "redo";
  }
  return CORRECTION_PATTERN.test(userText) ? "correction" : null;
}

/**
 * Label every unlabelled decision of `conversationId` — the decisions of
 * the turn before this one. Best-effort and silent on failure.
 */
export async function labelPriorDecisions({
  conversationId,
  userText,
  previousUserText,
  now = Date.now(),
}: {
  conversationId: string;
  userText: string | null | undefined;
  previousUserText: string | null | undefined;
  now?: number;
}): Promise<{ outcome: RoutingOutcome; labelled: number } | null> {
  if (!conversationId || !userText) return null;
  const followUp = classifyFollowUp(userText, previousUserText);
  const outcome: RoutingOutcome = followUp ? "negative" : "accepted";
  try {
    const collection = decisionsCollection();
    if (!collection) return null;
    const result = await collection.updateMany(
      { conversationId, outcome: null, createdAt: { $lt: new Date(now).toISOString() } },
      {
        $set: {
          outcome,
          outcomeReason: followUp,
          outcomeAt: new Date(now).toISOString(),
        },
      },
    );
    const labelled = result?.modifiedCount ?? 0;
    if (labelled > 0) {
      logger.info(
        `[Routing] ${labelled} decision(s) of ${conversationId} labelled ${outcome}${followUp ? ` (${followUp})` : ""}`,
      );
    }
    return { outcome, labelled };
  } catch (error: unknown) {
    logger.warn(`[RoutingDecisionLog] Could not label decisions of ${conversationId}: ${errorMessage(error)}`);
    return null;
  }
}
