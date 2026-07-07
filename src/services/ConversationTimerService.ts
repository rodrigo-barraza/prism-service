import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, NOTIFICATION_SOURCES, TIMER_MODES, TIMER_STATUSES, TIMERS } from "#src/constants";
import logger from "#src/utils/logger";
import AgenticLoopService from "./AgenticLoopService.ts";
import ConversationService from "./ConversationService.ts";
import { getProvider } from "#src/providers/index";
import { getModelByName } from "#src/config";
import { matchCron } from "./ScheduledTaskService.ts";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import { getErrorMessage } from "#src/utils/ErrorHelpers";
import type { ConversationMessage, LLMProvider } from "./harnesses/types.ts";
import type { TransformedConversation, ConversationSettings } from "./conversation/types.ts";
import type { ChatMessage } from "#src/types/admin";
import type { SseEvent } from "#src/types/SseTypes";

export interface ConversationTimer {
  id: string;
  conversationId: string;
  project: string;
  username: string;
  prompt: string;
  mode: typeof TIMER_MODES[keyof typeof TIMER_MODES];
  durationSeconds?: number;
  cronExpression?: string;
  maxIterations?: number;
  iterationCount: number;
  firesAt: string; // ISO timestamp for one-shot next fire time
  lastFiredMinuteKey?: string; // "YYYY-MM-DDTHH:mm" for preventing cron double-fires
  status: typeof TIMER_STATUSES[keyof typeof TIMER_STATUSES];
  createdAt: string;
  updatedAt: string;
}

interface TimerConversationSettings extends ConversationSettings {
  provider?: string;
  model?: string;
  agent?: string | null;
  workspaceRoot?: string | null;
  toolConfig?: {
    enabledTools?: string[];
    disabledTools?: string[];
  };
}

export interface TimerConversationContext {
  id: string;
  project: string;
  username: string;
  title?: string;
  messages?: Array<ChatMessage | ConversationMessage>;
  settings?: ConversationSettings;
  traceId?: string | null;
}

// ── File-level Constants ──────────────────────────────────────
const BACKGROUND_DAEMON_INTERVAL_MILLISECONDS = TIMERS.BACKGROUND_DAEMON_INTERVAL_MILLISECONDS;
const ONE_SHOT_MAXIMUM_DURATION_SECONDS = TIMERS.ONE_SHOT_MAXIMUM_DURATION_SECONDS;
const ONE_MINUTE_IN_MILLISECONDS = 60 * 1000;
const MINIMUM_CONTEXT_LENGTH = TIMERS.MINIMUM_CONTEXT_LENGTH;

let tickerInterval: ReturnType<typeof setInterval> | null = null;
let isTickInProgress = false;

const ConversationTimerService = {
  /**
   * Initialize the timer daemon. Checks for due timers every 1 second.
   */
  async initialize(): Promise<void> {
    if (tickerInterval) {
      clearInterval(tickerInterval);
    }

    logger.info(
      "[ConversationTimers] Starting background timer daemon (1s interval)...",
    );

    tickerInterval = setInterval(() => {
      if (isTickInProgress) return;
      isTickInProgress = true;
      this.tick()
        .catch((error: Error) => {
          logger.error(
            `[ConversationTimers] Daemon tick error: ${getErrorMessage(error)}`,
          );
        })
        .finally(() => {
          isTickInProgress = false;
        });
    }, BACKGROUND_DAEMON_INTERVAL_MILLISECONDS);

    logger.success("[ConversationTimers] Background timer daemon active.");
  },

  /**
   * Stop the background timer daemon.
   */
  destroy(): void {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
      logger.info("[ConversationTimers] Background timer daemon stopped.");
    }
  },

  /**
   * Create a new timer and persist it to MongoDB.
   */
  async createTimer(data: {
    conversationId: string;
    project: string;
    username: string;
    prompt: string;
    durationSeconds?: number;
    cronExpression?: string;
    maxIterations?: number;
  }): Promise<ConversationTimer> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) {
      throw new Error("Database connection unavailable");
    }

    const currentTimestamp = new Date();
    const mode = data.cronExpression ? TIMER_MODES.RECURRING : TIMER_MODES.ONE_SHOT;
    const timestampString = currentTimestamp.toISOString();

    // Input validation
    let firesAt = timestampString;
    if (mode === TIMER_MODES.ONE_SHOT) {
      const seconds = data.durationSeconds ?? 0;
      if (seconds <= 0 || seconds > ONE_SHOT_MAXIMUM_DURATION_SECONDS) {
        throw new Error(
          `One-shot duration must be between 1 and ${ONE_SHOT_MAXIMUM_DURATION_SECONDS} seconds (24 hours).`,
        );
      }
      firesAt = new Date(currentTimestamp.getTime() + seconds * 1000).toISOString();
    } else {
      // For recurring timers, check cron pattern syntax
      if (
        !data.cronExpression ||
        data.cronExpression.trim().split(/\s+/).length !== 5
      ) {
        throw new Error(
          "A valid 5-field cron expression is required for recurring reminders.",
        );
      }
      // Calculate first fire time as next minute boundary
      const nextMinute = new Date(currentTimestamp.getTime() + ONE_MINUTE_IN_MILLISECONDS);
      nextMinute.setSeconds(0, 0);
      firesAt = nextMinute.toISOString();
    }

    const timer: ConversationTimer = {
      id: crypto.randomUUID(),
      conversationId: data.conversationId,
      project: data.project,
      username: data.username,
      prompt: data.prompt,
      mode,
      durationSeconds: data.durationSeconds,
      cronExpression: data.cronExpression,
      maxIterations: data.maxIterations,
      iterationCount: 0,
      firesAt,
      status: TIMER_STATUSES.ACTIVE,
      createdAt: timestampString,
      updatedAt: timestampString,
    };

    const timerCollection = database.collection<ConversationTimer>(COLLECTIONS.CONVERSATION_TIMERS);
    await timerCollection.insertOne(timer);

    logger.info(
      `[ConversationTimers] Scheduled ${mode} timer ${timer.id} for conversation ${timer.conversationId}`,
    );

    return timer;
  },

  /**
   * Cancel an active timer by changing its status to "cancelled".
   */
  async cancelTimer(
    timerId: string,
    project: string,
    username: string,
  ): Promise<boolean> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) {
      throw new Error("Database connection unavailable");
    }

    const timerCollection = database.collection<ConversationTimer>(COLLECTIONS.CONVERSATION_TIMERS);
    const result = await timerCollection.updateOne(
      { id: timerId, project, username, status: TIMER_STATUSES.ACTIVE },
      { $set: { status: TIMER_STATUSES.CANCELLED, updatedAt: new Date().toISOString() } },
    );

    const isCancelled = (result.modifiedCount ?? 0) > 0;
    if (isCancelled) {
      logger.info(`[ConversationTimers] Cancelled timer ${timerId}`);
    }
    return isCancelled;
  },

  /**
   * List all active timers for a specific conversation.
   */
  async listActiveTimers(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<ConversationTimer[]> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return [];

    const timerCollection = database.collection<ConversationTimer>(COLLECTIONS.CONVERSATION_TIMERS);
    return await timerCollection
      .find({ conversationId, project, username, status: TIMER_STATUSES.ACTIVE })
      .sort({ createdAt: 1 })
      .toArray();
  },

  /**
   * Daemon tick: scans MongoDB for due timers, deferring execution if
   * conversation isGenerating state is true, and fires those that are due.
   */
  async tick(): Promise<void> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    const currentTimestamp = new Date();
    const nowTimestamp = currentTimestamp.toISOString();

    const timerCollection = database.collection<ConversationTimer>(COLLECTIONS.CONVERSATION_TIMERS);

    // Query active timers whose firesAt time is due
    const dueTimers = await timerCollection
      .find({ status: TIMER_STATUSES.ACTIVE, firesAt: { $lte: nowTimestamp } })
      .toArray();

    if (dueTimers.length === 0) return;

    for (const timer of dueTimers) {
      try {
        // Fetch target conversation to check its current status.
        // Check agent_conversations first, then fallback to model_conversations.
        let collection = COLLECTIONS.AGENT_CONVERSATIONS;
        const agentConversationsCollection = database.collection<TransformedConversation>(COLLECTIONS.AGENT_CONVERSATIONS);
        const modelConversationsCollection = database.collection<TransformedConversation>(COLLECTIONS.MODEL_CONVERSATIONS);

        let conversation = await agentConversationsCollection.findOne({
          id: timer.conversationId,
          project: timer.project,
          username: timer.username,
        });

        if (!conversation) {
          collection = COLLECTIONS.MODEL_CONVERSATIONS;
          conversation = await modelConversationsCollection.findOne({
            id: timer.conversationId,
            project: timer.project,
            username: timer.username,
          });
        }

        if (!conversation) {
          logger.warn(
            `[ConversationTimers] Conversation ${timer.conversationId} not found in agent or model collections. Expiring timer.`,
          );
          await timerCollection.updateOne(
            { id: timer.id },
            { $set: { status: TIMER_STATUSES.EXPIRED, updatedAt: nowTimestamp } },
          );
          continue;
        }

        // Cooperative Deferral (Self-Healing Concurrency)
        // If the conversation is currently generating a response, skip execution on this second
        if (conversation.isGenerating === true) {
          logger.debug(
            `[ConversationTimers] Conversation ${timer.conversationId} is currently generating. Deferring timer ${timer.id}.`,
          );
          continue;
        }

        logger.info(
          `[ConversationTimers] Firing due timer ${timer.id} for conversation ${timer.conversationId} in collection ${collection}.`,
        );

        // Compute current minute key (to avoid cron double-fires in the same minute)
        const currentMinuteKey = `${currentTimestamp.getFullYear()}-${String(currentTimestamp.getMonth() + 1).padStart(2, "0")}-${String(currentTimestamp.getDate()).padStart(2, "0")}T${String(currentTimestamp.getHours()).padStart(2, "0")}:${String(currentTimestamp.getMinutes()).padStart(2, "0")}`;

        if (timer.mode === TIMER_MODES.RECURRING && timer.cronExpression) {
          // Check if date matches cron
          const isCronDue = matchCron(timer.cronExpression, currentTimestamp);
          const hasAlreadyRunThisMinute =
            timer.lastFiredMinuteKey === currentMinuteKey;

          if (!isCronDue || hasAlreadyRunThisMinute) {
            // If it's not due for cron matching, or already run this minute, update firesAt to next minute boundary
            const nextMinute = new Date(currentTimestamp.getTime() + ONE_MINUTE_IN_MILLISECONDS);
            nextMinute.setSeconds(0, 0);
            await timerCollection.updateOne(
              { id: timer.id },
              {
                $set: {
                  firesAt: nextMinute.toISOString(),
                  updatedAt: nowTimestamp,
                },
              },
            );
            continue;
          }
        }

        // 1. Atomically claim this timer to prevent duplicate fires from overlapping ticks.
        // findOneAndUpdate ensures only one tick can transition the timer's state.
        const newIterationCount = timer.iterationCount + 1;
        const isRecurringExpired =
          timer.mode === TIMER_MODES.RECURRING &&
          timer.maxIterations !== undefined &&
          newIterationCount >= timer.maxIterations;

        const timerUpdates: Partial<ConversationTimer> = {
          iterationCount: newIterationCount,
          updatedAt: nowTimestamp,
        };

        if (timer.mode === TIMER_MODES.ONE_SHOT) {
          timerUpdates.status = TIMER_STATUSES.FIRED;
        } else if (isRecurringExpired) {
          timerUpdates.status = TIMER_STATUSES.EXPIRED;
        } else {
          // Setup next fire time for cron timer
          const nextMinute = new Date(currentTimestamp.getTime() + ONE_MINUTE_IN_MILLISECONDS);
          nextMinute.setSeconds(0, 0);
          timerUpdates.firesAt = nextMinute.toISOString();
          timerUpdates.lastFiredMinuteKey = currentMinuteKey;
        }

        // Atomic claim: only proceed if the timer is still in the expected state.
        // This prevents a second tick (or cluster node) from firing the same timer.
        const claimedTimer = await timerCollection.findOneAndUpdate(
          {
            id: timer.id,
            status: TIMER_STATUSES.ACTIVE,
            iterationCount: timer.iterationCount,
          },
          { $set: timerUpdates },
        );

        if (!claimedTimer) {
          logger.debug(
            `[ConversationTimers] Timer ${timer.id} was already claimed by another tick. Skipping.`,
          );
          continue;
        }

        // Redundant wake-up prevention (Antigravity-aligned):
        // When any timer fires, cancel all OTHER active one-shot timers for
        // the same conversation — they're now redundant since this conversation
        // is being woken up. Recurring crons are never auto-cancelled.
        await timerCollection.updateMany(
          {
            conversationId: timer.conversationId,
            project: timer.project,
            username: timer.username,
            status: TIMER_STATUSES.ACTIVE,
            mode: TIMER_MODES.ONE_SHOT,
            id: { $ne: timer.id },
          },
          { $set: { status: TIMER_STATUSES.CANCELLED, updatedAt: nowTimestamp } },
        );

        // 2. Append timer fired message to the conversation
        const reminderTimestamp = nowTimestamp;
        const reminderMessage: ConversationMessage = {
          role: "user",
          content: `🔔 Notification: ${timer.prompt}`,
          timestamp: reminderTimestamp,
          _alreadyPersisted: true,
          _notificationSource: NOTIFICATION_SOURCES.TIMER,
          _notificationId: `timer:${timer.id}:${reminderTimestamp}`,
        };

        await ConversationService.appendMessages(
          timer.conversationId,
          timer.project,
          timer.username,
          [reminderMessage],
          null,
          { collection },
        );

        // 3. Trigger AgenticLoopService in the background
        this.executeAgenticLoop(
          timer,
          conversation,
          reminderMessage,
          collection,
        ).catch((error: Error) => {
          logger.error(
            `[ConversationTimers] Background loop failed for timer ${timer.id}: ${getErrorMessage(error)}`,
          );
        });
      } catch (error: unknown) {
        logger.error(
          `[ConversationTimers] Error processing due timer ${timer.id}: ${getErrorMessage(error)}`,
        );
      }
    }
  },

  /**
   * Reconstruct generation context and invoke AgenticLoopService in the background.
   */
  async executeAgenticLoop(
    timer: ConversationTimer,
    conversation: TimerConversationContext,
    reminderMessage: ConversationMessage,
    collection: string = COLLECTIONS.AGENT_CONVERSATIONS,
  ): Promise<void> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    logger.info(
      `[ConversationTimers] Spawning background agent loop for session: ${timer.conversationId}`,
    );

    // Reload the conversation from DB (source of truth) to get the freshest
    // message array, including the just-appended reminder message.
    // If not found in DB (e.g. in unit tests), fallback to the passed-in conversation.
    const conversationsCollection = database.collection<TransformedConversation>(collection);
    const databaseConversation = await conversationsCollection.findOne({
      id: timer.conversationId,
      project: timer.project,
      username: timer.username,
    });

    const updatedConversation = databaseConversation || conversation;

    if (!updatedConversation) {
      logger.warn(
        `[ConversationTimers] Conversation ${timer.conversationId} disappeared after appending reminder message`,
      );
      return;
    }

    // Reconstruct transient _alreadyPersisted flag: every message loaded
    // from MongoDB is by definition already persisted. Without this, the
    // Finalizer re-persists the reminder message (it's the last message
    // in the array, so AgenticLoopService's [0..n-2] marking skips it).
    let freshMessages: ConversationMessage[];
    if (databaseConversation) {
      freshMessages = (databaseConversation.messages || []) as ConversationMessage[];
    } else {
      freshMessages = [
        ...((conversation.messages as ConversationMessage[]) || []),
        reminderMessage,
      ];
    }

    for (const message of freshMessages) {
      message._alreadyPersisted = true;
    }

    const settings = (updatedConversation.settings || {}) as TimerConversationSettings;
    const providerName = settings.provider || "";
    const resolvedModel = settings.model || "";
    const agent = settings.agent || null;
    const workspaceRoot = settings.workspaceRoot || null;

    if (!providerName || !resolvedModel) {
      throw new Error(
        `Invalid model/provider settings on conversation: ${timer.conversationId}`,
      );
    }

    const provider = getProvider(providerName);
    const modelDefinition = getModelByName(resolvedModel);

    if (!provider) {
      throw new Error(`LLM provider ${providerName} is unavailable`);
    }

    const traceId =
      (updatedConversation.traceId as string | undefined) || crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // The last user message in the array is the reminder (just appended)
    const userMessage = freshMessages
      .filter((message) => message.role === "user")
      .pop() || reminderMessage;

    // Standard logging emitter for background execution
    const mockEmit = (event: SseEvent) => {
      logger.debug(
        `[ConversationTimers][BackgroundAgent][${timer.conversationId}][Event] type=${event.type}`,
      );
    };

    // Ensure the conversation is marked as generating
    await ConversationService.setGenerating(
      timer.conversationId,
      timer.project,
      timer.username,
      true,
      { collection, agent: agent || undefined },
    );

    const toolConfiguration = settings.toolConfig;

    try {
      await AgenticLoopService.runAgenticLoop({
        provider: provider as LLMProvider,
        providerName,
        resolvedModel,
        modelDefinition,
        messages: freshMessages,
        originalMessages: freshMessages,
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          autoApprove: true,
          minContextLength: MINIMUM_CONTEXT_LENGTH,
          ...(toolConfiguration?.disabledTools && {
            disabledTools: toolConfiguration.disabledTools,
          }),
        },
        agentConversationId: crypto.randomUUID(),
        conversationId: timer.conversationId,
        userMessage: userMessage as ConversationMessage | null,
        conversationMeta: {
          title: (updatedConversation.title as string) || "Background Agent",
          settings,
        },
        traceId,
        project: timer.project,
        username: timer.username,
        clientIp: "127.0.0.1",
        agent,
        workspaceRoot,
        requestId,
        requestStart: performance.now(),
        emit: mockEmit,
      });

      logger.success(
        `[ConversationTimers] Background loop completed successfully for conversation ${timer.conversationId}`,
      );
    } catch (error: unknown) {
      logger.error(
        `[ConversationTimers] Background loop error on conversation ${timer.conversationId}: ${getErrorMessage(error)}`,
      );
      throw error;
    } finally {
      // Always clear isGenerating — both success and error paths.
      // Without this, the conversation document stays permanently stuck
      // with isGenerating: true after a successful timer execution.
      await ConversationService.setGenerating(
        timer.conversationId,
        timer.project,
        timer.username,
        false,
        { collection },
      ).catch(() => {});
    }
  },
};

// Hook cleanup registration on module load
registerCleanup(async () => {
  ConversationTimerService.destroy();
});

export default ConversationTimerService;
