import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { getProvider } from "../providers/index.ts";
import { getModelByName } from "../config.ts";
import logger from "../utils/logger.ts";
import { SseEvent } from "../types/SseTypes.ts";
import { ConversationMessage } from "./harnesses/types.ts";
import { RecurrenceRule, matchRecurrenceRule } from "../utils/RecurrenceMatcher.ts";

export interface ScheduledTask {
  id: string;
  name: string;
  project: string;
  username?: string;
  prompt: string;
  agent: string | null;
  provider: string;
  model: string;
  scheduleType: "hourly" | "daily" | "weekly" | "cron" | "trigger" | "once" | "custom";
  scheduleTime?: string; // "HH:MM" e.g. "09:00"
  scheduleDay?: number; // 0-6 (Sunday to Saturday)
  scheduleDate?: string; // "YYYY-MM-DD" e.g. "2026-05-25"
  cronExpression?: string; // e.g. "0 9 * * *"
  recurrenceRule?: RecurrenceRule;
  enabled: boolean;
  lastRunMinute?: string; // "YYYY-MM-DDTHH:mm"
  createdAt: string;
  updatedAt: string;
}

// ─── Simple Zero-Dependency Cron Matcher ───────────────────────────────────────

function matchCronField(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  if (pattern.includes(",")) {
    return pattern.split(",").some((pattern) => matchCronField(pattern, value));
  }
  if (pattern.includes("/")) {
    const [range, stepStr] = pattern.split("/");
    const step = parseInt(stepStr, 10);
    if (isNaN(step)) return false;
    if (range === "*") {
      return value % step === 0;
    }
    const [startStr] = range.split("-");
    const start = parseInt(startStr, 10);
    return !isNaN(start) && value >= start && (value - start) % step === 0;
  }
  if (pattern.includes("-")) {
    const [startStr, endStr] = pattern.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return !isNaN(start) && !isNaN(end) && value >= start && value <= end;
  }
  return parseInt(pattern, 10) === value;
}

export function matchCron(expression: string, date: Date = new Date()): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;

  return (
    matchCronField(min, date.getMinutes()) &&
    matchCronField(hour, date.getHours()) &&
    matchCronField(dom, date.getDate()) &&
    matchCronField(month, date.getMonth() + 1) &&
    matchCronField(dow, date.getDay())
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
      this.tick().catch((err: unknown) =>
        logger.error(`[ScheduledTasks] Initial tick error: ${(err as Error).message}`),
      );

      tickingInterval = setInterval(() => {
        this.tick().catch((err: unknown) =>
          logger.error(`[ScheduledTasks] Tick error: ${(err as Error).message}`),
        );
      }, 60000);
    }, secondsToNextMinute * 1000);

    logger.success("[ScheduledTasks] Background Scheduler Daemon started successfully.");
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
        } else if (task.scheduleType === "weekly" && task.scheduleTime && task.scheduleDay != null) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          isDue = currentDay === task.scheduleDay && currentHour === sh && currentMin === sm;
        } else if (task.scheduleType === "once" && task.scheduleTime && task.scheduleDate) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          const [yr, mn, dy] = task.scheduleDate.split("-").map(Number);
          isDue = now.getFullYear() === yr &&
                  (now.getMonth() + 1) === mn &&
                  now.getDate() === dy &&
                  currentHour === sh &&
                  currentMin === sm;
        } else if (task.scheduleType === "custom" && task.recurrenceRule && task.scheduleTime) {
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
          logger.info(`[ScheduledTasks] Task "${task.name}" (${task.id}) is due to run.`);
          
          const updateFields: Record<string, any> = {
            lastRunMinute: minuteKey,
            updatedAt: new Date().toISOString()
          };
          if (task.scheduleType === "once") {
            updateFields.enabled = false;
          }

          // Mark as run for this minute key to prevent double execution in cluster setups
          await db.collection(COLLECTIONS.SCHEDULED_TASKS).updateOne(
            { id: task.id },
            { $set: updateFields }
          );

          // Trigger execution in the background asynchronously
          this.executeTask(task, undefined, { username: task.username || "system" }).catch((err: unknown) =>
            logger.error(`[ScheduledTasks] Execution failed for task "${task.name}": ${(err as Error).message}`),
          );
        }
      } catch (err: unknown) {
        logger.error(`[ScheduledTasks] Failed to parse/check task "${task.name}": ${(err as Error).message}`);
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
    { username = "system", agentSessionId }: { username?: string; agentSessionId?: string } = {},
  ): Promise<{ agentSessionId: string }> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const resolvedSessionId = agentSessionId || crypto.randomUUID();
    if (!task.agent) {
      throw new Error(`Scheduled task "${task.name}" is missing a required agent identifier`);
    }
    const traceId = crypto.randomUUID();
    const nowISO = new Date().toISOString();

    logger.info(`[ScheduledTasks] Executing task "${task.name}" under Session ID: ${resolvedSessionId} (user: ${username})`);

    // Determine default workspace root path if available
    let workspacePath: string | null = null;
    try {
      const workspaceDoc = await db.collection(COLLECTIONS.WORKSPACES).findOne({
        name: task.project
      });
      if (workspaceDoc?.path) {
        workspacePath = workspaceDoc.path as string;
      }
    } catch {
      // Best-effort
    }

    // Build the final prompt with optional payload context
    let finalPrompt = task.prompt;
    if (payload && Object.keys(payload).length > 0) {
      finalPrompt += `\n\nTrigger payload: ${JSON.stringify(payload)}`;
    }

    const userTriggerMessage = {
      role: "user" as const,
      content: finalPrompt,
      timestamp: nowISO,
      _alreadyPersisted: true,
    };

    // 1. Create agent session stub document
    const settings = {
      provider: task.provider,
      model: task.model,
      agent: task.agent,
      workspaceRoot: workspacePath,
      toolConfig: (task as any).toolConfig,
    };

    // 1. Create agent session stub document
    // Top-level `agent` is required for per-agent filtering in GET /conversations
    // (the user sidebar queries with ?agent=OMNI etc.). Without it, the
    // conversation only appears in the admin view which doesn't filter by agent.
    await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).insertOne({
      id: resolvedSessionId,
      project: task.project,
      username,
      title: task.name,
      agent: task.agent,
      messages: [userTriggerMessage],
      systemPrompt: "",
      settings,
      modalities: { textIn: true, textOut: false },
      providers: [task.provider.toLowerCase()],
      totalCost: 0,
      isGenerating: true,
      createdAt: nowISO,
      updatedAt: nowISO,
    });

    const mockEmit = (event: SseEvent) => {
      logger.debug(`[ScheduledTasks][${task.name}][Event] type=${event.type}`);
    };

    // 2. Resolve provider and model definitions
    const provider = getProvider(task.provider);
    const modelDef = getModelByName(task.model);

    if (!provider) {
      throw new Error(`Provider not found: ${task.provider}`);
    }

    // 3. Trigger AgenticLoopService
    try {
      await AgenticLoopService.runAgenticLoop({
        provider: provider as any as import("./harnesses/types.ts").LLMProvider,
        providerName: task.provider,
        resolvedModel: task.model,
        modelDef,
        messages: [userTriggerMessage as ConversationMessage],
        originalMessages: [userTriggerMessage as ConversationMessage],
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          ...((task as any).toolConfig?.enabledTools && { enabledTools: (task as any).toolConfig.enabledTools }),
        },
        agentSessionId: resolvedSessionId,
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
        clientIp: "127.0.0.1",
        agent: task.agent,
        workspaceRoot: workspacePath,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: mockEmit,
      });

      logger.success(`[ScheduledTasks] Task "${task.name}" completed execution successfully.`);
    } catch (err: unknown) {
      logger.error(`[ScheduledTasks] Agent loop error for task "${task.name}": ${(err as Error).message}`);
      
      // Ensure the generated session is not stuck as "generating"
      await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).updateOne(
        { id: resolvedSessionId },
        { $set: { isGenerating: false, updatedAt: new Date().toISOString() } },
      ).catch(() => {});

      throw err;
    }

    return { agentSessionId: resolvedSessionId };
  },

  // ─── CRUD REST Helpers ─────────────────────────────────────────────────────────

  // Helper to determine if a project is a client UI project and build an appropriate query filter
  async _getQueryFilter(id: string, project: string, username: string): Promise<Record<string, any>> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    let isClientProject = true;

    if (project && db) {
      // Check if project is a registered workspace root
      const workspaceExists = await db.collection("workspaces").findOne({ name: project });
      if (workspaceExists) {
        isClientProject = false;
      } else {
        // Fallback: check registered agent projects
        const { default: AgentPersonaRegistry } = await import("./AgentPersonaRegistry.ts");
        const agentProjects = AgentPersonaRegistry.list().map((project) => {
          const persona = AgentPersonaRegistry.get(project.id);
          return persona?.project;
        }).filter(Boolean);
        
        if (agentProjects.includes(project)) {
          isClientProject = false;
        }
      }
    }

    const filter: Record<string, any> = { id };
    if (!isClientProject) {
      filter.project = project;
    }
    if (username && username !== "any" && username !== "all" && !isClientProject) {
      filter.username = username;
    }
    return filter;
  },

  async listTasks(project: string, username: string): Promise<ScheduledTask[]> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];

    let isClientProject = true;
    if (project && db) {
      // Check if project is a registered workspace root
      const workspaceExists = await db.collection("workspaces").findOne({ name: project });
      if (workspaceExists) {
        isClientProject = false;
      } else {
        // Fallback: check registered agent projects
        const { default: AgentPersonaRegistry } = await import("./AgentPersonaRegistry.ts");
        const agentProjects = AgentPersonaRegistry.list().map((project) => {
          const persona = AgentPersonaRegistry.get(project.id);
          return persona?.project;
        }).filter(Boolean);
        
        if (agentProjects.includes(project)) {
          isClientProject = false;
        }
      }
    }

    const query: Record<string, any> = {};
    if (!isClientProject) {
      query.project = project;
    }
    if (username && username !== "any" && username !== "all" && !isClientProject) {
      query.username = username;
    }

    return (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ScheduledTask[];
  },

  async createTask(data: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt"> & { username: string }): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const task: ScheduledTask = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: nowISO,
      updatedAt: nowISO,
    };

    await db.collection(COLLECTIONS.SCHEDULED_TASKS).insertOne(task);
    return task;
  },

  async updateTask(id: string, project: string, username: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const cleanUpdates = {
      ...updates,
      updatedAt: nowISO,
    };
    delete (cleanUpdates as any).id;
    delete (cleanUpdates as any).createdAt;

    const filter = await this._getQueryFilter(id, project, username);
    const result = await db.collection(COLLECTIONS.SCHEDULED_TASKS).findOneAndUpdate(
      filter,
      { $set: cleanUpdates },
      { returnDocument: "after" }
    );

    if (!result) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    return result as unknown as ScheduledTask;
  },

  async deleteTask(id: string, project: string, username: string): Promise<boolean> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username);
    let result = await db.collection(COLLECTIONS.SCHEDULED_TASKS).deleteOne(filter);
    if ((result.deletedCount ?? 0) === 0) {
      const nameFilter = { ...filter };
      delete nameFilter.id;
      (nameFilter as any).name = id;
      result = await db.collection(COLLECTIONS.SCHEDULED_TASKS).deleteOne(nameFilter);
    }
    return (result.deletedCount ?? 0) > 0;
  },

  async triggerTask(id: string, project: string, username: string, payload?: Record<string, unknown>): Promise<{ success: boolean; agentSessionId: string }> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username);
    let task = (await db.collection(COLLECTIONS.SCHEDULED_TASKS).findOne(filter)) as unknown as ScheduledTask;
    if (!task) {
      // Fallback: look up by name
      const nameFilter = { ...filter };
      delete nameFilter.id;
      (nameFilter as any).name = id;
      task = (await db.collection(COLLECTIONS.SCHEDULED_TASKS).findOne(nameFilter)) as unknown as ScheduledTask;
    }
    if (!task) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    const agentSessionId = crypto.randomUUID();

    // Fire-and-forget background execution with the pre-generated session ID
    this.executeTask(
      { ...task, id: task.id },
      payload,
      { username, agentSessionId },
    ).catch((err: unknown) => {
      logger.error(`[ScheduledTasks] Manual trigger failed for task "${task.name}": ${(err as Error).message}`);
    });

    return { success: true, agentSessionId };
  }
};

export default ScheduledTaskService;
