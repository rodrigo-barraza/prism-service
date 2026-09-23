import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import {
  resolveMainModel,
  type ModelChoice,
  type RoleDecision,
  type RoleDecisionSource,
} from "./RoleModelResolver.ts";
import { isRoutingPreset, resolveRoutingPreset, type RoutingPreset } from "./RoutingPresets.ts";
import { MODEL_ROLES } from "#src/services/ModelRoleRouter";

// ────────────────────────────────────────────────────────────
// ConversationModelRouting — the main model is decided ONCE
// ────────────────────────────────────────────────────────────
// A new conversation resolves its `main` role (RoleModelResolver) and its
// routing preset, and the result is stored on the conversation
// (`modelRouting.main`). Every later turn runs on the stored model: an
// agent pin or a Settings knob edited since does not move a running
// conversation — caches are model-scoped, and an implicit switch re-pays
// the whole prefix. Only the caller switches it, by sending a model that
// is neither the stored one nor the one it sent when it was decided.
//
// A conversation from before role routing has no record: it keeps the
// caller's model (recorded as `conversation`) and is never re-routed.
// ────────────────────────────────────────────────────────────

export interface MainRoutingRecord {
  provider: string;
  model: string;
  effort: string | null;
  source: RoleDecisionSource;
  reason: string;
  pinnedBy?: string;
  /** What the caller sent when this was decided — sending it again is not a switch. */
  requested: { provider: string; model: string | null };
  preset: RoutingPreset | null;
  decidedAt: string;
}

export interface ConversationModelRouting {
  main?: MainRoutingRecord;
}

export interface RoutedTurn {
  provider: string;
  model: string;
  /** Effort the routing imposes; null leaves the request's. */
  effort: string | null;
  preset: RoutingPreset | null;
  record: MainRoutingRecord;
  /** A decision was made this turn — persist `record` and log it. */
  decided: boolean;
  decision: RoleDecision;
}

/** Stored routing of a conversation; null when none (or unreadable). */
export async function loadConversationModelRouting({
  conversationId,
  project,
  username,
}: {
  conversationId: string;
  project: string;
  username: string;
}): Promise<{ routing: ConversationModelRouting | null; recentMessages: Array<Record<string, unknown>> }> {
  try {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS);
    if (!collection) return { routing: null, recentMessages: [] };
    const document = await collection.findOne(
      { id: conversationId, project, username },
      { projection: { modelRouting: 1, messages: { $slice: -12 } } },
    );
    return {
      routing: (document?.modelRouting as ConversationModelRouting | undefined) ?? null,
      recentMessages: Array.isArray(document?.messages)
        ? (document.messages as Array<Record<string, unknown>>)
        : [],
    };
  } catch (error: unknown) {
    logger.warn(
      `[Routing] Could not read the routing of ${conversationId} — the caller's model stands: ${errorMessage(error)}`,
    );
    return { routing: null, recentMessages: [] };
  }
}

/**
 * Store the conversation's main-model record. Its own `$set` — never the
 * finalizer's conversation meta, which is also what makes it append the
 * turn's user message. Written after the turn (its document exists by
 * then, even when the turn failed). Best-effort.
 */
export async function saveConversationModelRouting({
  conversationId,
  project,
  username,
  record,
}: {
  conversationId: string;
  project: string;
  username: string;
  record: MainRoutingRecord;
}): Promise<void> {
  try {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS);
    if (!collection) return;
    await collection.updateOne(
      { id: conversationId, project, username },
      { $set: { "modelRouting.main": record } },
    );
  } catch (error: unknown) {
    logger.warn(`[Routing] Could not store the routing of ${conversationId}: ${errorMessage(error)}`);
  }
}

function sameChoice(
  request: ModelChoice,
  stored: { provider: string; model: string | null },
): boolean {
  return request.provider === stored.provider && (request.model ?? null) === (stored.model ?? null);
}

function recordOf(
  decision: RoleDecision,
  request: ModelChoice,
  preset: RoutingPreset | null,
  now: number,
): MainRoutingRecord {
  return {
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    source: decision.source,
    reason: decision.reason,
    ...(decision.pinnedBy ? { pinnedBy: decision.pinnedBy } : {}),
    requested: { provider: request.provider, model: request.model ?? null },
    preset,
    decidedAt: new Date(now).toISOString(),
  };
}

/** Only an agent pin imposes effort; any other record echoes the caller's, who may change it. */
function imposedEffort(record: MainRoutingRecord): string | null {
  return record.source === "custom_agent" || record.source === "persona" ? record.effort : null;
}

/**
 * The model this turn of the conversation runs on. `stored` is the
 * conversation's routing (loadConversationModelRouting); pass null for a
 * new conversation.
 */
export async function routeConversationTurn({
  isNewConversation,
  stored,
  agent,
  request,
  requestPreset,
  now = Date.now(),
}: {
  isNewConversation: boolean;
  stored: ConversationModelRouting | null;
  agent: string | null | undefined;
  request: ModelChoice;
  requestPreset?: unknown;
  now?: number;
}): Promise<RoutedTurn> {
  if (!isNewConversation) {
    const main = stored?.main;
    if (main) {
      if (!request.model || sameChoice(request, main) || sameChoice(request, main.requested)) {
        return {
          provider: main.provider,
          model: main.model,
          effort: imposedEffort(main),
          preset: main.preset,
          record: main,
          decided: false,
          decision: { role: MODEL_ROLES.MAIN, ...main, effort: main.effort },
        };
      }
      const decision: RoleDecision = {
        role: MODEL_ROLES.MAIN,
        provider: request.provider,
        model: request.model,
        effort: request.effort ?? null,
        source: "request",
        reason: `the caller switched this conversation from ${main.provider}/${main.model}`,
      };
      return {
        provider: decision.provider,
        model: decision.model,
        effort: null,
        preset: main.preset,
        record: recordOf(decision, request, main.preset, now),
        decided: true,
        decision,
      };
    }
    // Before role routing: never re-routed. An explicit preset still applies.
    const preset = isRoutingPreset(requestPreset) ? requestPreset : null;
    const decision: RoleDecision = {
      role: MODEL_ROLES.MAIN,
      provider: request.provider,
      model: request.model ?? "",
      effort: request.effort ?? null,
      source: "conversation",
      reason: "a conversation from before role routing keeps the caller's model",
    };
    return {
      provider: decision.provider,
      model: decision.model,
      effort: null,
      preset,
      record: recordOf(decision, request, preset, now),
      decided: true,
      decision,
    };
  }

  const [decision, presetDecision] = await Promise.all([
    resolveMainModel({ agent, request }),
    resolveRoutingPreset({ agent, requestPreset }),
  ]);
  const record = recordOf(decision, request, presetDecision.preset, now);
  return {
    provider: decision.provider,
    model: decision.model,
    effort: imposedEffort(record),
    preset: presetDecision.preset,
    record,
    decided: true,
    decision,
  };
}

// ── The /agent entry point ───────────────────────────────────

function textOf(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const raw = typeof message.rawContent === "string" ? message.rawContent : message.content;
  return typeof raw === "string" ? raw : null;
}

/** A user message the user wrote — not a task notification or an injected context block. */
function isUserAuthored(message: Record<string, unknown>): boolean {
  return message.role === "user" && !message._notificationSource && !message.deleted && !message.pruned;
}

/**
 * Route one /agent turn before its generation context is built: the
 * returned params carry the conversation's main model (and a pin's
 * effort, and its preset). Also labels the previous turn's decisions
 * and logs this turn's, both best-effort. Any failure leaves the
 * request's own model — routing never fails a turn.
 */
export async function routeAgentTurn(
  params: Record<string, unknown>,
  { now = Date.now() }: { now?: number } = {},
): Promise<{ params: Record<string, unknown>; routed: RoutedTurn | null }> {
  const provider = typeof params.provider === "string" ? params.provider : "";
  if (!provider) return { params, routed: null };
  const conversationId =
    typeof params.conversationId === "string" && params.conversationId ? params.conversationId : null;
  const project = String(params.project ?? "");
  const username = String(params.username ?? "");
  const agent = typeof params.agent === "string" ? params.agent : null;
  const effortParam =
    typeof params.reasoningEffort === "string"
      ? params.reasoningEffort
      : typeof params.thinkingLevel === "string"
        ? params.thinkingLevel
        : null;
  const request: ModelChoice = {
    provider,
    model: typeof params.model === "string" && params.model ? params.model : null,
    effort: effortParam,
  };

  try {
    const { routing: stored, recentMessages } = conversationId
      ? await loadConversationModelRouting({ conversationId, project, username })
      : { routing: null, recentMessages: [] };
    // A conversation whose first turn never answered (it failed, or its
    // record was never stored) is still starting: route it as new.
    const isNewConversation =
      !conversationId ||
      (!stored?.main && !recentMessages.some((message) => message.role === "assistant"));
    const routed = await routeConversationTurn({
      isNewConversation,
      stored,
      agent,
      request,
      requestPreset: params.routingPreset,
      now,
    });

    const { labelPriorDecisions, recordRoutingDecision } = await import("./RoutingDecisionLog.ts");
    if (conversationId) {
      const requestMessages = Array.isArray(params.messages)
        ? (params.messages as Array<Record<string, unknown>>)
        : [];
      const latest = requestMessages[requestMessages.length - 1];
      // A turn woken by a finished task is not the user judging the last one.
      if (latest && isUserAuthored(latest)) {
        const previousUser = [...recentMessages].reverse().find(isUserAuthored);
        await labelPriorDecisions({
          conversationId,
          userText: textOf(latest),
          previousUserText: textOf(previousUser),
          now,
        });
      }
    }
    if (routed.decided) {
      await recordRoutingDecision({
        decision: routed.decision,
        project,
        username,
        conversationId:
          conversationId ||
          (typeof params.serverConversationId === "string" ? params.serverConversationId : null),
        agent,
        preset: routed.preset,
        now,
      });
    }

    return {
      params: {
        ...params,
        provider: routed.provider,
        ...(routed.model ? { model: routed.model } : {}),
        ...(routed.effort ? { reasoningEffort: routed.effort, thinkingLevel: routed.effort } : {}),
        ...(routed.preset ? { routingPreset: routed.preset } : {}),
      },
      routed,
    };
  } catch (error: unknown) {
    logger.warn(`[Routing] Turn routing failed — the request's model stands: ${errorMessage(error)}`);
    return { params, routed: null };
  }
}
