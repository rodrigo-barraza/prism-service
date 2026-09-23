import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, NOTIFICATION_SOURCES } from "#src/constants";
import AgenticLoopService from "./AgenticLoopService.ts";
import ConversationService from "./ConversationService.ts";
import ConversationGoalService, {
  GOAL_STATUSES,
} from "./ConversationGoalService.ts";
import { stripPrunedMessages } from "./conversation/checkpoints.ts";
import type {
  ConversationSettings,
  TransformedConversation,
} from "./conversation/types.ts";
import { getProvider } from "#src/providers/index";
import { getModelByName } from "#src/config";
import logger from "#src/utils/logger";
import { type SseEvent } from "#src/types/SseTypes";
import { type ConversationMessage } from "./harnesses/types.ts";
import {
  type RecurrenceRule,
  matchRecurrenceRule,
} from "#src/utils/RecurrenceMatcher";
import {
  DEFAULT_PROFILE_ID,
  profileFilter,
  type ProfileIdFilter,
} from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  externalInputMessageFields,
  externalOrigin,
  type ExternalOrigin,
} from "./external/ExternalInput.ts";
import {
  declarationOfScope,
  narrowScope,
  scopeFromDeclaration,
  type CapabilityDeclaration,
  type CapabilityScope,
} from "./permissions/CapabilityScope.ts";

export interface TransformedScheduledTaskFilter {
  id?: string;
  name?: string;
  project?: string;
  username?: string;
  profileId?: ProfileIdFilter;
}

export interface ScheduledTask {
  id: string;
  name: string;
  project: string;
  username?: string;
  /** Owning profile. Absent on documents that predate profiles (= default). */
  profileId?: string;
  prompt: string;
  agent: string | null;
  provider: string;
  model: string;
  scheduleType:
    | "hourly"
    | "daily"
    | "weekly"
    | "cron"
    | "trigger"
    | "once"
    | "custom";
  scheduleTime?: string; // "HH:MM" e.g. "09:00"
  scheduleDay?: number; // 0-6 (Sunday to Saturday)
  scheduleDate?: string; // "YYYY-MM-DD" e.g. "2026-05-25"
  cronExpression?: string; // e.g. "0 9 * * *"
  recurrenceRule?: RecurrenceRule;
  toolConfig?: {
    disabledTools?: string[];
    enabledTools?: string[];
  };
  /**
   * The permission mode runs of this task use. Absent = the target
   * conversation's mode, else `dontAsk`. Runs are unattended either way:
   * anything that would ask is denied. `bypass` holds only for an owner.
   */
  permissionMode?: import("./permissions/PermissionModes.ts").PermissionMode;
  /**
   * Capabilities its runs go without — `{ network: false }` — fixed when it
   * is scheduled (permissions/CapabilityScope). A task created from inside
   * a narrowed run keeps that run's narrowing too (ScheduledTasksRoutes).
   */
  capabilities?: CapabilityDeclaration | null;
  enabled: boolean;
  lastRunMinute?: string; // "YYYY-MM-DDTHH:mm"
  /**
   * Target agent conversation. When set, every run continues THIS
   * conversation (prompt appended as a scheduler notification, loop resumed
   * with the conversation's own settings) instead of opening a new one.
   */
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Settings a conversation document carries for resuming its loop. */
interface ScheduledConversationSettings extends ConversationSettings {
  provider?: string;
  model?: string;
  agent?: string | null;
  workspaceRoot?: string | null;
  toolConfig?: ScheduledTask["toolConfig"];
}

/**
 * A trigger's payload, as the run reads it: external input from the webhook
 * that fired it — its own message beside the task's prompt, never folded
 * into the user's words (external/ExternalInput).
 */
export function triggerPayloadMessage(
  payload: Record<string, unknown> | undefined,
  origin: ExternalOrigin | null | undefined,
  timestamp: string,
): ConversationMessage | null {
  if (!payload || Object.keys(payload).length === 0) return null;
  let text: string;
  try {
    text = `Trigger payload:\n${JSON.stringify(payload, null, 2)}`;
  } catch {
    text = `Trigger payload: ${String(payload)}`;
  }
  return {
    role: "user",
    ...externalInputMessageFields(origin ?? externalOrigin("webhook", "trigger"), text),
    timestamp,
    _alreadyPersisted: true,
  } as ConversationMessage;
}

export interface ScheduledTaskRunResult {
  agentConversationId: string;
  /** Set when a continuation run did not start (paused goal, duplicate, busy). */
  skipped?: string;
}

/** "YYYY-MM-DDTHH:mm" in local time — the scheduler's per-minute identity. */
export function minuteKeyFor(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ─── Zero-Dependency Cron Matcher (5-field, crontab(5) semantics) ─────────────

interface CronFieldBounds {
  min: number;
  max: number;
  /** Three-letter names the field accepts (case-insensitive). */
  names?: ReadonlyMap<string, number>;
}

const CRON_MONTH_NAMES: ReadonlyMap<string, number> = new Map(
  "jan feb mar apr may jun jul aug sep oct nov dec"
    .split(" ")
    .map((name, index) => [name, index + 1]),
);

const CRON_WEEKDAY_NAMES: ReadonlyMap<string, number> = new Map(
  "sun mon tue wed thu fri sat".split(" ").map((name, index) => [name, index]),
);

/** minute, hour, day of month, month, day of week (0 and 7 are Sunday). */
const CRON_FIELD_BOUNDS: readonly CronFieldBounds[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: CRON_MONTH_NAMES },
  { min: 0, max: 7, names: CRON_WEEKDAY_NAMES },
];

const CRON_NUMBER = /^\d+$/;

function parseCronValue(token: string, bounds: CronFieldBounds): number | null {
  const named = bounds.names?.get(token.toLowerCase());
  if (named !== undefined) return named;
  if (!CRON_NUMBER.test(token)) return null;
  const value = Number(token);
  return value >= bounds.min && value <= bounds.max ? value : null;
}

/**
 * Expands one field (`*`, `a`, `a-b`, any of those `/n`, comma lists) into the
 * values it allows, or null when it is malformed. A step counts from the start
 * of its range, and `*` starts at the field's minimum: every 2nd day of the
 * month is 1, 3, 5, …, not 2, 4, 6. `a/n` runs from `a` to the field's end.
 */
function expandCronField(
  field: string,
  bounds: CronFieldBounds,
): Set<number> | null {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const [range, stepToken, ...extraSteps] = item.split("/");
    if (extraSteps.length > 0) return null;

    let step = 1;
    if (stepToken !== undefined) {
      if (!CRON_NUMBER.test(stepToken)) return null;
      step = Number(stepToken);
      if (step === 0) return null;
    }

    let start: number;
    let end: number;
    if (range === "*") {
      start = bounds.min;
      end = bounds.max;
    } else {
      const [startToken, endToken, ...extraBounds] = range.split("-");
      if (extraBounds.length > 0) return null;
      const parsedStart = parseCronValue(startToken, bounds);
      if (parsedStart === null) return null;
      start = parsedStart;
      if (endToken !== undefined) {
        const parsedEnd = parseCronValue(endToken, bounds);
        if (parsedEnd === null || parsedEnd < start) return null;
        end = parsedEnd;
      } else {
        end = stepToken !== undefined ? bounds.max : start;
      }
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/**
 * Whether `date`'s minute matches a 5-field cron expression, read in the
 * process's local time (tasks carry no timezone; the container sets `TZ`).
 * Malformed expressions never match.
 *
 * Day of month and day of week follow crontab(5): when both are restricted
 * (neither starts with `*`) a day matching EITHER one runs; otherwise both
 * must match, which leaves the restricted one in charge.
 */
export function matchCron(
  expression: string,
  date: Date = new Date(),
): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_BOUNDS.length) return false;

  const allowed: Set<number>[] = [];
  for (const [index, field] of fields.entries()) {
    const values = expandCronField(field, CRON_FIELD_BOUNDS[index]);
    if (!values) return false;
    allowed.push(values);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = allowed;
  if (daysOfWeek.has(7)) daysOfWeek.add(0);

  const dayOfMonthMatches = daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = daysOfWeek.has(date.getDay());
  const bothDaysRestricted =
    !fields[2].startsWith("*") && !fields[4].startsWith("*");
  const dayMatches = bothDaysRestricted
    ? dayOfMonthMatches || dayOfWeekMatches
    : dayOfMonthMatches && dayOfWeekMatches;

  return (
    dayMatches &&
    minutes.has(date.getMinutes()) &&
    hours.has(date.getHours()) &&
    months.has(date.getMonth() + 1)
  );
}

// ─── Scheduler Daemon & CRUD Logic ─────────────────────────────────────────────

let tickingInterval: ReturnType<typeof setInterval> | null = null;

const ScheduledTaskService = {
  /**
   * Initializes the scheduler. Runs a tick loop every 60 seconds.
   */
  async init(): Promise<void> {
    if (tickingInterval) {
      clearInterval(tickingInterval);
    }

    logger.info("[ScheduledTasks] Initializing Background Scheduler Daemon…");

    // Align tick to the next local minute boundary for timing precision
    const secondsToNextMinute = 60 - new Date().getSeconds();
    setTimeout(() => {
      this.tick().catch((error: Error) =>
        logger.error(
          `[ScheduledTasks] Initial tick error: ${getErrorMessage(error)}`,
        ),
      );

      tickingInterval = setInterval(() => {
        this.tick().catch((error: Error) =>
          logger.error(
            `[ScheduledTasks] Tick error: ${getErrorMessage(error)}`,
          ),
        );
      }, 60000);
    }, secondsToNextMinute * 1000);

    logger.success(
      "[ScheduledTasks] Background Scheduler Daemon started successfully.",
    );
  },

  /**
   * Clears the scheduler tick loop.
   */
  destroy(): void {
    if (tickingInterval) {
      clearInterval(tickingInterval);
      tickingInterval = null;
      logger.info("[ScheduledTasks] Background Scheduler Daemon stopped.");
    }
  },

  /**
   * Core tick logic: scans MongoDB for enabled tasks and triggers any that are due.
   */
  async tick(): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;

    const now = new Date();
    const currentMin = now.getMinutes();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday

    const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(currentHour).padStart(2, "0")}:${String(currentMin).padStart(2, "0")}`;

    // Fetch enabled tasks that have not run yet in this exact minute
    const tasks = (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find({ enabled: true, lastRunMinute: { $ne: minuteKey } })
      .toArray()) as unknown as ScheduledTask[];

    if (tasks.length === 0) return;

    for (const task of tasks) {
      let isDue = false;

      try {
        if (task.scheduleType === "cron" && task.cronExpression) {
          isDue = matchCron(task.cronExpression, now);
        } else if (task.scheduleType === "hourly") {
          // Default to run at minute 0 of every hour
          isDue = currentMin === 0;
        } else if (task.scheduleType === "daily" && task.scheduleTime) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          isDue = currentHour === sh && currentMin === sm;
        } else if (
          task.scheduleType === "weekly" &&
          task.scheduleTime &&
          task.scheduleDay != null
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          isDue =
            currentDay === task.scheduleDay &&
            currentHour === sh &&
            currentMin === sm;
        } else if (
          task.scheduleType === "once" &&
          task.scheduleTime &&
          task.scheduleDate
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          const [yr, mn, dy] = task.scheduleDate.split("-").map(Number);
          isDue =
            now.getFullYear() === yr &&
            now.getMonth() + 1 === mn &&
            now.getDate() === dy &&
            currentHour === sh &&
            currentMin === sm;
        } else if (
          task.scheduleType === "custom" &&
          task.recurrenceRule &&
          task.scheduleTime
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          const isTimeMatch = currentHour === sh && currentMin === sm;
          if (isTimeMatch) {
            const startDate = task.recurrenceRule.startDate
              ? new Date(task.recurrenceRule.startDate)
              : new Date(task.createdAt);
            isDue = matchRecurrenceRule(task.recurrenceRule, startDate, now);
          }
        }

        if (isDue) {
          logger.info(
            `[ScheduledTasks] Task "${task.name}" (${task.id}) is due to run.`,
          );

          const updateFields: Record<string, unknown> = {
            lastRunMinute: minuteKey,
            updatedAt: new Date().toISOString(),
          };
          if (task.scheduleType === "once") {
            updateFields.enabled = false;
          }

          // Atomically claim this task for this minute — prevents double execution
          // in multi-instance cluster setups. Only the first instance to update
          // will get a non-null result; subsequent instances skip.
          const claimResult = await db
            .collection(COLLECTIONS.SCHEDULED_TASKS)
            .findOneAndUpdate(
              { id: task.id, lastRunMinute: { $ne: minuteKey } },
              { $set: updateFields },
            );

          if (!claimResult) {
            logger.info(
              `[ScheduledTasks] Task "${task.name}" already claimed by another instance.`,
            );
            continue;
          }

          // Trigger execution in the background asynchronously.
          // The daemon has no request context — re-hydrate the profile from
          // the task document, mirroring the username fallback.
          this.executeTask(task, undefined, {
            username: task.username || "system",
            profileId: task.profileId || DEFAULT_PROFILE_ID,
          }).catch((error: Error) =>
            logger.error(
              `[ScheduledTasks] Execution failed for task "${task.name}": ${getErrorMessage(error)}`,
            ),
          );
        }
      } catch (error: unknown) {
        logger.error(
          `[ScheduledTasks] Failed to parse/check task "${task.name}": ${getErrorMessage(error)}`,
        );
      }
    }
  },

  /**
   * Programmatically executes a scheduled task in the background.
   * Decoupled completely from live WebSockets/browser clients.
   */
  async executeTask(
    task: ScheduledTask,
    payload?: Record<string, unknown>,
    {
      username = "system",
      profileId = getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
      agentConversationId,
      payloadOrigin,
    }: {
      username?: string;
      profileId?: string;
      agentConversationId?: string;
      /** Who fired the trigger that carried `payload` (a webhook, by default). */
      payloadOrigin?: ExternalOrigin | null;
    } = {},
  ): Promise<ScheduledTaskRunResult> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    if (task.conversationId) {
      return this.continueConversation(task, payload, { username, profileId, payloadOrigin });
    }

    const resolvedConversationId = agentConversationId || crypto.randomUUID();
    if (!task.agent) {
      throw new Error(
        `Scheduled task "${task.name}" is missing a required agent identifier`,
      );
    }
    const traceId = crypto.randomUUID();
    const nowISO = new Date().toISOString();

    logger.info(
      `[ScheduledTasks] Executing task "${task.name}" under Conversation ID: ${resolvedConversationId} (user: ${username})`,
    );

    // Determine default workspace root path if available
    let workspacePath: string | null = null;
    try {
      const workspaceDoc = await db.collection(COLLECTIONS.WORKSPACES).findOne({
        name: task.project,
      });
      if (workspaceDoc?.path) {
        workspacePath = workspaceDoc.path as string;
      }
    } catch {
      // Best-effort
    }

    // The task's prompt is the user's (written when it was scheduled); a
    // trigger's payload is the webhook's, and arrives as external input.
    const userTriggerMessage = {
      role: "user" as const,
      content: task.prompt,
      timestamp: nowISO,
      _alreadyPersisted: true,
    };
    const payloadMessage = triggerPayloadMessage(payload, payloadOrigin, nowISO);
    const runMessages = [
      userTriggerMessage as ConversationMessage,
      ...(payloadMessage ? [payloadMessage] : []),
    ];

    // 1. Create agent session stub document
    const settings = {
      provider: task.provider,
      model: task.model,
      agent: task.agent,
      workspaceRoot: workspacePath,
      toolConfig: task.toolConfig,
    };

    // 1. Create agent session stub document
    // Top-level `agent` is required for per-agent filtering in GET /conversations
    // (the user sidebar queries with ?agent=OMNI etc.). Without it, the
    // conversation only appears in the admin view which doesn't filter by agent.
    await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).insertOne({
      id: resolvedConversationId,
      project: task.project,
      username,
      profileId,
      title: task.name,
      agent: task.agent,
      taskId: task.id,
      messages: runMessages,
      systemPrompt: "",
      settings,
      modalities: { textIn: true, textOut: false },
      providers: [task.provider.toLowerCase()],
      totalCost: 0,
      isGenerating: true,
      isActive: true,
      createdAt: nowISO,
      updatedAt: nowISO,
    });

    const mockEmit = (event: SseEvent) => {
      logger.debug(`[ScheduledTasks][${task.name}][Event] type=${event.type}`);
    };

    // 2. Resolve provider and model definitions
    const provider = getProvider(task.provider);
    const modelDefinition = getModelByName(task.model);

    if (!provider) {
      throw new Error(`Provider not found: ${task.provider}`);
    }

    // 3. Trigger AgenticLoopService
    try {
      await AgenticLoopService.runAgenticLoop({
        provider:
          provider as unknown as import("./harnesses/types.ts").LLMProvider,
        providerName: task.provider,
        resolvedModel: task.model,
        modelDefinition,
        messages: runMessages,
        originalMessages: runMessages,
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          // Nobody watches a scheduled run: what would ask is denied, and
          // the mode is the task's own, else dontAsk.
          unattended: true,
          ...(task.permissionMode && { permissionMode: task.permissionMode }),
          // What its runs may do at all, fixed when it was scheduled.
          _capabilityScope: scopeFromDeclaration(task.capabilities),
          ...(task.toolConfig?.disabledTools && {
            disabledTools: task.toolConfig.disabledTools,
          }),
          ...(task.toolConfig?.enabledTools && {
            enabledTools: task.toolConfig.enabledTools,
          }),
        },
        agentConversationId: resolvedConversationId,
        conversationId: resolvedConversationId,
        userMessage: userTriggerMessage as ConversationMessage,
        conversationMeta: {
          title: task.name,
          agent: task.agent,
          workspaceRoot: workspacePath,
          settings,
        },
        traceId,
        project: task.project,
        username,
        profileId,
        clientIp: "127.0.0.1",
        agent: task.agent,
        workspaceRoot: workspacePath,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: mockEmit,
      });

      logger.success(
        `[ScheduledTasks] Task "${task.name}" completed execution successfully.`,
      );
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks] Agent loop error for task "${task.name}": ${getErrorMessage(error)}`,
      );

      // Ensure the generated session is not stuck as "generating"
      await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateOne(
          { id: resolvedConversationId },
          {
            $set: { isGenerating: false, isActive: false, updatedAt: new Date().toISOString() },
          },
        )
        .catch((cleanupError: Error) =>
          logger.warn(
            `[ScheduledTasks] Failed to reset isGenerating for conversation ${resolvedConversationId}: ${getErrorMessage(cleanupError)}`,
          ),
        );

      throw error;
    }

    return { agentConversationId: resolvedConversationId };
  },

  /**
   * Continue the task's target conversation instead of opening a new one:
   * the prompt lands as a scheduler notification (`_notificationSource:
   * scheduler`, `_notificationId: scheduler:<taskId>:<minuteKey>`) and the
   * agentic loop resumes on that conversation with its own settings/model —
   * the ConversationTimerService shape. Skips, with a log line, when the
   * conversation's goal is paused/completed/blocked, when this minute's
   * notification is already in the conversation, or while it is generating.
   */
  async continueConversation(
    task: ScheduledTask,
    payload?: Record<string, unknown>,
    {
      username = "system",
      profileId = getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
      payloadOrigin,
    }: { username?: string; profileId?: string; payloadOrigin?: ExternalOrigin | null } = {},
  ): Promise<ScheduledTaskRunResult> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");
    const conversationId = task.conversationId as string;
    const collection = COLLECTIONS.AGENT_CONVERSATIONS;

    const goal = await ConversationGoalService.get(
      conversationId,
      task.project,
      username,
    );
    if (goal && goal.status !== GOAL_STATUSES.ACTIVE) {
      logger.info(
        `[ScheduledTasks] Task "${task.name}" skipped — goal on conversation ${conversationId} is ${goal.status}${goal.blockedOn ? ` (${goal.blockedOn})` : ""}.`,
      );
      return { agentConversationId: conversationId, skipped: `goal ${goal.status}` };
    }

    const conversation = (await db
      .collection(collection)
      .findOne({ id: conversationId, project: task.project, username })) as
      | TransformedConversation
      | null;
    if (!conversation) {
      throw new Error(
        `Scheduled task "${task.name}" targets conversation ${conversationId}, which was not found`,
      );
    }

    const notificationId = `${NOTIFICATION_SOURCES.SCHEDULER}:${task.id}:${minuteKeyFor(new Date())}`;
    const alreadyDelivered = (conversation.messages || []).some(
      (message) =>
        (message as { _notificationId?: string })._notificationId ===
        notificationId,
    );
    if (alreadyDelivered) {
      logger.info(
        `[ScheduledTasks] Task "${task.name}" skipped — ${notificationId} already delivered to conversation ${conversationId}.`,
      );
      return { agentConversationId: conversationId, skipped: "duplicate" };
    }
    if (conversation.isGenerating === true) {
      logger.info(
        `[ScheduledTasks] Task "${task.name}" skipped — conversation ${conversationId} is generating.`,
      );
      return { agentConversationId: conversationId, skipped: "generating" };
    }

    const nowISO = new Date().toISOString();
    const triggerMessage: ConversationMessage = {
      role: "user",
      content: `🔔 Scheduled task "${task.name}": ${task.prompt}`,
      timestamp: nowISO,
      _alreadyPersisted: true,
      _notificationSource: NOTIFICATION_SOURCES.SCHEDULER,
      _notificationId: notificationId,
    };
    // A trigger's payload is the webhook's words: external input of its own.
    const payloadMessage = triggerPayloadMessage(payload, payloadOrigin, nowISO);

    logger.info(
      `[ScheduledTasks] Executing task "${task.name}" on existing conversation ${conversationId} (user: ${username})`,
    );

    await ConversationService.appendMessages(
      conversationId,
      task.project,
      username,
      [triggerMessage, ...(payloadMessage ? [payloadMessage] : [])],
      null,
      { collection },
    );

    // Reload — the appended notification and any rewind-pruned history are
    // only right on the document (same reasoning as the timer service).
    const reloaded = (await db
      .collection(collection)
      .findOne({ id: conversationId, project: task.project, username })) as
      | TransformedConversation
      | null;
    const source = reloaded || conversation;
    const freshMessages: ConversationMessage[] = reloaded
      ? stripPrunedMessages(
          (reloaded.messages || []) as unknown as ConversationMessage[],
        )
      : [
          ...((conversation.messages || []) as unknown as ConversationMessage[]),
          triggerMessage,
          ...(payloadMessage ? [payloadMessage] : []),
        ];
    for (const message of freshMessages) {
      message._alreadyPersisted = true;
    }

    const settings = {
      ...(source.settings || {}),
    } as ScheduledConversationSettings;
    const providerName = settings.provider || task.provider;
    const resolvedModel = settings.model || task.model;
    const agent = settings.agent || source.agent || task.agent;
    if (!agent) {
      throw new Error(
        `Scheduled task "${task.name}" is missing a required agent identifier`,
      );
    }
    const workspaceRoot = settings.workspaceRoot || source.workspaceRoot || null;
    const toolConfig = task.toolConfig || settings.toolConfig;

    const provider = getProvider(providerName);
    if (!provider) {
      throw new Error(`Provider not found: ${providerName}`);
    }
    const modelDefinition = getModelByName(resolvedModel);
    const traceId = (source.traceId as string | undefined) || crypto.randomUUID();

    const mockEmit = (event: SseEvent) => {
      logger.debug(`[ScheduledTasks][${task.name}][Event] type=${event.type}`);
    };

    await ConversationService.setGenerating(
      conversationId,
      task.project,
      username,
      true,
      { collection, agent },
    );

    try {
      await AgenticLoopService.runAgenticLoop({
        provider:
          provider as unknown as import("./harnesses/types.ts").LLMProvider,
        providerName,
        resolvedModel,
        modelDefinition,
        messages: freshMessages,
        originalMessages: freshMessages,
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          unattended: true,
          ...(task.permissionMode && { permissionMode: task.permissionMode }),
          _capabilityScope: scopeFromDeclaration(task.capabilities),
          ...(toolConfig?.disabledTools && {
            disabledTools: toolConfig.disabledTools,
          }),
          ...(toolConfig?.enabledTools && {
            enabledTools: toolConfig.enabledTools,
          }),
        },
        agentConversationId: conversationId,
        conversationId,
        userMessage: triggerMessage,
        conversationMeta: {
          title: (source.title as string) || task.name,
          agent,
          workspaceRoot,
          settings,
        },
        traceId,
        project: task.project,
        username,
        profileId,
        clientIp: "127.0.0.1",
        agent,
        workspaceRoot,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: mockEmit,
      });

      logger.success(
        `[ScheduledTasks] Task "${task.name}" completed on conversation ${conversationId}.`,
      );
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks] Agent loop error for task "${task.name}" on conversation ${conversationId}: ${getErrorMessage(error)}`,
      );
      throw error;
    } finally {
      await ConversationService.setGenerating(
        conversationId,
        task.project,
        username,
        false,
        { collection },
      ).catch(() => {});
    }

    return { agentConversationId: conversationId };
  },

  /**
   * Determine if a project name is a client UI project (vs a registered workspace
   * or agent project). Client projects skip project/username scoping in queries.
   */
  async _isClientProject(project: string): Promise<boolean> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!project || !db) return true;

    const workspaceExists = await db
      .collection(COLLECTIONS.WORKSPACES)
      .findOne({ name: project });
    if (workspaceExists) return false;

    const { default: AgentPersonaRegistry } =
      await import("./AgentPersonaRegistry.ts");
    const agentProjects = AgentPersonaRegistry.list()
      .map((entry) => {
        const persona = AgentPersonaRegistry.get(entry.id);
        return persona?.project;
      })
      .filter(Boolean);

    return !agentProjects.includes(project);
  },

  async _getQueryFilter(
    id: string,
    project: string,
    username: string,
    profileId: string = getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
  ): Promise<TransformedScheduledTaskFilter> {
    const isClientProject = await this._isClientProject(project);

    // Profile is an orthogonal dimension — applied even for client projects
    // that skip project/username scoping.
    const filter: TransformedScheduledTaskFilter = {
      id,
      profileId: profileFilter(profileId),
    };
    if (!isClientProject) {
      filter.project = project;
    }
    if (
      username &&
      username !== "any" &&
      username !== "all" &&
      !isClientProject
    ) {
      filter.username = username;
    }
    return filter;
  },

  async listTasks(
    project: string,
    username: string,
    profileId: string = getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
  ): Promise<ScheduledTask[]> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];

    const isClientProject = await this._isClientProject(project);

    const query: Record<string, unknown> = {
      profileId: profileFilter(profileId),
    };
    if (!isClientProject) {
      query.project = project;
    }
    if (
      username &&
      username !== "any" &&
      username !== "all" &&
      !isClientProject
    ) {
      query.username = username;
    }

    return (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ScheduledTask[];
  },

  async listAllTasks(): Promise<ScheduledTask[]> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];

    return (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find({})
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ScheduledTask[];
  },

  async createTask(
    data: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt"> & {
      username: string;
    },
  ): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const task: ScheduledTask = {
      ...data,
      // Always stamp the literal profile id — the daemon re-hydrates it at
      // execution time, exactly like username.
      profileId:
        data.profileId ?? getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
      id: crypto.randomUUID(),
      createdAt: nowISO,
      updatedAt: nowISO,
    };

    await db.collection(COLLECTIONS.SCHEDULED_TASKS).insertOne(task);
    return task;
  },

  /**
   * `callerScope`: the change comes from inside a narrowed run (its
   * `x-conversation-id` names one — ScheduledTasksRoutes). Such a change
   * can only add restrictions: the task keeps what it had, plus what the
   * change declares, plus the run's own — so editing a task's prompt from a
   * narrowed run cannot schedule the run's way out of its scope.
   */
  async updateTask(
    id: string,
    project: string,
    username: string,
    updates: Partial<ScheduledTask>,
    profileId?: string,
    { callerScope = null }: { callerScope?: CapabilityScope | null } = {},
  ): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const cleanUpdates: Record<string, unknown> = {
      ...updates,
      updatedAt: nowISO,
    };
    delete cleanUpdates.id;
    delete cleanUpdates.createdAt;
    // A task can never be moved between profiles via PATCH.
    delete cleanUpdates.profileId;

    const filter = await this._getQueryFilter(id, project, username, profileId);
    if (callerScope) {
      const stored = (await db.collection(COLLECTIONS.SCHEDULED_TASKS).findOne(filter)) as
        | ScheduledTask
        | null;
      cleanUpdates.capabilities = declarationOfScope(
        narrowScope(
          scopeFromDeclaration(stored?.capabilities),
          scopeFromDeclaration(updates.capabilities),
          callerScope,
        ),
      );
    }
    const result = await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .findOneAndUpdate(
        filter,
        { $set: cleanUpdates },
        { returnDocument: "after" },
      );

    if (!result) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    return result as unknown as ScheduledTask;
  },

  async deleteTask(
    id: string,
    project: string,
    username: string,
    profileId?: string,
  ): Promise<boolean> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username, profileId);
    let result = await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .deleteOne(filter);
    if ((result.deletedCount ?? 0) === 0) {
      const nameFilter = { ...filter };
      delete nameFilter.id;
      nameFilter.name = id;
      result = await db
        .collection(COLLECTIONS.SCHEDULED_TASKS)
        .deleteOne(nameFilter);
    }
    return (result.deletedCount ?? 0) > 0;
  },

  async triggerTask(
    id: string,
    project: string,
    username: string,
    payload?: Record<string, unknown>,
    profileId: string = getRequestContext().profileId ?? DEFAULT_PROFILE_ID,
    payloadOrigin: ExternalOrigin | null = null,
  ): Promise<{ success: boolean; agentConversationId: string }> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username, profileId);
    let task = (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .findOne(filter)) as unknown as ScheduledTask;
    if (!task) {
      // Fallback: look up by name
      const nameFilter = { ...filter };
      delete nameFilter.id;
      nameFilter.name = id;
      task = (await db
        .collection(COLLECTIONS.SCHEDULED_TASKS)
        .findOne(nameFilter)) as unknown as ScheduledTask;
    }
    if (!task) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    // A task bound to a conversation continues it; otherwise pre-generate
    // the id so the caller can follow the new conversation immediately.
    const agentConversationId = task.conversationId || crypto.randomUUID();

    // Fire-and-forget background execution with the pre-generated conversation ID
    this.executeTask({ ...task, id: task.id }, payload, {
      username,
      profileId,
      agentConversationId,
      payloadOrigin,
    }).catch((error: Error) => {
      logger.error(
        `[ScheduledTasks] Manual trigger failed for task "${task.name}": ${getErrorMessage(error)}`,
      );
    });

    return { success: true, agentConversationId };
  },
};

export default ScheduledTaskService;
