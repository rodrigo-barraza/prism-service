import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import {
  COLLECTIONS,
  NOTIFICATION_SOURCES,
  SYSTEM_STATUSES,
  TURN_RESUME,
} from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import TurnRunStore, { type TurnRunRecord } from "#src/services/TurnRunStore";
import TurnInputStore, {
  turnInputIdsIn,
  type StoredTurnInput,
} from "#src/services/TurnInputStore";
import DetachedWorkStore, { type DetachedWorkRecord } from "#src/services/DetachedWorkStore";
import PendingDecisionStore from "#src/services/PendingDecisionStore";
import type { TurnInputEntry, TurnInputPost } from "#src/services/TurnInputMailbox";
import type { TurnResumeState } from "#src/services/harnesses/types";

/**
 * TurnResumeService — what a starting process does about the turns the
 * previous one never finished (prompt 13, Landing 2).
 *
 * A turn a restart interrupted left three kinds of state behind: its
 * TurnRunStore record (request, loop state, the pass whose tool batch was
 * in progress), its checkpoint (the messages so far, on the conversation),
 * and its pending decisions (PendingDecisionStore). Plus whatever the
 * process still owed anyone: mailbox entries no turn took
 * (TurnInputStore) and background work whose outcome nobody was told
 * (DetachedWorkStore).
 *
 * `prepare` (before the stale-flag sweep) decides, per turn:
 *   - RE-DRIVEN: a tool batch was in progress (the pass is newer than the
 *     checkpoint) or the turn was paused at its cost cap before a model
 *     call (Landing 3), the request is on record, and it has not been
 *     re-driven MAXIMUM_ATTEMPTS times already (a crash loop). Its
 *     checkpoint and decisions are kept for it — and the spend and cap it
 *     had, so it is held to the cap it paused at.
 *   - SALVAGED: everything else — its checkpoint is merged into the
 *     transcript as before, its record dropped, and the decisions it was
 *     waiting on lapse (a card nothing will act on must not keep asking).
 *
 * `start` (once the process is up) then, for each re-driven turn: merges
 * its checkpoint into the transcript (so a reloading client sees the turn
 * so far), and runs it again through handleAgent with the stored request
 * and a resume payload — the harness replays the interrupted pass
 * (ResumedPass) and the gate picks up its decisions. Mailbox entries no
 * turn took go into the re-driven turn, or into the transcript; background
 * work nobody was told about is reported once, the same two ways. A task
 * that was running is UNCERTAIN: reported, never run again.
 *
 * Only root turns are re-driven. A sub-agent is not (its parent is told it
 * was interrupted, through its dispatch record); its decisions lapse.
 */

export interface ResumableTurn {
  run: TurnRunRecord;
  checkpoint: { messages: Array<Record<string, unknown>>; iteration?: number };
}

export interface ResumePlan {
  resumable: ResumableTurn[];
}

type ConversationDocument = Record<string, unknown> & {
  id: string;
  messages?: Array<Record<string, unknown>>;
  turnCheckpoint?: { messages?: Array<Record<string, unknown>>; iteration?: number };
};

function conversations(collection: string) {
  return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(collection) ?? null;
}

async function findConversation(
  collection: string,
  id: string,
  owner: { project?: string | null; username?: string | null },
): Promise<ConversationDocument | null> {
  const filter: Record<string, unknown> = { id };
  if (owner.project) filter.project = owner.project;
  if (owner.username) filter.username = owner.username;
  return ((await conversations(collection)?.findOne(filter)) as ConversationDocument | null) ?? null;
}

/** The conversation a loop key names — root conversations live in either collection. */
async function findLoopConversation(
  loopKey: string,
  owner: { project?: string | null; username?: string | null; conversationCollection?: string | null },
): Promise<{ document: ConversationDocument; collection: string } | null> {
  const collections = [
    ...(owner.conversationCollection ? [owner.conversationCollection] : []),
    COLLECTIONS.AGENT_CONVERSATIONS,
    COLLECTIONS.MODEL_CONVERSATIONS,
  ];
  for (const collection of new Set(collections)) {
    const document = await findConversation(collection, loopKey, owner);
    if (document) return { document, collection };
  }
  return null;
}

/**
 * Where a re-driven turn picks up: the pass whose tool batch was in progress
 * (newer than the checkpoint), else the iteration a budget pause stopped
 * before its model call. Null: neither — the turn has nothing to resume.
 */
function resumePoint(
  run: Pick<TurnRunRecord, "pass" | "budgetPausedAt">,
  checkpointIteration: number,
): { pass: TurnRunRecord["pass"]; iteration: number } | null {
  if (run.pass && run.pass.iteration >= checkpointIteration) {
    return { pass: run.pass, iteration: run.pass.iteration };
  }
  if (typeof run.budgetPausedAt === "number" && run.budgetPausedAt >= checkpointIteration) {
    return { pass: null, iteration: run.budgetPausedAt };
  }
  return null;
}

/** Why a record cannot be re-driven; null when it can. */
function whyNotResumable(run: TurnRunRecord, document: ConversationDocument | null): string | null {
  if (!document) return "its conversation is gone";
  if (!document.turnCheckpoint) return "its turn had finished";
  if (!resumePoint(run, document.turnCheckpoint.iteration ?? 0)) {
    return run.pass ? "its last tool batch had completed" : "no tool batch was in progress";
  }
  if (!run.request) return "its request is not on record";
  if (run.attempts >= TURN_RESUME.MAXIMUM_ATTEMPTS) {
    return `it was already re-driven ${run.attempts} time(s)`;
  }
  return null;
}

/** Lapse what a loop that will not run again was waiting on. */
async function lapseDecisionsOf(loopKeys: Iterable<string>): Promise<void> {
  const { ApprovalRegistry } = await import("#src/services/ApprovalRegistry");
  const { default: QuestionRegistry } = await import("#src/services/QuestionRegistry");
  const { default: ConversationRunState, locatorFor } = await import(
    "#src/services/conversation/ConversationRunState"
  );
  const { default: BudgetPauseRegistry } = await import("#src/services/BudgetPauseRegistry");
  for (const loopKey of loopKeys) {
    const [record] = await PendingDecisionStore.find({ loopKey, status: "pending" });
    await ApprovalRegistry.cancel(loopKey);
    await QuestionRegistry.cancelAll(loopKey);
    await BudgetPauseRegistry.cancel(loopKey);
    if (record) await ConversationRunState.clear(locatorFor(loopKey, record));
  }
}

/** A stored mailbox entry, as the mailbox holds it. */
function entryOf(stored: StoredTurnInput): TurnInputEntry {
  return {
    id: stored.id,
    kind: stored.kind,
    text: stored.text,
    ...(stored.images?.length ? { images: stored.images } : {}),
    receivedAt: stored.receivedAt,
    ...(stored.meta ? { meta: stored.meta } : {}),
  };
}

/** Background work's outcome as the notice its parent receives (the usual <task-notification>). */
async function noticeFor(record: DetachedWorkRecord): Promise<TurnInputPost | null> {
  if (record.kind === "async_task") {
    const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
    const { formatTaskCompletionNotification } = await import(
      "#src/services/tool-definitions/AsyncTaskTools"
    );
    const taskState = AsyncTaskRegistry.getTask(record.itemId) ?? AsyncTaskRegistry.restore(record);
    const notification = formatTaskCompletionNotification(taskState);
    return {
      kind: "task_completion",
      text: notification.content,
      meta: {
        _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK,
        _notificationId: notification.notificationId,
        taskId: record.itemId,
      },
    };
  }
  return subAgentDispatchNotice(record);
}

/** What became of each sub-agent of a dispatch its parent never heard back from. */
async function subAgentDispatchNotice(record: DetachedWorkRecord): Promise<TurnInputPost | null> {
  const agentIds = record.agentIds ?? [];
  if (agentIds.length === 0 || !record.project || !record.username) return null;
  const { default: PromptLocaleService } = await import("#src/services/PromptLocaleService");
  const { default: AgentNotificationService } = await import(
    "#src/services/AgentNotificationService"
  );
  const locale = PromptLocaleService.getDefaultLocale();
  const sections: string[] = [];
  let toolUses = 0;
  let durationMilliseconds = 0;
  for (const agentId of agentIds) {
    const agent = (await conversations(COLLECTIONS.AGENT_CONVERSATIONS)?.findOne({
      subAgentId: agentId,
      isSubAgent: true,
      project: record.project,
      username: record.username,
    })) as ConversationDocument | null;
    const description = String(agent?.subAgentDescription ?? agentId);
    toolUses += Number(agent?.subAgentToolUses ?? 0) || 0;
    durationMilliseconds += Number(agent?.subAgentDurationMilliseconds ?? 0) || 0;
    const status = String(agent?.subAgentStatus ?? SYSTEM_STATUSES.STOPPED);
    const finished =
      status === SYSTEM_STATUSES.COMPLETE ||
      status === SYSTEM_STATUSES.COMPLETED ||
      status === SYSTEM_STATUSES.IDLE;
    if (finished) {
      const answer = [...(agent?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant" && typeof message.content === "string");
      sections.push(
        `### ${agentId} ("${description}") — ${status}\n${String(answer?.content ?? "").slice(0, 8_000)}`,
      );
    } else {
      sections.push(
        `### ${agentId} ("${description}") — ${SYSTEM_STATUSES.UNCERTAIN}\n` +
          PromptLocaleService.get(locale, "harness.resume.interruptedSubAgent", { agentId, description }),
      );
    }
  }
  const message = AgentNotificationService.createNotificationMessage({
    status: SYSTEM_STATUSES.UNCERTAIN,
    summary: PromptLocaleService.get(locale, "harness.resume.interruptedSubAgentsSummary", {
      count: String(agentIds.length),
    }),
    toolUses,
    durationMilliseconds,
    resultBody: sections.join("\n\n"),
    source: NOTIFICATION_SOURCES.ORCHESTRATOR,
  }) as Record<string, unknown>;
  return {
    kind: "task_completion",
    text: String(message.content ?? ""),
    meta: {
      _notificationSource: message._notificationSource,
      _notificationId: message._notificationId,
    },
  };
}

/** Append messages to a conversation that has no turn to receive them. */
async function appendToTranscript(
  loopKey: string,
  owner: { project?: string | null; username?: string | null; conversationCollection?: string | null },
  messages: Array<Record<string, unknown>>,
): Promise<boolean> {
  if (messages.length === 0) return true;
  const found = await findLoopConversation(loopKey, owner);
  if (!found) return false;
  const { default: ConversationService } = await import("#src/services/ConversationService");
  await ConversationService.appendMessages(
    loopKey,
    String(found.document.project ?? owner.project ?? "any"),
    String(found.document.username ?? owner.username ?? "any"),
    messages as never,
    null,
    { collection: found.collection },
  );
  return true;
}

async function messageForInput(entry: TurnInputEntry): Promise<Record<string, unknown>> {
  const { buildTurnInputMessage } = await import("#src/services/harnesses/lifecycle/TurnInputDrain");
  return { ...buildTurnInputMessage(entry), timestamp: new Date(entry.receivedAt).toISOString() };
}

async function messageForNotice(notice: TurnInputPost): Promise<Record<string, unknown>> {
  return {
    role: "user",
    content: notice.text,
    timestamp: new Date().toISOString(),
    ...(notice.meta ?? {}),
  };
}

/** Start a re-driven turn the way a request would, without awaiting it. */
async function drive(run: TurnRunRecord, params: Record<string, unknown>): Promise<void> {
  const { handleAgent } = await import("#src/routes/ChatRoutes");
  const { withDirectViewerBroadcast } = await import("#src/utils/DirectViewerBroadcast");
  const { default: AgentSessionRegistry } = await import("#src/services/AgentSessionRegistry");
  const conversationId = run.conversationId;
  // Registered like a request's turn: /agent/stop reaches it, and a new
  // turn of the conversation is refused while it runs.
  const stopController = AgentSessionRegistry.register(conversationId);
  // Nobody is connected yet: every event goes to the conversation's
  // viewers, and a viewer that subscribes later is replayed the turn.
  const emit = withDirectViewerBroadcast(conversationId, (event: { type?: string }) => {
    logger.debug(`[TurnResume][${conversationId}] ${event.type}`);
  });
  void handleAgent(params, emit, { signal: stopController.signal })
    .catch((error: unknown) => {
      logger.error(`[TurnResume] Re-driven turn of ${conversationId} failed: ${getErrorMessage(error)}`);
    })
    .finally(() => AgentSessionRegistry.cleanup(conversationId, stopController));
}

const TurnResumeService = {
  /**
   * Decide which interrupted turns are re-driven; salvage the rest (merge
   * their checkpoints, drop their records, lapse their decisions). Run
   * BEFORE the stale-flag sweep and before pending decisions are restored.
   */
  async prepare(): Promise<ResumePlan> {
    const plan: ResumePlan = { resumable: [] };
    for (const run of await TurnRunStore.listAll()) {
      try {
        const document = await findConversation(run.conversationCollection, run.conversationId, run);
        const reason = whyNotResumable(run, document);
        if (reason) {
          logger.info(`[TurnResume] Not re-driving ${run.id}: ${reason}`);
          await TurnRunStore.discard(run.id);
          // A marker with nothing to salvage would otherwise stay behind.
          if (document?.turnCheckpoint && !document.turnCheckpoint.messages?.length) {
            await conversations(run.conversationCollection)?.updateOne(
              { id: run.conversationId },
              { $unset: { turnCheckpoint: "" } },
            );
          }
          continue;
        }
        plan.resumable.push({
          run,
          checkpoint: {
            messages: document!.turnCheckpoint!.messages ?? [],
            iteration: document!.turnCheckpoint!.iteration,
          },
        });
      } catch (error: unknown) {
        logger.error(`[TurnResume] Could not examine ${run.id}: ${getErrorMessage(error)}`);
      }
    }

    const resumedIds = new Set(plan.resumable.map(({ run }) => run.conversationId));
    const { default: ConversationService } = await import("#src/services/ConversationService");
    for (const collection of [COLLECTIONS.AGENT_CONVERSATIONS, COLLECTIONS.MODEL_CONVERSATIONS]) {
      try {
        const recovered = await ConversationService.recoverOrphanedTurnCheckpoints({
          collection,
          skipConversationIds: resumedIds,
        });
        if (recovered > 0) {
          logger.info(`Recovered ${recovered} interrupted turn(s) in ${collection} from crash checkpoints`);
        }
      } catch (error: unknown) {
        logger.error(`[TurnResume] Checkpoint salvage failed in ${collection}: ${getErrorMessage(error)}`);
      }
    }

    // Decisions of loops that will not run again lapse: a card nothing
    // will act on must not keep asking (and keep the conversation "needs you").
    const resumedLoops = new Set(plan.resumable.map(({ run }) => run.id));
    const orphanedLoops = new Set(
      (await PendingDecisionStore.listAllPending())
        .map((record) => record.loopKey)
        .filter((loopKey) => !resumedLoops.has(loopKey)),
    );
    if (orphanedLoops.size > 0) {
      await lapseDecisionsOf(orphanedLoops);
      logger.info(`[TurnResume] Lapsed the pending decisions of ${orphanedLoops.size} loop(s) that will not run again`);
    }
    return plan;
  },

  /**
   * Deliver what the previous process owed (mailbox entries, background
   * work outcomes — each once), then re-drive every resumable turn. The
   * turns run detached; this returns once they have been started.
   */
  async start(plan: ResumePlan): Promise<void> {
    const inputsByLoop = new Map<string, StoredTurnInput[]>();
    for (const input of await TurnInputStore.listAll()) {
      inputsByLoop.set(input.loopKey, [...(inputsByLoop.get(input.loopKey) ?? []), input]);
    }
    const workByLoop = new Map<string, DetachedWorkRecord[]>();
    for (const record of await DetachedWorkStore.listUndelivered()) {
      workByLoop.set(record.loopKey, [...(workByLoop.get(record.loopKey) ?? []), record]);
    }
    const resumedLoops = new Set(plan.resumable.map(({ run }) => run.id));

    // ── Loops that will not run again: into their transcripts ──
    for (const [loopKey, stored] of inputsByLoop) {
      if (resumedLoops.has(loopKey)) continue;
      try {
        const found = await findLoopConversation(loopKey, stored[0]);
        const delivered = turnInputIdsIn(found?.document.messages ?? []);
        const missing = stored.filter((input) => !delivered.has(input.id));
        const messages = await Promise.all(missing.map((input) => messageForInput(entryOf(input))));
        if (await appendToTranscript(loopKey, stored[0], messages)) {
          await TurnInputStore.forget(stored.map((input) => input.id));
          if (missing.length > 0) {
            logger.info(`[TurnResume] ${missing.length} mid-turn input(s) of ${loopKey} added to its transcript`);
          }
        }
      } catch (error: unknown) {
        logger.error(`[TurnResume] Could not settle the inputs of ${loopKey}: ${getErrorMessage(error)}`);
      }
    }
    for (const [loopKey, records] of workByLoop) {
      if (resumedLoops.has(loopKey)) continue;
      for (const record of records) {
        try {
          if (!(await DetachedWorkStore.claimForRestart(record.id))) continue;
          const found = await findLoopConversation(loopKey, record);
          if (!found || found.document.isSubAgent) continue; // a sub-agent's work dies with it
          const notice = await noticeFor(record);
          if (notice) await appendToTranscript(loopKey, record, [await messageForNotice(notice)]);
        } catch (error: unknown) {
          logger.error(`[TurnResume] Could not report ${record.kind} ${record.id}: ${getErrorMessage(error)}`);
        }
      }
    }

    // ── Re-driven turns ──
    for (const { run, checkpoint } of plan.resumable) {
      try {
        const claimed = await TurnRunStore.claim(run.id);
        const point = claimed ? resumePoint(claimed, checkpoint.iteration ?? 0) : null;
        if (!claimed || !point) continue;
        const collection = run.conversationCollection;
        const { default: ConversationService } = await import("#src/services/ConversationService");
        // The turn so far joins the transcript (a reloading client sees it);
        // the checkpoint stays as the mark of a turn still unfinished.
        if (checkpoint.messages.length > 0) {
          await ConversationService.appendMessages(
            run.conversationId,
            run.project,
            run.username,
            checkpoint.messages as never,
            null,
            { collection },
          );
        }
        await conversations(collection)?.updateOne(
          { id: run.conversationId, project: run.project, username: run.username },
          {
            $set: {
              turnCheckpoint: {
                messages: [],
                iteration: point.iteration,
                savedAt: new Date().toISOString(),
              },
            },
          },
        );
        const document = await findConversation(collection, run.conversationId, run);
        const history = (document?.messages ?? []).map((message) => ({
          ...message,
          _alreadyPersisted: true,
        }));

        const delivered = turnInputIdsIn(history);
        const inputs = (inputsByLoop.get(run.id) ?? [])
          .filter((input) => !delivered.has(input.id))
          .map(entryOf);
        const notices: TurnInputPost[] = [];
        for (const record of workByLoop.get(run.id) ?? []) {
          if (!(await DetachedWorkStore.claimForRestart(record.id))) continue;
          const notice = await noticeFor(record);
          if (notice) notices.push(notice);
        }

        const resume: TurnResumeState = {
          pass: point.pass ?? null,
          iteration: point.iteration,
          costBudget: claimed.costBudget ?? null,
          planModeActive: claimed.planModeActive,
          autoApprove: claimed.autoApprove,
          skillsText: claimed.skillsText ?? null,
          inputs,
          notices,
          attempt: claimed.attempts,
        };
        const params: Record<string, unknown> = {
          ...claimed.request,
          // The mode the turn was last in (a switch mid-turn included), not
          // only the one its request named; bypass is re-checked on resolve.
          ...(claimed.permissionMode ? { permissionMode: claimed.permissionMode } : {}),
          messages: history,
          conversationId: run.conversationId,
          agentConversationId: run.agentConversationId,
          project: run.project,
          username: run.username,
          ...(run.profileId ? { profileId: run.profileId } : {}),
          ...(claimed.conversationMeta ? { conversationMeta: claimed.conversationMeta } : {}),
          ...(claimed.systemPrompt ? { systemPrompt: claimed.systemPrompt } : {}),
          _resume: resume,
        };
        delete params.serverConversationId;
        logger.info(
          `[TurnResume] Re-driving ${run.id} at iteration ${point.iteration} (attempt ${claimed.attempts}/${TURN_RESUME.MAXIMUM_ATTEMPTS})` +
            (point.pass ? "" : " — paused at its cost cap before a model call"),
        );
        await drive(run, params);
      } catch (error: unknown) {
        logger.error(`[TurnResume] Could not re-drive ${run.id}: ${getErrorMessage(error)}`);
      }
    }
  },
};

export default TurnResumeService;
