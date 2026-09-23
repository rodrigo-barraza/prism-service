import {
  PRISM_VAPID_PUBLIC_KEY,
  PRISM_VAPID_PRIVATE_KEY,
  PRISM_VAPID_SUBJECT,
  PRISM_PUSH_NTFY_TOPIC,
  PRISM_CLIENT_PUBLIC_URL,
  TOOLS_SERVICE_URL,
  MONGO_DB_NAME,
} from "#config";
import { COLLECTIONS } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";
import { DEFAULT_PROFILE_ID } from "#src/utils/ProfileScope";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import PushSubscriptionService, {
  type PushSubscriptionDocument,
} from "./PushSubscriptionService.ts";
import { sendWebPush, type VapidDetails } from "./WebPushProtocol.ts";

/**
 * PushNotifier — tells the user, through a browser push, that a
 * conversation needs them (an approval, a question) or finished (turn
 * completed / failed) — but only when nobody is watching it: a push is
 * sent when no VISIBLE viewer socket is subscribed to the conversation
 * (WebSocketConnectionRegistry.hasVisibleConnection). A tab in the
 * background reports itself hidden, so it still gets the push.
 *
 * The approvals of one batch arrive as one `approval_required` event per
 * call in the same tick; they coalesce into ONE notification, which
 * carries the `toolCallId` (and so Approve / Deny actions) only when the
 * batch is a single call.
 *
 * Delivery is Web Push to every subscription of the conversation's owner
 * `{username, profileId}`; when the owner has none and an ntfy topic is
 * configured, the message goes to ntfy through tools-service instead.
 */

export type PushMomentKind =
  | "approval_required"
  | "question_asked"
  | "budget_reached"
  | "turn_completed"
  | "turn_failed";

/** Moments that wait on a person: they ring at high urgency. */
function isDecisionMoment(kind: PushMomentKind): boolean {
  return kind === "approval_required" || kind === "question_asked" || kind === "budget_reached";
}

export interface PushMomentOwner {
  project: string | null;
  username: string | null;
  profileId: string | null;
  agent: string | null;
}

export interface PushMoment {
  kind: PushMomentKind;
  conversationId: string;
  toolCallId?: string | null;
  toolName?: string | null;
  batchSize?: number | null;
  questionId?: string | null;
  questionText?: string | null;
  errorMessage?: string | null;
  /** A budget pause: what the turn spent, against which cap. */
  spentDollars?: number | null;
  maxCostDollars?: number | null;
  owner?: PushMomentOwner;
}

/** What the service worker receives (JSON, encrypted end to end). */
export interface PushNotificationPayload {
  kind: PushMomentKind;
  conversationId: string;
  title: string;
  body: string;
  /** Deep link into prism-client, relative to its origin. */
  url: string;
  /** Replaces an older notification of the same conversation. */
  tag: string;
  /** Present only for a single-call approval: the call the actions decide. */
  toolCallId?: string;
  approvalCount?: number;
  questionId?: string;
  /** Headers the service worker's approve/deny POST identifies with. */
  identity: { username: string; project: string | null; profileId: string };
  timestamp: string;
}

interface ConversationSummary {
  title: string | null;
  agent: string | null;
  username: string | null;
  project: string | null;
  profileId: string | null;
}

const NOTIFICATION_TTL_SECONDS = 60 * 60;
const MAXIMUM_BODY_CHARACTERS = 180;

/** Approvals waiting for their tick to end, per conversation. */
const approvalBatches = new Map<string, PushMoment[]>();
const inFlight = new Set<Promise<void>>();
let hasWarnedAboutVapid = false;

function vapidDetails(): VapidDetails | null {
  if (!PRISM_VAPID_PUBLIC_KEY || !PRISM_VAPID_PRIVATE_KEY || !PRISM_VAPID_SUBJECT) {
    if (!hasWarnedAboutVapid) {
      hasWarnedAboutVapid = true;
      logger.info(
        "[PushNotifier] Web Push is off — PRISM_VAPID_PUBLIC_KEY / PRISM_VAPID_PRIVATE_KEY / PRISM_VAPID_SUBJECT are not all set",
      );
    }
    return null;
  }
  return {
    publicKey: PRISM_VAPID_PUBLIC_KEY,
    privateKey: PRISM_VAPID_PRIVATE_KEY,
    subject: PRISM_VAPID_SUBJECT,
  };
}

function truncate(text: string, limit: number = MAXIMUM_BODY_CHARACTERS): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function findConversation(conversationId: string): Promise<ConversationSummary | null> {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database) return null;
  const projection = { title: 1, agent: 1, username: 1, project: 1, profileId: 1 };
  for (const [collectionName, isAgentCollection] of [
    [COLLECTIONS.AGENT_CONVERSATIONS, true],
    [COLLECTIONS.MODEL_CONVERSATIONS, false],
  ] as const) {
    const document = (await database
      .collection(collectionName)
      .findOne({ id: conversationId }, { projection })) as Record<string, unknown> | null;
    if (document) {
      const text = (value: unknown) => (typeof value === "string" && value ? value : null);
      return {
        title: text(document.title),
        agent: isAgentCollection ? text(document.agent) : AGENT_IDS.NONE,
        username: text(document.username),
        project: text(document.project),
        profileId: text(document.profileId),
      };
    }
  }
  return null;
}

/** The prism-client route that opens a conversation. */
export function conversationDeepLink(conversationId: string, agent: string | null): string {
  const parameters = new URLSearchParams();
  if (agent) parameters.set("agent", agent);
  parameters.set("conversation", conversationId);
  return `/chat?${parameters.toString()}`;
}

/** Title and body of the notification for a moment. */
export function describeMoment(
  moment: PushMoment,
  conversationTitle: string | null,
  approvalCount: number,
): { title: string; body: string } {
  const where = conversationTitle ? truncate(conversationTitle, 60) : "Prism";
  switch (moment.kind) {
    case "approval_required":
      return {
        title: `Approval needed · ${where}`,
        body:
          approvalCount === 1
            ? `${moment.toolName || "A tool call"} is waiting for your approval.`
            : `${approvalCount} tool calls are waiting for your approval.`,
      };
    case "question_asked":
      return {
        title: `Question · ${where}`,
        body: truncate(moment.questionText || "The agent is waiting for your answer."),
      };
    case "budget_reached":
      return {
        title: `Budget reached · ${where}`,
        body:
          typeof moment.spentDollars === "number" && typeof moment.maxCostDollars === "number"
            ? `$${moment.spentDollars.toFixed(2)} spent of the $${moment.maxCostDollars.toFixed(2)} cap — raise it to let the agent continue.`
            : "The agent reached its cost cap — raise it to let the agent continue.",
      };
    case "turn_completed":
      return { title: `Done · ${where}`, body: "The agent finished its turn." };
    case "turn_failed":
      return {
        title: `Failed · ${where}`,
        body: truncate(moment.errorMessage || "The turn ended with an error."),
      };
  }
}

async function sendThroughNtfy(payload: PushNotificationPayload): Promise<void> {
  if (!PRISM_PUSH_NTFY_TOPIC || !TOOLS_SERVICE_URL) return;
  const response = await fetch(`${TOOLS_SERVICE_URL}/communication/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: PRISM_PUSH_NTFY_TOPIC,
      title: payload.title,
      message: payload.body,
      priority: isDecisionMoment(payload.kind) ? "high" : "default",
      ...(PRISM_CLIENT_PUBLIC_URL
        ? { clickUrl: new URL(payload.url, PRISM_CLIENT_PUBLIC_URL).toString() }
        : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    logger.warn(`[PushNotifier] ntfy fallback returned ${response.status}`);
  }
}

async function sendToSubscriptions(
  subscriptions: PushSubscriptionDocument[],
  payload: PushNotificationPayload,
  vapid: VapidDetails,
): Promise<void> {
  const serialized = JSON.stringify(payload);
  const urgency = isDecisionMoment(payload.kind) ? "high" : "normal";
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const { statusCode, body } = await sendWebPush(subscription, serialized, vapid, {
          ttlSeconds: NOTIFICATION_TTL_SECONDS,
          urgency,
        });
        if (statusCode === 404 || statusCode === 410) {
          await PushSubscriptionService.removeExpired(subscription.endpoint);
          logger.info(`[PushNotifier] Dropped expired subscription (${statusCode})`);
        } else if (statusCode >= 400) {
          logger.warn(
            `[PushNotifier] Push service answered ${statusCode}: ${body.slice(0, 200)}`,
          );
        }
      } catch (error: unknown) {
        logger.warn(`[PushNotifier] Push send failed: ${errorMessage(error)}`);
      }
    }),
  );
}

async function deliver(moment: PushMoment, approvalCount: number): Promise<void> {
  const { conversationId } = moment;
  if (WebSocketConnectionRegistry.hasVisibleConnection(conversationId)) {
    logger.debug(`[PushNotifier] ${moment.kind} on ${conversationId}: watched — no push`);
    return;
  }

  const vapid = vapidDetails();
  if (!vapid && !PRISM_PUSH_NTFY_TOPIC) return;

  // The request context names the owner; a turn running outside one
  // (a scheduled task, a wake-up) is looked up by its document.
  let conversation: ConversationSummary | null | undefined;
  if (!moment.owner?.username) conversation = await findConversation(conversationId);
  const username = moment.owner?.username || conversation?.username || null;
  if (!username) return;
  const profileId = moment.owner?.profileId || conversation?.profileId || DEFAULT_PROFILE_ID;

  const subscriptions = vapid
    ? await PushSubscriptionService.listForOwner({ username, profileId })
    : [];
  // Most turns belong to someone with no browser subscribed: stop here.
  if (subscriptions.length === 0 && !PRISM_PUSH_NTFY_TOPIC) return;

  if (conversation === undefined) conversation = await findConversation(conversationId);
  const project = moment.owner?.project || conversation?.project || null;

  const { title, body } = describeMoment(moment, conversation?.title ?? null, approvalCount);
  const payload: PushNotificationPayload = {
    kind: moment.kind,
    conversationId,
    title,
    body,
    url: conversationDeepLink(conversationId, moment.owner?.agent || conversation?.agent || null),
    tag: `prism:${conversationId}`,
    ...(moment.kind === "approval_required" && approvalCount === 1 && moment.toolCallId
      ? { toolCallId: moment.toolCallId }
      : {}),
    ...(moment.kind === "approval_required" ? { approvalCount } : {}),
    ...(moment.questionId ? { questionId: moment.questionId } : {}),
    identity: { username, project, profileId },
    timestamp: new Date().toISOString(),
  };

  if (subscriptions.length > 0 && vapid) {
    await sendToSubscriptions(subscriptions, payload, vapid);
  } else {
    await sendThroughNtfy(payload);
  }
}

function track(delivery: Promise<void>): void {
  const tracked = delivery
    .catch((error: unknown) => {
      logger.warn(`[PushNotifier] Delivery failed: ${errorMessage(error)}`);
    })
    .finally(() => {
      inFlight.delete(tracked);
    });
  inFlight.add(tracked);
}

function flushApprovals(conversationId: string): void {
  const batch = approvalBatches.get(conversationId);
  approvalBatches.delete(conversationId);
  if (!batch || batch.length === 0) return;
  const first = batch[0];
  const approvalCount = Math.max(batch.length, first.batchSize ?? 0);
  track(deliver(first, approvalCount));
}

const PushNotifier = {
  /** Queue a notification for a moment of a turn. Returns at once. */
  notify(moment: PushMoment): void {
    if (moment.kind !== "approval_required") {
      track(deliver(moment, 0));
      return;
    }
    const batch = approvalBatches.get(moment.conversationId);
    if (batch) {
      batch.push(moment);
      return;
    }
    approvalBatches.set(moment.conversationId, [moment]);
    setImmediate(() => flushApprovals(moment.conversationId));
  },

  /** Resolve once every queued notification has been handed off (tests). */
  async whenIdle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  },
};

export default PushNotifier;
