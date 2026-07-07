import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDERS } from "../../constants.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";

// ── Hoisted mocks for database and functions ───────────────────
const { mockDatabase, resetMockDatabase } = vi.hoisted(() => {
  const collections: Record<string, any[]> = {
    scheduled_tasks: [],
    agent_conversations: [],
    workspaces: [],
  };

  const collectionInstances: Record<string, any> = {};

  const db = {
    collection: vi.fn().mockImplementation((collectionName: string) => {
      if (collectionInstances[collectionName]) {
        return collectionInstances[collectionName];
      }
      const documents = collections[collectionName] || [];
      const instance = {
        insertOne: vi.fn().mockImplementation(async (document) => {
          documents.push(document);
          return { insertedId: "mock-id" };
        }),
        find: vi.fn().mockImplementation((query) => {
          let sortCriteria: any = null;
          const filteredDocs = documents.filter((document) =>
            Object.entries(query).every(([key, value]) => {
              if (typeof value === "object" && value !== null && "$ne" in value) {
                return document[key] !== (value as any).$ne;
              }
              return document[key] === value;
            })
          );

          const cursor = {
            sort: vi.fn().mockImplementation((criteria) => {
              sortCriteria = criteria;
              return cursor;
            }),
            toArray: vi.fn().mockImplementation(async () => {
              if (sortCriteria) {
                const [sortField, sortDirection] = Object.entries(sortCriteria)[0];
                filteredDocs.sort((a, b) => {
                  if (a[sortField] < b[sortField]) {
                    return sortDirection === -1 ? 1 : -1;
                  }
                  if (a[sortField] > b[sortField]) {
                    return sortDirection === -1 ? -1 : 1;
                  }
                  return 0;
                });
              }
              return filteredDocs;
            }),
          };
          return cursor;
        }),
        findOne: vi.fn().mockImplementation(async (query) =>
          documents.find((document) =>
            Object.entries(query).every(([key, value]) => document[key] === value)
          )
        ),
        findOneAndUpdate: vi.fn().mockImplementation(async (query, update, options) => {
          const document = documents.find((document) =>
            Object.entries(query).every(([key, value]) => {
              if (typeof value === "object" && value !== null && "$ne" in value) {
                return document[key] !== (value as any).$ne;
              }
              return document[key] === value;
            })
          );
          if (document && update.$set) {
            Object.assign(document, update.$set);
          }
          return options?.returnDocument === "after" ? document : document;
        }),
        deleteOne: vi.fn().mockImplementation(async (query) => {
          const index = documents.findIndex((document) =>
            Object.entries(query).every(([key, value]) => document[key] === value)
          );
          if (index >= 0) {
            documents.splice(index, 1);
            return { deletedCount: 1 };
          }
          return { deletedCount: 0 };
        }),
        updateOne: vi.fn().mockImplementation(async (query, update) => {
          const document = documents.find((document) =>
            Object.entries(query).every(([key, value]) => document[key] === value)
          );
          if (document && update.$set) {
            Object.assign(document, update.$set);
          }
          return { modifiedCount: 1 };
        }),
      };
      collectionInstances[collectionName] = instance;
      return instance;
    }),
    _collections: collections,
  };

  return {
    mockDatabase: db,
    resetMockDatabase: () => {
      Object.keys(collections).forEach((key) => {
        collections[key] = [];
      });
      Object.keys(collectionInstances).forEach((key) => {
        delete collectionInstances[key];
      });
    },
  };
});

// ── Mock config ────────────────────────────────────────────────
vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  getModelByName: vi.fn().mockReturnValue({
    name: "test-model",
    provider: PROVIDERS.GOOGLE,
    contextLength: 128_000,
  }),
}));

// ── Mock logger (suppress output) ──────────────────────────────
vi.mock("../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

// ── Mock CleanupRegistry (no-op) ───────────────────────────────
vi.mock("../../utils/CleanupRegistry.ts", () => ({
  registerCleanup: vi.fn(),
}));

// ── Track ConversationService/AgenticLoopService mock calls ──
const mockRunAgenticLoop = vi.fn().mockResolvedValue(undefined);

vi.mock("../AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...callArguments: unknown[]) => mockRunAgenticLoop(...callArguments),
  },
}));

// ── Mock providers ─────────────────────────────────────────────
vi.mock("../../providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation((providerName: string) => {
    if (providerName === "nonexistent") {
      return undefined;
    }
    return {
      generateText: vi.fn(),
      generateTextStream: vi.fn(),
    };
  }),
}));

// ── Mock MongoWrapper ──────────────────────────────────────────
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn().mockImplementation(() => mockDatabase),
  },
}));

// ── Mock RecurrenceMatcher ─────────────────────────────────────
const mockMatchRecurrenceRule = vi.fn().mockReturnValue(true);
vi.mock("../../utils/RecurrenceMatcher.ts", () => ({
  matchRecurrenceRule: (...callArguments: unknown[]) => mockMatchRecurrenceRule(...callArguments),
}));

// ── Mock AgentPersonaRegistry ──────────────────────────────────
vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: {
    list: vi.fn().mockReturnValue([
      { id: "OMNI", name: "OmniAgent", project: "agent-project" },
    ]),
    get: vi.fn().mockImplementation((agentId: string) => {
      if (agentId.toUpperCase() === "OMNI") {
        return { id: "OMNI", name: "OmniAgent", project: "agent-project" };
      }
      return null;
    }),
  },
}));

// ── Import AFTER mocks are wired ───────────────────────────────
const { default: ScheduledTaskService, matchCron } = await import(
  "../ScheduledTaskService.ts"
);

// ── Test fixtures ──────────────────────────────────────────────
const TASK_FIXTURE = {
  id: "task-test-001",
  name: "Daily Health Check",
  project: "prism-chat",
  username: "rodrigo",
  prompt: "Verify server status",
  agent: "OMNI",
  provider: PROVIDERS.GOOGLE,
  model: "gemini-3.5-flash",
  scheduleType: "once" as const,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function insertScheduledTask(scheduledTaskData: Partial<any>) {
  const newScheduledTask = {
    id: crypto.randomUUID(),
    name: "Test Task",
    project: "prism-chat",
    username: "rodrigo",
    prompt: "Verify server status",
    agent: "OMNI",
    provider: PROVIDERS.GOOGLE,
    model: "gemini-3.5-flash",
    scheduleType: "once",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunMinute: undefined as string | undefined,
    ...scheduledTaskData,
  };
  mockDatabase._collections.scheduled_tasks.push(newScheduledTask);
  return newScheduledTask;
}

describe("ScheduledTaskService — Comprehensive Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDatabase();
    // Ensure the database is always returned by default
    (MongoWrapper.getDb as any).mockImplementation(() => mockDatabase);
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 1: Cron Matcher Tests
  // ──────────────────────────────────────────────────────────────
  describe("Cron Matcher", () => {
    it("should match wildcard * correctly", () => {
      const isMatched = matchCron("* * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMatched).toBe(true);
    });

    it("should match exact values correctly", () => {
      const isMatchedExact = matchCron("30 12 1 1 *", new Date(2026, 0, 1, 12, 30));
      expect(isMatchedExact).toBe(true);

      const isMismatchHour = matchCron("30 13 1 1 *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchHour).toBe(false);
    });

    it("should match comma-separated values correctly", () => {
      const isMatchedList = matchCron("15,30,45 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMatchedList).toBe(true);

      const isMismatchList = matchCron("15,40,45 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchList).toBe(false);
    });

    it("should match ranges correctly", () => {
      const isMatchedRange = matchCron("20-40 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMatchedRange).toBe(true);

      const isMismatchRange = matchCron("35-40 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchRange).toBe(false);
    });

    it("should match steps with wildcard correctly", () => {
      const isMatchedStepWildcard = matchCron("*/15 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMatchedStepWildcard).toBe(true);

      const isMismatchStepWildcard = matchCron("*/20 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchStepWildcard).toBe(false);
    });

    it("should match steps with starting range value correctly", () => {
      const isMatchedStepStart = matchCron("5/25 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMatchedStepStart).toBe(true);

      const isMismatchStepStart = matchCron("6/25 * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchStepStart).toBe(false);
    });

    it("should fail when step parsing evaluates to NaN or invalid patterns", () => {
      const isMismatchStepInvalid = matchCron("*/abc * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchStepInvalid).toBe(false);

      const isMismatchRangeInvalid = matchCron("abc-def * * * *", new Date(2026, 0, 1, 12, 30));
      expect(isMismatchRangeInvalid).toBe(false);
    });

    it("should fail when cron expression has incorrect number of fields", () => {
      const isMismatchFieldCount = matchCron("* * *", new Date());
      expect(isMismatchFieldCount).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 2: Daemon Lifecycle
  // ──────────────────────────────────────────────────────────────
  describe("Daemon Lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should starts interval aligned to next minute boundary", async () => {
      vi.setSystemTime(new Date(2026, 0, 1, 10, 20, 15));
      const tickSpy = vi.spyOn(ScheduledTaskService, "tick").mockResolvedValue(undefined);

      await ScheduledTaskService.init();

      // Fast forward by 44 seconds - no tick yet
      await vi.advanceTimersByTimeAsync(44000);
      expect(tickSpy).not.toHaveBeenCalled();

      // Fast forward by 1 more second (45 seconds total) - tick should fire
      await vi.advanceTimersByTimeAsync(1000);
      expect(tickSpy).toHaveBeenCalledTimes(1);

      // Fast forward by another 60 seconds - interval tick should fire
      await vi.advanceTimersByTimeAsync(60000);
      expect(tickSpy).toHaveBeenCalledTimes(2);

      ScheduledTaskService.destroy();
      tickSpy.mockRestore();
    });

    it("should clear interval on destroy, and be idempotent", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      ScheduledTaskService.destroy();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      await ScheduledTaskService.init();
      // Advance by 60 seconds so setTimeout runs and tickingInterval is populated
      await vi.advanceTimersByTimeAsync(60000);

      ScheduledTaskService.destroy();
      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockClear();
      ScheduledTaskService.destroy();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 3: Scheduler Tick
  // ──────────────────────────────────────────────────────────────
  describe("Scheduler Tick", () => {
    let executeTaskSpy: any;

    beforeEach(() => {
      executeTaskSpy = vi.spyOn(ScheduledTaskService, "executeTask").mockResolvedValue({ agentConversationId: "conversation-id" });
      vi.useFakeTimers();
    });

    afterEach(() => {
      executeTaskSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should fire hourly task at minute 0", async () => {
      insertScheduledTask({ scheduleType: "hourly" });
      vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0)); // Minute 0

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    it("should not fire hourly task at other minutes", async () => {
      insertScheduledTask({ scheduleType: "hourly" });
      vi.setSystemTime(new Date(2026, 5, 1, 10, 5, 0)); // Minute 5

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).not.toHaveBeenCalled();
    });

    it("should fire daily task at matching time", async () => {
      insertScheduledTask({ scheduleType: "daily", scheduleTime: "09:15" });
      vi.setSystemTime(new Date(2026, 5, 1, 9, 15, 0));

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire weekly task at matching day and time", async () => {
      insertScheduledTask({ scheduleType: "weekly", scheduleDay: 1, scheduleTime: "14:30" });
      // June 1, 2026 is Monday (day 1)
      vi.setSystemTime(new Date(2026, 5, 1, 14, 30, 0));

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire once task at matching date and time and disable it", async () => {
      const task = insertScheduledTask({ scheduleType: "once", scheduleDate: "2026-07-01", scheduleTime: "10:00" });
      vi.setSystemTime(new Date(2026, 6, 1, 10, 0, 0));

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);

      const updatedTask = mockDatabase._collections.scheduled_tasks.find((t) => t.id === task.id);
      expect(updatedTask?.enabled).toBe(false);
    });

    it("should fire cron task when expression matches", async () => {
      insertScheduledTask({ scheduleType: "cron", cronExpression: "*/5 * * * *" });
      vi.setSystemTime(new Date(2026, 5, 1, 10, 5, 0));

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire custom task when recurrenceRule matches", async () => {
      mockMatchRecurrenceRule.mockReturnValueOnce(true);
      insertScheduledTask({ scheduleType: "custom", recurrenceRule: { type: "weekly", interval: 1 } as any, scheduleTime: "08:00" });
      vi.setSystemTime(new Date(2026, 5, 1, 8, 0, 0));

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    it("should skip task already run in this minute", async () => {
      const task = insertScheduledTask({ scheduleType: "hourly" });
      vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
      const minuteKey = "2026-06-01T10:00";
      task.lastRunMinute = minuteKey;

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).not.toHaveBeenCalled();
    });

    it("should prevent duplicate execution via atomic claim", async () => {
      insertScheduledTask({ scheduleType: "hourly" });
      vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));

      const findOneAndUpdateSpy = vi.spyOn(mockDatabase.collection("scheduled_tasks"), "findOneAndUpdate").mockResolvedValueOnce(null);

      await ScheduledTaskService.tick();
      expect(executeTaskSpy).not.toHaveBeenCalled();

      findOneAndUpdateSpy.mockRestore();
    });

    it("should return early when database is not connected", async () => {
      (MongoWrapper.getDb as any).mockReturnValueOnce(undefined);
      await ScheduledTaskService.tick();
      expect(executeTaskSpy).not.toHaveBeenCalled();
    });

    it("should handle task evaluation errors gracefully and continue", async () => {
      // Invalid format schedule Time: will throw
      insertScheduledTask({ scheduleType: "daily", scheduleTime: undefined });
      insertScheduledTask({ scheduleType: "hourly" });

      vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));

      await ScheduledTaskService.tick();
      // Should still execute the hourly task
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 4: Task Execution
  // ──────────────────────────────────────────────────────────────
  describe("Task Execution", () => {
    it("should successfully persist the toolConfig when creating a new scheduled task", async () => {
      await ScheduledTaskService.createTask({
        name: "Daily Health Check",
        project: "prism-chat",
        prompt: "Verify server status",
        agent: "OMNI",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        scheduleType: "once",
        enabled: true,
        username: "rodrigo",
        toolConfig: {
          enabledTools: ["read_file", "write_file"],
          disabledTools: ["execute_shell"],
        },
      } as any);

      expect(mockDatabase._collections.scheduled_tasks.length).toBe(1);
      const insertedDocument = mockDatabase._collections.scheduled_tasks[0];
      
      expect(insertedDocument.name).toBe("Daily Health Check");
      expect(insertedDocument.toolConfig).toEqual({
        enabledTools: ["read_file", "write_file"],
        disabledTools: ["execute_shell"],
      });
    });

    it("should spawn background agents with the exact toolConfig and enabledTools propagated from the scheduled task", async () => {
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);

      const taskWithToolConfig = {
        ...TASK_FIXTURE,
        toolConfig: {
          enabledTools: ["read_file", "write_file", "execute_javascript"],
          disabledTools: ["execute_shell"],
        },
      };

      await ScheduledTaskService.executeTask(
        taskWithToolConfig as any,
        undefined,
        { username: "rodrigo" }
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      
      expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file", "execute_javascript"]);
      expect(loopArguments.options.disabledTools).toEqual(["execute_shell"]);

      expect(mockDatabase._collections.agent_conversations.length).toBe(1);
      const insertedSessionStub = mockDatabase._collections.agent_conversations[0];
      expect(insertedSessionStub.settings.toolConfig).toEqual({
        enabledTools: ["read_file", "write_file", "execute_javascript"],
        disabledTools: ["execute_shell"],
      });
    });

    it("should spawn background agent with only enabledTools when the parent agent (e.g. Omni) has wildcard availableTools but has a subset as enabledTools", async () => {
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);

      const taskWithOmniWildcard = {
        ...TASK_FIXTURE,
        toolConfig: {
          availableTools: ["*"],
          disabledTools: ["search_web", "generate_image"],
          enabledTools: ["read_file", "write_file", "evaluate_expression"],
        },
      };

      await ScheduledTaskService.executeTask(
        taskWithOmniWildcard as any,
        undefined,
        { username: "rodrigo" }
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];

      expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file", "evaluate_expression"]);
      expect(loopArguments.options.disabledTools).toEqual(["search_web", "generate_image"]);
    });

    it("should resolve workspace path from workspaces collection", async () => {
      mockDatabase._collections.workspaces.push({ name: "prism-chat", path: "/workspace/path" });
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);

      await ScheduledTaskService.executeTask(TASK_FIXTURE as any, undefined, { username: "rodrigo" });

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArguments.workspaceRoot).toBe("/workspace/path");
    });

    it("should handle missing workspace gracefully", async () => {
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);

      await ScheduledTaskService.executeTask(TASK_FIXTURE as any, undefined, { username: "rodrigo" });

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArguments.workspaceRoot).toBeNull();
    });

    it("should append trigger payload to prompt context", async () => {
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);

      await ScheduledTaskService.executeTask(TASK_FIXTURE as any, { event: "webhook", source: "github" }, { username: "rodrigo" });

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArguments.messages[0].content).toContain('Trigger payload: {"event":"webhook","source":"github"}');
    });

    it("should reset isGenerating to false on loop failure", async () => {
      mockRunAgenticLoop.mockRejectedValueOnce(new Error("Agentic loop failed"));

      await expect(
        ScheduledTaskService.executeTask(TASK_FIXTURE as any, undefined, { username: "rodrigo" })
      ).rejects.toThrow("Agentic loop failed");

      expect(mockDatabase._collections.agent_conversations.length).toBe(1);
      const insertedSessionStub = mockDatabase._collections.agent_conversations[0];
      expect(insertedSessionStub.isGenerating).toBe(false);
    });

    it("should throw when task has no agent identifier", async () => {
      const taskWithoutAgent = { ...TASK_FIXTURE, agent: null };
      await expect(
        ScheduledTaskService.executeTask(taskWithoutAgent as any, undefined, { username: "rodrigo" })
      ).rejects.toThrow("missing a required agent identifier");
    });

    it("should throw when provider is not found", async () => {
      const taskWithInvalidProvider = { ...TASK_FIXTURE, provider: "nonexistent" };
      await expect(
        ScheduledTaskService.executeTask(taskWithInvalidProvider as any, undefined, { username: "rodrigo" })
      ).rejects.toThrow("Provider not found");
    });

    it("should use provided agentConversationId if given", async () => {
      mockRunAgenticLoop.mockResolvedValueOnce(undefined);
      await ScheduledTaskService.executeTask(TASK_FIXTURE as any, undefined, { username: "rodrigo", agentConversationId: "custom-id-123" });

      expect(mockDatabase._collections.agent_conversations.length).toBe(1);
      const insertedSessionStub = mockDatabase._collections.agent_conversations[0];
      expect(insertedSessionStub.id).toBe("custom-id-123");
    });

    it("should throw database error if db is not connected", async () => {
      (MongoWrapper.getDb as any).mockReturnValueOnce(undefined);
      await expect(
        ScheduledTaskService.executeTask(TASK_FIXTURE as any)
      ).rejects.toThrow("Database not connected");
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 5: CRUD Operations
  // ──────────────────────────────────────────────────────────────
  describe("CRUD Operations", () => {
    it("should list tasks for project and user, sorted descending by createdAt", async () => {
      mockDatabase._collections.workspaces.push({ name: "prism-chat", path: "/workspace" });

      insertScheduledTask({ project: "prism-chat", username: "rodrigo", createdAt: "2026-01-01T00:00:00Z", name: "Task 1" });
      insertScheduledTask({ project: "prism-chat", username: "rodrigo", createdAt: "2026-01-02T00:00:00Z", name: "Task 2" });
      insertScheduledTask({ project: "other-project", username: "rodrigo", name: "Task 3" });

      const tasks = await ScheduledTaskService.listTasks("prism-chat", "rodrigo");
      expect(tasks.length).toBe(2);
      expect(tasks[0].name).toBe("Task 2");
      expect(tasks[1].name).toBe("Task 1");
    });

    it("should list all tasks globally", async () => {
      insertScheduledTask({ project: "prism-chat", username: "rodrigo" });
      insertScheduledTask({ project: "other-project", username: "other" });

      const tasks = await ScheduledTaskService.listAllTasks();
      expect(tasks.length).toBe(2);
    });

    it("should update task by id and ignore id and createdAt updates", async () => {
      const task = insertScheduledTask({ name: "Original Name", createdAt: "2026-01-01T00:00:00Z" });

      const updated = await ScheduledTaskService.updateTask(task.id, task.project, task.username, {
        name: "Updated Name",
        id: "new-hacked-id",
        createdAt: "2026-02-02T00:00:00Z",
      } as any);

      expect(updated.name).toBe("Updated Name");
      expect(updated.id).toBe(task.id);
      expect(updated.createdAt).toBe("2026-01-01T00:00:00Z");
    });

    it("should throw when trying to update non-existent task", async () => {
      await expect(
        ScheduledTaskService.updateTask("nonexistent-id", "prism-chat", "rodrigo", { name: "New Name" })
      ).rejects.toThrow("Scheduled Task not found: nonexistent-id");
    });

    it("should delete task by id", async () => {
      const task = insertScheduledTask({});
      const isDeleted = await ScheduledTaskService.deleteTask(task.id, task.project, task.username);
      expect(isDeleted).toBe(true);
      expect(mockDatabase._collections.scheduled_tasks.length).toBe(0);
    });

    it("should fall back to name lookup when deleting task and id delete misses", async () => {
      const task = insertScheduledTask({ name: "my-delete-fallback" });
      const isDeleted = await ScheduledTaskService.deleteTask("my-delete-fallback", task.project, task.username);
      expect(isDeleted).toBe(true);
      expect(mockDatabase._collections.scheduled_tasks.length).toBe(0);
    });

    it("should return false when deleting non-existent task", async () => {
      const isDeleted = await ScheduledTaskService.deleteTask("nonexistent-id", "prism-chat", "rodrigo");
      expect(isDeleted).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 6: Manual Triggering
  // ──────────────────────────────────────────────────────────────
  describe("Manual Triggering", () => {
    let executeTaskSpy: any;

    beforeEach(() => {
      executeTaskSpy = vi.spyOn(ScheduledTaskService, "executeTask").mockResolvedValue({ agentConversationId: "generated-id" });
    });

    afterEach(() => {
      executeTaskSpy.mockRestore();
    });

    it("should trigger task by id and run executeTask", async () => {
      const task = insertScheduledTask({});
      const result = await ScheduledTaskService.triggerTask(task.id, task.project, task.username, { test: 123 });

      expect(result.success).toBe(true);
      expect(result.agentConversationId).toBeDefined();
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
      expect(executeTaskSpy.mock.calls[0][0].id).toBe(task.id);
      expect(executeTaskSpy.mock.calls[0][1]).toEqual({ test: 123 });
    });

    it("should fall back to name lookup when triggering task and id search misses", async () => {
      const task = insertScheduledTask({ name: "my-trigger-fallback" });
      const result = await ScheduledTaskService.triggerTask("my-trigger-fallback", task.project, task.username);

      expect(result.success).toBe(true);
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
      expect(executeTaskSpy.mock.calls[0][0].id).toBe(task.id);
    });

    it("should throw error when triggering non-existent task", async () => {
      await expect(
        ScheduledTaskService.triggerTask("nonexistent-id", "prism-chat", "rodrigo")
      ).rejects.toThrow("Scheduled Task not found: nonexistent-id");
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GROUP 7: Query Scoping Helpers
  // ──────────────────────────────────────────────────────────────
  describe("Query Scoping Helpers", () => {
    it("should classify projects in _isClientProject correctly", async () => {
      mockDatabase._collections.workspaces.push({ name: "my-workspace-project", path: "/path" });

      // 1. Workspace projects (not client project) -> returns false
      const isWorkspaceClient = await ScheduledTaskService._isClientProject("my-workspace-project");
      expect(isWorkspaceClient).toBe(false);

      // 2. Agent projects (not client project) -> returns false
      const isAgentClient = await ScheduledTaskService._isClientProject("agent-project");
      expect(isAgentClient).toBe(false);

      // 3. Unknown projects (client project) -> returns true
      const isUnknownClient = await ScheduledTaskService._isClientProject("unknown-project");
      expect(isUnknownClient).toBe(true);
    });

    it("should construct query filters correctly in _getQueryFilter", async () => {
      // 1. Client projects: only use task ID
      let filter = await ScheduledTaskService._getQueryFilter("task-id", "unknown-project", "rodrigo");
      expect(filter).toEqual({ id: "task-id" });

      // 2. Non-client projects: include project and username
      filter = await ScheduledTaskService._getQueryFilter("task-id", "agent-project", "rodrigo");
      expect(filter).toEqual({ id: "task-id", project: "agent-project", username: "rodrigo" });

      // 3. Omit username when username is "any" or "all"
      filter = await ScheduledTaskService._getQueryFilter("task-id", "agent-project", "any");
      expect(filter).toEqual({ id: "task-id", project: "agent-project" });

      filter = await ScheduledTaskService._getQueryFilter("task-id", "agent-project", "all");
      expect(filter).toEqual({ id: "task-id", project: "agent-project" });
    });
  });
});
