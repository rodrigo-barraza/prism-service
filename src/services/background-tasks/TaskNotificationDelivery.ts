import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, TIMERS } from "#src/constants";
import {
  TASK_DELIVERY_TURN_POLL_MILLISECONDS,
  TASK_NOTIFICATION_CLIENT_IP,
} from "#src/constants/BackgroundTasks";
import AgentSessionRegistry from "#src/services/AgentSessionRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { authOfRecord, requestContext, type AuthKind } from "#src/utils/RequestContext";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { SseEvent } from "#src/types/SseTypes";

// ────────────────────────────────────────────────────────────
// TaskNotificationDelivery — background work reporting to its agent
// ────────────────────────────────────────────────────────────
// One service for every notification that background work owes an agent:
// a monitor's events, a background command's exit (BackgroundTaskWatcher)
// and an async task's completion (AsyncTaskTools). Claude Code's rule:
//
//   1. the owner's turn is open → its mailbox (TurnInputMailbox), drained
//      at the turn's next boundary;
//   2. else a root conversation → WAKE it: the notification is persisted as
//      a message and a new turn runs through handleAgent — with the
//      conversation's own permission mode and approval settings, as a Claude
//      Code session re-invoked by a notification runs (an ask nobody is
//      there for parks as a durable pending decision), and with the auth of
//      the turn that started the work: a signed-in user's work wakes a turn
//      with the owner's powers, a service's never does. One wake at a time
//      per conversation: notifications that arrive while it is starting
//      join it; once its turn has opened its mailbox they go there. A turn
//      that holds the conversation first (a user's: the wake's request
//      would get a 409) takes them through its own mailbox instead;
//   3. a sub-agent whose run has ended → dropped, with a log line (its
//      monitors were stopped when the run ended).
//
// A notification is the agent's own command output: a user-role message
// holding the <task-notification> blocks, never an <external-input>
// envelope, never untrusted text. Several that wake one turn are one
// message.
// ────────────────────────────────────────────────────────────

export interface WokenConversation {
  id: string;
  project: string;
  username: string;
}

export interface TaskNotice {
  /** The owner's loop key — its turn's mailbox (LoopKey.resolveLoopKey). */
  loopKey: string;
  /** The root conversation a wake runs: its client-facing id. */
  conversationId: string | null;
  /** Finds the conversation when its id is not known (an async task dispatched without one). */
  agentConversationId: string | null;
  project: string | null;
  username: string | null;
  /** A sub-agent is never woken: a notice after its run is dropped. */
  isSubAgent: boolean;
  /**
   * How the turn that started the work authenticated (null: unknown — a
   * record from before authentication). A wake runs with the weakest of its
   * notices' (wakeAuthKind): owner powers only when all are a user's.
   */
  authKind?: AuthKind | null;
  /** How it rides a mailbox. */
  kind: "task_notification" | "task_completion";
  /** The formatted <task-notification> block. */
  text: string;
  /** Copied onto the mailbox entry and the persisted message (`_notificationSource`, `_notificationId`, …). */
  meta: Record<string, unknown>;
  /** When it was formatted (ISO); now when absent. */
  timestamp?: string;
  /** The workspace the owner works in: a woken turn's root when the conversation names none. */
  workspaceRoot?: string | null;
  /**
   * Runs once the notice has been consumed: after the turn it woke has run
   * (or failed), or as soon as a running turn's mailbox took it in a wake's
   * place. An async task pays its pendingBackgroundTasks unit back here.
   */
  afterDelivery?: (via: "wake" | "mailbox", conversation: WokenConversation) => Promise<void>;
}

export type DeliveryOutcome = "mailbox" | "wake" | "dropped" | "failed";

export interface WakeOptions {
  /**
   * When another turn of the conversation runs: take the notice through its
   * mailbox (true, the default), or wait for it to end and wake a turn of
   * its own (false — an async task's default dispatch, whose dispatching
   * turn is ending and would only file the notice, never answer it).
   */
  joinRunningTurn?: boolean;
}

interface QueuedNotice {
  notice: TaskNotice;
  joinRunningTurn: boolean;
  handedOver: (outcome: DeliveryOutcome) => void;
}

interface PendingWake {
  key: string;
  /** Not handed over yet: persisted together when the wake starts its turn. */
  queued: QueuedNotice[];
  /** The conversation its turn runs, once it has started one. */
  conversationId: string | null;
}

/** One wake per conversation, keyed by its id (or the agent conversation id it is found by). */
const pendingWakes = new Map<string, PendingWake>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Whether a turn of the conversation runs in this process (a request's, a re-driven one, a timer's). */
function hasRunningTurn(conversationId: string): boolean {
  return AgentSessionRegistry.isActive(conversationId) || TurnInputMailbox.hasTurn(conversationId);
}

function post(conversationId: string, notice: TaskNotice): boolean {
  return TurnInputMailbox.post(conversationId, {
    kind: notice.kind,
    text: notice.text,
    meta: notice.meta,
  }).accepted;
}

function ownerOf(conversationId: string, notice: TaskNotice): WokenConversation {
  return {
    id: conversationId,
    project: notice.project ?? "any",
    username: notice.username ?? "any",
  };
}

function runAfterDelivery(notice: TaskNotice, via: "wake" | "mailbox", conversation: WokenConversation): void {
  notice.afterDelivery?.(via, conversation).catch((error: unknown) => {
    logger.warn(`[TaskNotificationDelivery] After-delivery step failed: ${getErrorMessage(error)}`);
  });
}

/**
 * Post queued notices into the conversation's open mailbox — every one, or
 * (`joinersOnly`, another turn's mailbox) only those that may join a turn
 * they did not start. What the mailbox refuses stays queued.
 */
function handOverToMailbox(wake: PendingWake, conversationId: string, joinersOnly: boolean): void {
  const kept: QueuedNotice[] = [];
  for (const queued of wake.queued.splice(0)) {
    if ((joinersOnly && !queued.joinRunningTurn) || !post(conversationId, queued.notice)) {
      kept.push(queued);
      continue;
    }
    queued.handedOver("mailbox");
    runAfterDelivery(queued.notice, "mailbox", ownerOf(conversationId, queued.notice));
  }
  wake.queued.push(...kept);
}

/** The persisted messages for a wake's notices: consecutive task notifications are one message. */
function messagesFor(notices: TaskNotice[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let previousKind: TaskNotice["kind"] | null = null;
  for (const notice of notices) {
    const last = messages[messages.length - 1];
    if (notice.kind === "task_notification" && previousKind === "task_notification" && last) {
      last.content = `${String(last.content)}\n${notice.text}`;
      continue;
    }
    messages.push({
      role: "user",
      content: notice.text,
      timestamp: notice.timestamp ?? new Date().toISOString(),
      _alreadyPersisted: true,
      ...notice.meta,
    });
    previousKind = notice.kind;
  }
  return messages;
}

function conversationCollection() {
  if (!MongoWrapper.getDb(MONGO_DB_NAME)) return null;
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS) ?? null;
}

type ConversationDocument = Record<string, unknown> & { id: string };

/**
 * The conversation a notice wakes: by its id, else by the agent conversation
 * id its work was started in (a call made with no client-facing id — a
 * tool run_async_task dispatched — names only that one).
 */
async function findConversation(notice: TaskNotice): Promise<ConversationDocument | null> {
  const conversations = conversationCollection();
  const label = notice.conversationId ?? notice.agentConversationId ?? notice.loopKey;
  if (!conversations) {
    logger.warn(`[TaskNotificationDelivery] Cannot wake ${label}: database not connected`);
    return null;
  }
  const owner: Record<string, unknown> = {
    ...(notice.project ? { project: notice.project } : {}),
    ...(notice.username ? { username: notice.username } : {}),
  };
  const filters = [
    ...(notice.conversationId ? [{ id: notice.conversationId, ...owner }] : []),
    ...(notice.agentConversationId ? [{ agentConversationId: notice.agentConversationId, ...owner }] : []),
  ];
  for (const filter of filters) {
    const document = (await conversations.findOne(filter)) as ConversationDocument | null;
    if (document) return document;
  }
  logger.warn(`[TaskNotificationDelivery] Cannot wake ${label}: conversation not found`);
  return null;
}

/** What the woken turn's request carries: the conversation's own model, agent, workspace and tool set. */
async function wakeRequest(
  conversation: ConversationDocument,
  notice: TaskNotice,
): Promise<Record<string, unknown> | null> {
  const project = String(conversation.project ?? notice.project ?? "any");
  const username = String(conversation.username ?? notice.username ?? "any");
  // The stored transcript is the source of truth — the notices just
  // persisted included, and anything a concurrent write added.
  const fresh = (await conversationCollection()?.findOne({ id: conversation.id, project, username })) as
    | ConversationDocument
    | null
    | undefined;
  if (!fresh) return null;
  // Everything loaded from the database is persisted (the Finalizer would
  // write the last message again otherwise: AgenticLoopService marks only
  // the ones before it).
  const messages = ((fresh.messages as Array<Record<string, unknown>> | undefined) ?? []).map(
    (message) => ({ ...message, _alreadyPersisted: true }),
  );
  const settings = (fresh.settings ?? {}) as Record<string, unknown>;
  const provider = settings.provider as string | undefined;
  const model = settings.model as string | undefined;
  if (!provider || !model) {
    logger.warn(`[TaskNotificationDelivery] Cannot wake ${conversation.id}: no provider/model in its settings`);
    return null;
  }
  const workspaceRoot = (settings.workspaceRoot as string | null | undefined) || notice.workspaceRoot || null;
  const toolConfig = settings.toolConfig as { disabledTools?: string[] } | null | undefined;
  return {
    provider,
    model,
    messages,
    conversationId: conversation.id,
    agent: (settings.agent as string | null | undefined) ?? null,
    project,
    username,
    ...(typeof fresh.profileId === "string" && fresh.profileId ? { profileId: fresh.profileId } : {}),
    clientIp: TASK_NOTIFICATION_CLIENT_IP,
    agenticLoopEnabled: true,
    functionCallingEnabled: true,
    // No autoApprove and no unattended: the turn runs in the conversation's
    // own permission mode and "auto-approve this conversation" setting
    // (AgenticLoopService reads both from the conversation).
    planFirst: false,
    minContextLength: TIMERS.MINIMUM_CONTEXT_LENGTH,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(toolConfig?.disabledTools ? { disabledTools: toolConfig.disabledTools } : {}),
  };
}

/**
 * The auth a wake runs with: a signed-in user's only when every notice it
 * carries came from a signed-in user's work — a service's notice (or one of
 * unknown origin) never lends a turn the owner's powers.
 */
export function wakeAuthKind(notices: TaskNotice[]): AuthKind | null {
  if (notices.length === 0) return null;
  if (notices.every((notice) => notice.authKind === "user")) return "user";
  return notices.some((notice) => notice.authKind === "service") ? "service" : null;
}

/** Run the woken turn the way a request's turn runs: admitted, stoppable, watched. */
async function runWokenTurn(
  conversationId: string,
  request: Record<string, unknown>,
  stopController: AbortController,
  authKind: AuthKind | null,
): Promise<void> {
  const { handleAgent } = await import("#src/routes/ChatRoutes");
  const { withDirectViewerBroadcast } = await import("#src/utils/DirectViewerBroadcast");
  // Nobody may be connected: every event goes to the conversation's
  // viewers, a viewer that subscribes later is replayed the turn, and an
  // approval it parks on reaches the "needs you" features.
  const emit = withDirectViewerBroadcast(conversationId, (event: SseEvent) => {
    logger.debug(`[TaskNotificationDelivery][${conversationId}] ${event.type}`);
  });
  // The turn runs as the conversation's owner, wherever the notice came
  // from — with the auth of the work that sent it (wakeAuthKind).
  await requestContext.run(
    {
      project: String(request.project),
      username: String(request.username),
      clientIp: TASK_NOTIFICATION_CLIENT_IP,
      agent: (request.agent as string | null) ?? null,
      ...(typeof request.profileId === "string" ? { profileId: request.profileId } : {}),
      auth: authOfRecord(authKind, String(request.username)),
    },
    () => handleAgent(request, emit, { signal: stopController.signal }),
  );
}

/** Once the started turn opens its mailbox, the notices that waited for it go in. */
async function handOverWhenOpen(wake: PendingWake, conversationId: string, turn: Promise<unknown>): Promise<void> {
  let ended = false;
  void turn.finally(() => {
    ended = true;
  });
  while (!ended && !TurnInputMailbox.isOpen(conversationId)) {
    await sleep(TASK_DELIVERY_TURN_POLL_MILLISECONDS);
  }
  if (TurnInputMailbox.isOpen(conversationId)) handOverToMailbox(wake, conversationId, false);
}

async function runWake(wake: PendingWake): Promise<void> {
  let conversation: ConversationDocument | null = null;
  let stopController: AbortController | null = null;
  let woken: QueuedNotice[] = [];
  let ran = false;
  try {
    const first = wake.queued[0].notice;
    conversation = await findConversation(first);
    if (!conversation) {
      for (const queued of wake.queued.splice(0)) queued.handedOver("failed");
      return;
    }
    if (conversation.isSubAgent === true) {
      logger.info(
        `[TaskNotificationDelivery] ${conversation.id} is a sub-agent's conversation — never woken; notification dropped`,
      );
      for (const queued of wake.queued.splice(0)) queued.handedOver("dropped");
      return;
    }
    const conversationId = conversation.id;

    // Another turn holds the conversation: it takes the notices through its
    // mailbox once that is open; what may not join it (or what it refuses)
    // waits for it to end.
    let waitLogged = false;
    while (hasRunningTurn(conversationId)) {
      if (TurnInputMailbox.isOpen(conversationId)) {
        handOverToMailbox(wake, conversationId, true);
        if (wake.queued.length === 0) return;
      }
      if (!waitLogged) {
        waitLogged = true;
        logger.info(`[TaskNotificationDelivery] ${conversationId} has a turn running — the notification waits for it`);
      }
      await sleep(TASK_DELIVERY_TURN_POLL_MILLISECONDS);
    }

    // Nothing runs: this wake's turn does, admitted like a request's (a
    // user's turn now gets the usual 409 and steers through /agent/input).
    stopController = AgentSessionRegistry.register(conversationId);
    wake.conversationId = conversationId;
    woken = wake.queued.splice(0);
    const { default: ConversationService } = await import("#src/services/ConversationService");
    await ConversationService.appendMessages(
      conversationId,
      String(conversation.project ?? first.project ?? "any"),
      String(conversation.username ?? first.username ?? "any"),
      messagesFor(woken.map((queued) => queued.notice)) as never,
      null,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );
    for (const queued of woken) queued.handedOver("wake");

    const request = await wakeRequest(conversation, first);
    if (!request) return;
    logger.info(`[TaskNotificationDelivery] Waking ${conversationId} for ${woken.length} notification(s)`);
    ran = true;
    const authKind = wakeAuthKind(woken.map((queued) => queued.notice));
    const turn = runWokenTurn(conversationId, request, stopController, authKind).catch((error: unknown) => {
      logger.error(`[TaskNotificationDelivery] Woken turn of ${conversationId} failed: ${getErrorMessage(error)}`);
    });
    await Promise.all([turn, handOverWhenOpen(wake, conversationId, turn)]);
  } catch (error: unknown) {
    logger.error(`[TaskNotificationDelivery] Wake of ${wake.key} failed: ${getErrorMessage(error)}`);
    // A notice already handed over keeps its outcome (a promise settles once).
    for (const queued of [...woken, ...wake.queued.splice(0)]) queued.handedOver("failed");
  } finally {
    if (stopController && conversation) AgentSessionRegistry.cleanup(conversation.id, stopController);
    if (pendingWakes.get(wake.key) === wake) pendingWakes.delete(wake.key);
    if (ran && conversation) {
      for (const queued of woken) {
        runAfterDelivery(queued.notice, "wake", {
          id: conversation.id,
          project: String(conversation.project ?? queued.notice.project ?? "any"),
          username: String(conversation.username ?? queued.notice.username ?? "any"),
        });
      }
    }
    // Notices that came while its turn ran and found no open mailbox (it
    // was sealed, finishing): the next wake is theirs.
    for (const queued of wake.queued.splice(0)) {
      void TaskNotificationDelivery.wake(queued.notice, { joinRunningTurn: queued.joinRunningTurn }).then(
        queued.handedOver,
      );
    }
  }
}

const TaskNotificationDelivery = {
  /**
   * Hand a notice to its owner: the running turn's mailbox, else a woken
   * turn (root), else nowhere (a sub-agent whose run ended). Resolves once
   * the notice is handed over — posted, or persisted for the turn it wakes
   * — not when that turn ends.
   */
  async deliver(notice: TaskNotice): Promise<DeliveryOutcome> {
    if (notice.loopKey && TurnInputMailbox.isOpen(notice.loopKey) && post(notice.loopKey, notice)) {
      runAfterDelivery(notice, "mailbox", ownerOf(notice.loopKey, notice));
      return "mailbox";
    }
    if (notice.isSubAgent) {
      logger.info(
        `[TaskNotificationDelivery] Notification for sub-agent ${notice.loopKey} after its run ended — dropped`,
      );
      return "dropped";
    }
    return TaskNotificationDelivery.wake(notice);
  },

  /** Wake the notice's root conversation (or join the wake already starting it). */
  wake(notice: TaskNotice, { joinRunningTurn = true }: WakeOptions = {}): Promise<DeliveryOutcome> {
    const key = notice.conversationId || notice.agentConversationId || notice.loopKey;
    return new Promise<DeliveryOutcome>((resolve) => {
      const queued: QueuedNotice = { notice, joinRunningTurn, handedOver: resolve };
      const pending = pendingWakes.get(key);
      if (pending) {
        // Its own turn is up and listening: the notice goes straight in.
        if (pending.conversationId && TurnInputMailbox.isOpen(pending.conversationId) && post(pending.conversationId, notice)) {
          resolve("mailbox");
          runAfterDelivery(notice, "mailbox", ownerOf(pending.conversationId, notice));
          return;
        }
        pending.queued.push(queued);
        return;
      }
      const wake: PendingWake = { key, queued: [queued], conversationId: null };
      pendingWakes.set(key, wake);
      void runWake(wake);
    });
  },

  /** Wakes starting or running, for diagnostics and tests. */
  get pendingWakeCount(): number {
    return pendingWakes.size;
  },

  /** Test helper — forget every wake. */
  _reset(): void {
    pendingWakes.clear();
  },
};

export default TaskNotificationDelivery;
