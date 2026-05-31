import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import ConversationService from "./ConversationService.ts";
import { getProvider } from "../providers/index.ts";
import { getModelByName } from "../config.ts";
import { matchCron } from "./ScheduledTaskService.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";

import type { SseEvent } from "../types/SseTypes.ts";

export interface ConversationTimer {
  id: string;
  conversationId: string;
  project: string;
  username: string;
  prompt: string;
  mode: "one_shot" | "recurring";
  durationSeconds?: number;
  cronExpression?: string;
  maxIterations?: number;
  iterationCount: number;
  firesAt: string; // ISO timestamp for one-shot next fire time
  lastFiredMinuteKey?: string; // "YYYY-MM-DDTHH:mm" for preventing cron double-fires
  status: "active" | "fired" | "cancelled" | "expired";
  createdAt: string;
  updatedAt: string;
}

let tickerInterval: ReturnType<typeof setInterval> | null = null;

const ConversationTimerService = {
  /**
   * Initialize the timer daemon. Checks for due timers every 1 second.
   */
  async init(): Promise<void> {
    if (tickerInterval) {
      clearInterval(tickerInterval);
    }

    logger.info("[ConversationTimers] Starting background timer daemon (1s interval)...");

    tickerInterval = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.error(`[ConversationTimers] Daemon tick error: ${(error as Error).message}`);
      });
    }, 1000);

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

    const now = new Date();
    const mode = data.cronExpression ? "recurring" : "one_shot";
    const timestamp = now.toISOString();

    // Input validation
    let firesAt = timestamp;
    if (mode === "one_shot") {
      const seconds = data.durationSeconds ?? 0;
      if (seconds <= 0 || seconds > 86400) {
        throw new Error("One-shot duration must be between 1 and 86400 seconds (24 hours).");
      }
      firesAt = new Date(now.getTime() + seconds * 1000).toISOString();
    } else {
      // For recurring timers, check cron pattern syntax
      if (!data.cronExpression || data.cronExpression.trim().split(/\s+/).length !== 5) {
        throw new Error("A valid 5-field cron expression is required for recurring reminders.");
      }
      // Calculate first fire time as next minute boundary
      const nextMinute = new Date(now.getTime() + 60 * 1000);
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
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await database.collection(COLLECTIONS.CONVERSATION_TIMERS).insertOne(timer as any);
    logger.info(`[ConversationTimers] Scheduled ${mode} timer ${timer.id} for conversation ${timer.conversationId}`);

    return timer;
  },

  /**
   * Cancel an active timer by changing its status to "cancelled".
   */
  async cancelTimer(timerId: string, project: string, username: string): Promise<boolean> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) {
      throw new Error("Database connection unavailable");
    }

    const result = await database.collection(COLLECTIONS.CONVERSATION_TIMERS).updateOne(
      { id: timerId, project, username, status: "active" },
      { $set: { status: "cancelled", updatedAt: new Date().toISOString() } }
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
  async listActiveTimers(conversationId: string, project: string, username: string): Promise<ConversationTimer[]> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return [];

    return (await database
      .collection(COLLECTIONS.CONVERSATION_TIMERS)
      .find({ conversationId, project, username, status: "active" })
      .sort({ createdAt: 1 })
      .toArray()) as unknown as ConversationTimer[];
  },

  /**
   * Daemon tick: scans MongoDB for due timers, deferring execution if
   * conversation isGenerating state is true, and fires those that are due.
   */
  async tick(): Promise<void> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    const now = new Date();
    const nowTimestamp = now.toISOString();

    // Query active timers whose firesAt time is due
    const dueTimers = (await database
      .collection(COLLECTIONS.CONVERSATION_TIMERS)
      .find({ status: "active", firesAt: { $lte: nowTimestamp } })
      .toArray()) as unknown as ConversationTimer[];

    if (dueTimers.length === 0) return;

    for (const timer of dueTimers) {
      try {
        // Fetch target conversation to check its current status.
        // Check agent_conversations first, then fallback to model_conversations.
        let collection = COLLECTIONS.AGENT_CONVERSATIONS;
        let conversation = await database.collection(collection).findOne({
          id: timer.conversationId,
          project: timer.project,
          username: timer.username,
        });

        if (!conversation) {
          collection = COLLECTIONS.MODEL_CONVERSATIONS;
          conversation = await database.collection(collection).findOne({
            id: timer.conversationId,
            project: timer.project,
            username: timer.username,
          });
        }

        if (!conversation) {
          logger.warn(`[ConversationTimers] Conversation ${timer.conversationId} not found in agent or model collections. Expiring timer.`);
          await database.collection(COLLECTIONS.CONVERSATION_TIMERS).updateOne(
            { id: timer.id },
            { $set: { status: "expired", updatedAt: nowTimestamp } }
          );
          continue;
        }

        // Cooperative Deferral (Self-Healing Concurrency)
        // If the conversation is currently generating a response, skip execution on this second
        if (conversation.isGenerating === true) {
          logger.debug(`[ConversationTimers] Conversation ${timer.conversationId} is currently generating. Deferring timer ${timer.id}.`);
          continue;
        }

        logger.info(`[ConversationTimers] Firing due timer ${timer.id} for conversation ${timer.conversationId} in collection ${collection}.`);

        // Compute current minute key (to avoid cron double-fires in the same minute)
        const currentMinuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        if (timer.mode === "recurring" && timer.cronExpression) {
          // Check if date matches cron
          const isCronDue = matchCron(timer.cronExpression, now);
          const hasAlreadyRunThisMinute = timer.lastFiredMinuteKey === currentMinuteKey;

          if (!isCronDue || hasAlreadyRunThisMinute) {
            // If it's not due for cron matching, or already run this minute, update firesAt to next minute boundary
            const nextMinute = new Date(now.getTime() + 60 * 1000);
            nextMinute.setSeconds(0, 0);
            await database.collection(COLLECTIONS.CONVERSATION_TIMERS).updateOne(
              { id: timer.id },
              { $set: { firesAt: nextMinute.toISOString(), updatedAt: nowTimestamp } }
            );
            continue;
          }
        }

        // 1. Mark timer as executed/updated in database
        const newIterationCount = timer.iterationCount + 1;
        const isRecurringExpired =
          timer.mode === "recurring" &&
          timer.maxIterations !== undefined &&
          newIterationCount >= timer.maxIterations;

        const updates: Record<string, any> = {
          iterationCount: newIterationCount,
          updatedAt: nowTimestamp,
        };

        if (timer.mode === "one_shot") {
          updates.status = "fired";
        } else if (isRecurringExpired) {
          updates.status = "expired";
        } else {
          // Setup next fire time for cron timer
          const nextMinute = new Date(now.getTime() + 60 * 1000);
          nextMinute.setSeconds(0, 0);
          updates.firesAt = nextMinute.toISOString();
          updates.lastFiredMinuteKey = currentMinuteKey;
        }

        await database.collection(COLLECTIONS.CONVERSATION_TIMERS).updateOne(
          { id: timer.id },
          { $set: updates }
        );

        // 2. Append timer fired message to the conversation
        const reminderMessage = {
          role: "user",
          content: `🔔 Notification: ${timer.prompt}`,
          timestamp: nowTimestamp,
        };

        await ConversationService.appendMessages(
          timer.conversationId,
          timer.project,
          timer.username,
          [reminderMessage],
          null,
          { collection }
        );

        // 3. Trigger AgenticLoopService in the background
        this.executeAgenticLoop(timer, conversation, reminderMessage, collection).catch((error: unknown) => {
          logger.error(`[ConversationTimers] Background loop failed for timer ${timer.id}: ${(error as Error).message}`);
        });

      } catch (error: unknown) {
        logger.error(`[ConversationTimers] Error processing due timer ${timer.id}: ${(error as Error).message}`);
      }
    }
  },

  /**
   * Reconstruct generation context and invoke AgenticLoopService in the background.
   */
  async executeAgenticLoop(
    timer: ConversationTimer,
    conversation: Record<string, any>,
    reminderMessage: any,
    collection: string = COLLECTIONS.AGENT_CONVERSATIONS
  ): Promise<void> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    logger.info(`[ConversationTimers] Spawning background agent loop for session: ${timer.conversationId}`);

    const settings = conversation.settings || {};
    const providerName = settings.provider;
    const resolvedModel = settings.model;
    const agent = settings.agent || null;
    const workspaceRoot = settings.workspaceRoot || null;

    if (!providerName || !resolvedModel) {
      throw new Error(`Invalid model/provider settings on conversation: ${timer.conversationId}`);
    }

    const provider = getProvider(providerName);
    const modelDef = getModelByName(resolvedModel);

    if (!provider) {
      throw new Error(`LLM provider ${providerName} is unavailable`);
    }

    const traceId = conversation.traceId || crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // Reconstruct the message list for the agentic harness
    const contextMessages = [
      ...(conversation.messages || []),
      reminderMessage,
    ] as any[];

    // Standard logging emitter for background execution
    const mockEmit = (event: SseEvent) => {
      logger.debug(`[ConversationTimers][BackgroundAgent][${timer.conversationId}][Event] type=${event.type}`);
    };

    // Ensure the conversation is marked as generating
    await ConversationService.setGenerating(
      timer.conversationId,
      timer.project,
      timer.username,
      true,
      { collection, agent }
    );

    try {
      await AgenticLoopService.runAgenticLoop({
        provider: provider as any as import("./harnesses/types.ts").LLMProvider,
        providerName,
        resolvedModel,
        modelDef,
        messages: contextMessages,
        originalMessages: contextMessages,
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          minContextLength: 65_000,
        },
        agentSessionId: timer.conversationId,
        userMessage: reminderMessage,
        conversationMeta: conversation.title ? { title: conversation.title } : null,
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

      logger.success(`[ConversationTimers] Background loop completed successfully for conversation ${timer.conversationId}`);
    } catch (error: unknown) {
      logger.error(`[ConversationTimers] Background loop error on conversation ${timer.conversationId}: ${(error as Error).message}`);
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
        { collection }
      ).catch(() => {});
    }
  },
};

// Hook cleanup registration on module load
registerCleanup(async () => {
  ConversationTimerService.destroy();
});

export default ConversationTimerService;
