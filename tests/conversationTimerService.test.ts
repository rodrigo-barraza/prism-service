import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDERS, COLLECTIONS } from "../src/constants.ts";
import crypto from "crypto";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import ConversationService from "../src/services/ConversationService.ts";
import * as configModule from "../src/config.ts";
import * as scheduledTaskServiceModule from "../src/services/ScheduledTaskService.ts";
import * as providersModule from "../src/providers/index.ts";
import { registerCleanup } from "../src/utils/CleanupRegistry.ts";

// ── Mock logger (suppress output) ──────────────────────────────
vi.mock("../src/utils/logger.ts", () => ({
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
vi.mock("../src/utils/CleanupRegistry.ts", () => ({
  registerCleanup: vi.fn(),
}));

// ── Mock AgenticLoopService ────────────────────────────────────
const mockRunAgenticLoop = vi.fn().mockImplementation(async (options) => {
  if (options && options.emit) {
    options.emit({ type: "chunk", content: "test" });
  }
  return undefined;
});

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...parameters: unknown[]) => mockRunAgenticLoop(...parameters),
  },
}));

// ── Mock MongoWrapper Implementation Override ──────────────────
const mockDocumentsMap = new Map<string, any[]>();
let mockDbUnavailable = false;

function mockGetDocuments(collectionName: string): any[] {
  if (!mockDocumentsMap.has(collectionName)) {
    mockDocumentsMap.set(collectionName, []);
  }
  return mockDocumentsMap.get(collectionName)!;
}

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockUpdateMany = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockFindDocuments = vi.fn();
const mockInsertOne = vi.fn();

vi.mocked(MongoWrapper.getDb).mockImplementation(() => {
  if (mockDbUnavailable) return null as any;
  return {
    collection: vi.fn().mockImplementation((name) => ({
      findOne: vi.fn().mockImplementation(async (query) => {
        const spyResult = await mockFindOne(query);
        if (spyResult !== undefined) return spyResult;

        const list = mockGetDocuments(name);
        return list.find((document) => {
          return Object.entries(query).every(([key, value]) => document[key] === value);
        }) || null;
      }),
      updateOne: vi.fn().mockImplementation(async (query, update) => {
        const spyResult = await mockUpdateOne(query, update);
        if (spyResult !== undefined) return spyResult;

        const list = mockGetDocuments(name);
        const document = list.find((doc) => {
          return Object.entries(query).every(([key, value]) => doc[key] === value);
        });
        if (document && update && update.$set) {
          Object.assign(document, update.$set);
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      }),
      updateMany: vi.fn().mockImplementation(async (query, update) => {
        const spyResult = await mockUpdateMany(query, update);
        if (spyResult !== undefined) return spyResult;

        let modifiedCount = 0;
        const list = mockGetDocuments(name);
        const matching = list.filter((doc) => {
          return Object.entries(query).every(([key, value]) => {
            if (value && typeof value === "object") {
              if ("$ne" in value) {
                return doc[key] !== (value as any).$ne;
              }
            }
            return doc[key] === value;
          });
        });

        for (const document of matching) {
          if (update && update.$set) {
            Object.assign(document, update.$set);
            modifiedCount++;
          }
        }
        return { modifiedCount };
      }),
      findOneAndUpdate: vi.fn().mockImplementation(async (query, update) => {
        const spyResult = await mockFindOneAndUpdate(query, update);
        if (spyResult !== undefined) return spyResult;

        const list = mockGetDocuments(name);
        const documentIndex = list.findIndex((doc) => {
          return Object.entries(query).every(([key, value]) => {
            if (value && typeof value === "object") {
              if ("$ne" in value) {
                return doc[key] !== (value as any).$ne;
              }
            }
            return doc[key] === value;
          });
        });

        if (documentIndex === -1) {
          return null;
        }

        const document = list[documentIndex];
        if (update && update.$set) {
          Object.assign(document, update.$set);
        }
        return document;
      }),
      find: vi.fn().mockImplementation((query) => {
        const spyResult = mockFindDocuments(query);
        if (spyResult !== undefined) return spyResult;

        const toArray = vi.fn().mockImplementation(async () => {
          const list = mockGetDocuments(name);
          return list.filter((doc) => {
            return Object.entries(query).every(([key, value]) => {
              if (value && typeof value === "object") {
                if ("$lte" in value) {
                  return doc[key] <= (value as any).$lte;
                }
                if ("$ne" in value) {
                  return doc[key] !== (value as any).$ne;
                }
              }
              return doc[key] === value;
            });
          });
        });
        return {
          sort: vi.fn().mockImplementation(() => ({ toArray })),
          toArray,
        };
      }),
      insertOne: vi.fn().mockImplementation(async (document) => {
        const spyResult = await mockInsertOne(document);
        if (spyResult !== undefined) return spyResult;

        const list = mockGetDocuments(name);
        list.push(document);
        return { insertedId: document.id || "test-id" };
      }),
    })),
  } as any;
});

// ── Import AFTER mocks are wired ───────────────────────────────
import ConversationTimerService, { type ConversationTimer } from "../src/services/ConversationTimerService.ts";

// ── Test fixtures ──────────────────────────────────────────────
const TIMER_FIXTURE: ConversationTimer = {
  id: "timer-test-001",
  conversationId: "session-abc-123",
  project: "coding",
  username: "testuser",
  prompt: "Run the health check",
  mode: "one_shot" as const,
  durationSeconds: 20,
  iterationCount: 0,
  firesAt: new Date().toISOString(),
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const CONVERSATION_FIXTURE = {
  id: "session-abc-123",
  project: "coding",
  username: "testuser",
  title: "Test Session",
  messages: [
    { role: "user", content: "Hello", timestamp: new Date().toISOString() },
  ],
  settings: {
    provider: PROVIDERS.GOOGLE,
    model: "gemini-3-flash",
  },
  isGenerating: false,
  traceId: "trace-xyz",
};

const REMINDER_MESSAGE = {
  role: "user" as const,
  content: "🔔 Notification: Run the health check",
  timestamp: new Date().toISOString(),
};

// ═══════════════════════════════════════════════════════════════
describe("ConversationTimerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentsMap.clear();
    mockDbUnavailable = false;

    // Set up standard spy configurations to avoid config conflict with setup.ts
    vi.spyOn(configModule, "getModelByName").mockReturnValue({
      name: "test-model",
      provider: "google",
      contextLength: 128_000,
    } as any);

    vi.spyOn(scheduledTaskServiceModule, "matchCron").mockReturnValue(false);

    vi.spyOn(providersModule, "getProvider").mockReturnValue({
      generateText: vi.fn(),
      generateTextStream: vi.fn(),
    } as any);
  });

  // ── Group 1: init() / destroy() — daemon lifecycle ──────────
  describe("init() and destroy() — daemon lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(global, "setInterval");
      vi.spyOn(global, "clearInterval");
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("should start interval on init", async () => {
      await ConversationTimerService.init();
      expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1000);
      ConversationTimerService.destroy();
    });

    it("should clear interval on destroy", async () => {
      await ConversationTimerService.init();
      ConversationTimerService.destroy();
      expect(clearInterval).toHaveBeenCalled();
    });

    it("should be idempotent on destroy", () => {
      expect(() => {
        ConversationTimerService.destroy();
        ConversationTimerService.destroy();
      }).not.toThrow();
    });

    it("should execute tick on interval trigger", async () => {
      const tickSpy = vi.spyOn(ConversationTimerService, "tick").mockResolvedValue(undefined);
      await ConversationTimerService.init();

      await vi.advanceTimersByTimeAsync(1000);

      expect(tickSpy).toHaveBeenCalled();
      ConversationTimerService.destroy();
    });

    it("should handle error in ticker interval tick execution", async () => {
      const tickSpy = vi.spyOn(ConversationTimerService, "tick").mockRejectedValue(new Error("Tick failure"));
      await ConversationTimerService.init();

      await vi.advanceTimersByTimeAsync(1000);

      expect(tickSpy).toHaveBeenCalled();
      ConversationTimerService.destroy();
    });

    it("should register and execute cleanup hook", async () => {
      vi.resetModules();

      const { registerCleanup: dynamicRegisterCleanup } = await import("../src/utils/CleanupRegistry.ts");
      const { default: dynamicTimerService } = await import("../src/services/ConversationTimerService.ts");

      expect(dynamicRegisterCleanup).toHaveBeenCalledWith(expect.any(Function));
      const cleanupHook = vi.mocked(dynamicRegisterCleanup).mock.calls[0][0];

      const destroySpy = vi.spyOn(dynamicTimerService, "destroy").mockImplementation(() => {});

      await cleanupHook();
      expect(destroySpy).toHaveBeenCalled();
      destroySpy.mockRestore();
    });
  });

  // ── Group 2: createTimer() — timer creation ─────────────────
  describe("createTimer()", () => {
    it("should create a one-shot timer with correct firesAt", async () => {
      const timer = await ConversationTimerService.createTimer({
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Run the health check",
        durationSeconds: 60,
      });

      expect(timer.mode).toBe("one_shot");
      expect(timer.status).toBe("active");
      expect(timer.iterationCount).toBe(0);
      expect(timer.durationSeconds).toBe(60);

      const expectedTime = new Date(Date.now() + 60 * 1000).getTime();
      const actualTime = new Date(timer.firesAt).getTime();
      expect(Math.abs(actualTime - expectedTime)).toBeLessThan(1000);

      const inserted = mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).find(
        (t) => t.id === timer.id
      );
      expect(inserted).toBeDefined();
    });

    it("should create a recurring timer with cron expression", async () => {
      const timer = await ConversationTimerService.createTimer({
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Run the health check",
        cronExpression: "*/5 * * * *",
      });

      expect(timer.mode).toBe("recurring");
      expect(timer.cronExpression).toBe("*/5 * * * *");
      expect(timer.status).toBe("active");

      const now = new Date();
      const nextMinute = new Date(now.getTime() + 60 * 1000);
      nextMinute.setSeconds(0, 0);
      const expectedTime = nextMinute.getTime();
      const actualTime = new Date(timer.firesAt).getTime();
      expect(Math.abs(actualTime - expectedTime)).toBeLessThan(1000);
    });

    it("should reject one-shot with invalid duration (0 or > 86400)", async () => {
      await expect(
        ConversationTimerService.createTimer({
          conversationId: "session-abc-123",
          project: "coding",
          username: "testuser",
          prompt: "Run",
          durationSeconds: 0,
        })
      ).rejects.toThrow("One-shot duration must be between 1 and 86400 seconds");

      await expect(
        ConversationTimerService.createTimer({
          conversationId: "session-abc-123",
          project: "coding",
          username: "testuser",
          prompt: "Run",
          durationSeconds: 100000,
        })
      ).rejects.toThrow("One-shot duration must be between 1 and 86400 seconds");
    });

    it("should reject invalid cron expression (not 5 fields)", async () => {
      await expect(
        ConversationTimerService.createTimer({
          conversationId: "session-abc-123",
          project: "coding",
          username: "testuser",
          prompt: "Run",
          cronExpression: "* * *",
        })
      ).rejects.toThrow("valid 5-field cron expression");
    });

    it("should throw when database is unavailable", async () => {
      mockDbUnavailable = true;
      await expect(
        ConversationTimerService.createTimer({
          conversationId: "session-abc-123",
          project: "coding",
          username: "testuser",
          prompt: "Run",
          durationSeconds: 60,
        })
      ).rejects.toThrow("Database connection unavailable");
    });
  });

  // ── Group 3: cancelTimer() ──────────────────────────────────
  describe("cancelTimer()", () => {
    it("should cancel an active timer", async () => {
      const timer = {
        id: "timer-123",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        status: "active",
      };
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(timer);

      const result = await ConversationTimerService.cancelTimer("timer-123", "coding", "testuser");
      expect(result).toBe(true);
      expect(timer.status).toBe("cancelled");
    });

    it("should return false when timer is not found or already cancelled", async () => {
      const result = await ConversationTimerService.cancelTimer("nonexistent-timer", "coding", "testuser");
      expect(result).toBe(false);
    });

    it("should throw when database is unavailable", async () => {
      mockDbUnavailable = true;
      await expect(
        ConversationTimerService.cancelTimer("timer-123", "coding", "testuser")
      ).rejects.toThrow("Database connection unavailable");
    });
  });

  // ── Group 4: listActiveTimers() ─────────────────────────────
  describe("listActiveTimers()", () => {
    it("should return active timers for a conversation", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(
        { id: "t1", conversationId: "session-abc-123", project: "coding", username: "testuser", status: "active", createdAt: "2026-06-24T10:00:00Z" },
        { id: "t2", conversationId: "session-abc-123", project: "coding", username: "testuser", status: "active", createdAt: "2026-06-24T11:00:00Z" },
        { id: "t3", conversationId: "session-abc-123", project: "coding", username: "testuser", status: "cancelled", createdAt: "2026-06-24T12:00:00Z" }
      );

      const list = await ConversationTimerService.listActiveTimers("session-abc-123", "coding", "testuser");
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.id)).toEqual(["t1", "t2"]);
    });

    it("should return an empty array when database is unavailable", async () => {
      mockDbUnavailable = true;
      const list = await ConversationTimerService.listActiveTimers("session-abc-123", "coding", "testuser");
      expect(list).toEqual([]);
    });
  });

  // ── Group 5: tick() — daemon tick ───────────────────────────
  describe("tick() — daemon tick", () => {
    it("should fire due one-shot timer", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockFindOneAndUpdate).toHaveBeenCalled();
      expect(ConversationService.appendMessages).toHaveBeenCalled();
      expect(mockRunAgenticLoop).toHaveBeenCalled();
    });

    it("should defer execution when conversation isGenerating is true", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: true,
      });

      await ConversationTimerService.tick();

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
      expect(ConversationService.setGenerating).not.toHaveBeenCalled();
    });

    it("should fallback to model_conversations when conversation is not in agent_conversations", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.MODEL_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockFindOneAndUpdate).toHaveBeenCalled();
      expect(ConversationService.appendMessages).toHaveBeenCalledWith(
        "session-abc-123",
        "coding",
        "testuser",
        expect.any(Array),
        null,
        { collection: COLLECTIONS.MODEL_CONVERSATIONS }
      );
    });

    it("should expire timer if conversation is not found in either collection", async () => {
      const timer = { ...TIMER_FIXTURE };
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(timer);

      await ConversationTimerService.tick();

      expect(timer.status).toBe("expired");
      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
      expect(ConversationService.appendMessages).not.toHaveBeenCalled();
    });

    it("should prevent duplicate firing when claimedTimer is null", async () => {
      const timer = {
        id: "timer-claim-fail",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Run the health check",
        mode: "one_shot" as const,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        status: "active" as const,
        iterationCount: 0,
      };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(timer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      mockFindOneAndUpdate.mockResolvedValueOnce(null);

      await ConversationTimerService.tick();

      expect(ConversationService.appendMessages).not.toHaveBeenCalled();
      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });

    it("should cancel other active one-shot timers for the same conversation when a timer fires", async () => {
      const activeTimer = { ...TIMER_FIXTURE, id: "active-1" };
      const redundantTimer = { ...TIMER_FIXTURE, id: "redundant-2" };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(activeTimer, redundantTimer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          conversationId: "session-abc-123",
          project: "coding",
          username: "testuser",
          status: "active",
          mode: "one_shot",
          id: { $ne: "active-1" },
        },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "cancelled" }),
        })
      );
      expect(redundantTimer.status).toBe("cancelled");
    });

    it("should not cancel recurring timers when a one-shot timer fires", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      const updateManyFilter = mockUpdateMany.mock.calls[0][0];
      expect(updateManyFilter.mode).toBe("one_shot");
    });

    it("should not cancel timers when the conversation is currently generating (deferred)", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: true,
      });

      await ConversationTimerService.tick();

      expect(mockUpdateMany).not.toHaveBeenCalled();
      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });

    it("should handle recurring timer — checks cron match", async () => {
      vi.mocked(scheduledTaskServiceModule.matchCron).mockReturnValue(true);

      const now = new Date();
      const currentMinuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const recurringTimer: ConversationTimer = {
        id: "timer-recurring-1",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Recurring check",
        mode: "recurring" as const,
        cronExpression: "*/5 * * * *",
        iterationCount: 0,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        status: "active" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(recurringTimer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      expect(recurringTimer.iterationCount).toBe(1);
      expect(recurringTimer.status).toBe("active");
      expect(recurringTimer.lastFiredMinuteKey).toBe(currentMinuteKey);
    });

    it("should skip recurring timer when cron does not match", async () => {
      vi.mocked(scheduledTaskServiceModule.matchCron).mockReturnValue(false);

      const recurringTimer = {
        id: "timer-recurring-2",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Recurring check",
        mode: "recurring" as const,
        cronExpression: "*/5 * * * *",
        iterationCount: 0,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        status: "active" as const,
      };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(recurringTimer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
      expect(recurringTimer.iterationCount).toBe(0);
      expect(recurringTimer.status).toBe("active");

      const now = new Date();
      const nextMinute = new Date(now.getTime() + 60 * 1000);
      nextMinute.setSeconds(0, 0);
      expect(new Date(recurringTimer.firesAt).getMinutes()).toBe(nextMinute.getMinutes());
    });

    it("should skip recurring timer if already fired this minute", async () => {
      vi.mocked(scheduledTaskServiceModule.matchCron).mockReturnValue(true);

      const now = new Date();
      const currentMinuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const recurringTimer = {
        id: "timer-recurring-3",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Recurring check",
        mode: "recurring" as const,
        cronExpression: "*/5 * * * *",
        iterationCount: 1,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        lastFiredMinuteKey: currentMinuteKey,
        status: "active" as const,
      };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(recurringTimer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
      expect(recurringTimer.iterationCount).toBe(1);
    });

    it("should expire recurring timer at maxIterations", async () => {
      vi.mocked(scheduledTaskServiceModule.matchCron).mockReturnValue(true);

      const recurringTimer = {
        id: "timer-recurring-4",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Recurring check",
        mode: "recurring" as const,
        cronExpression: "*/5 * * * *",
        iterationCount: 4,
        maxIterations: 5,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        status: "active" as const,
      };

      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(recurringTimer);
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      await ConversationTimerService.tick();

      expect(mockRunAgenticLoop).toHaveBeenCalled();
      expect(recurringTimer.iterationCount).toBe(5);
      expect(recurringTimer.status).toBe("expired");
    });

    it("should catch and log error on database lookup failure in tick", async () => {
      const timer = {
        id: "timer-error",
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        prompt: "Run health check",
        mode: "one_shot" as const,
        firesAt: new Date(Date.now() - 10000).toISOString(),
        status: "active" as const,
        iterationCount: 0,
      };
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push(timer);

      mockFindOne.mockRejectedValueOnce(new Error("DB failure"));

      await expect(ConversationTimerService.tick()).resolves.not.toThrow();
    });

    it("should return early in tick when database is unavailable", async () => {
      mockDbUnavailable = true;
      await ConversationTimerService.tick();
      expect(mockFindDocuments).not.toHaveBeenCalled();
    });

    it("should catch background loop failure in tick background executor", async () => {
      mockGetDocuments(COLLECTIONS.CONVERSATION_TIMERS).push({ ...TIMER_FIXTURE });
      mockGetDocuments(COLLECTIONS.AGENT_CONVERSATIONS).push({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

      const executeSpy = vi.spyOn(ConversationTimerService, "executeAgenticLoop").mockRejectedValueOnce(new Error("Loop crash"));

      await ConversationTimerService.tick();

      expect(executeSpy).toHaveBeenCalled();
    });
  });

  // ── Group 6: executeAgenticLoop() ───────────────────────────
  describe("executeAgenticLoop()", () => {
    it("should set isGenerating=true before running the agentic loop", async () => {
      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE
      );

      const firstGeneratingCall = vi.mocked(ConversationService.setGenerating).mock.calls[0];
      expect(firstGeneratingCall[0]).toBe("session-abc-123");
      expect(firstGeneratingCall[1]).toBe("coding");
      expect(firstGeneratingCall[2]).toBe("testuser");
      expect(firstGeneratingCall[3]).toBe(true);
    });

    it("should clear isGenerating=false AFTER a successful agentic loop", async () => {
      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE
      );

      expect(ConversationService.setGenerating).toHaveBeenCalledTimes(2);

      const secondGeneratingCall = vi.mocked(ConversationService.setGenerating).mock.calls[1];
      expect(secondGeneratingCall[0]).toBe("session-abc-123");
      expect(secondGeneratingCall[3]).toBe(false);
    });

    it("should clear isGenerating=false when the agentic loop throws an error", async () => {
      mockRunAgenticLoop.mockRejectedValueOnce(
        new Error("Provider timeout")
      );

      await expect(
        ConversationTimerService.executeAgenticLoop(
          TIMER_FIXTURE,
          CONVERSATION_FIXTURE,
          REMINDER_MESSAGE
        )
      ).rejects.toThrow("Provider timeout");

      expect(ConversationService.setGenerating).toHaveBeenCalledTimes(2);

      const secondGeneratingCall = vi.mocked(ConversationService.setGenerating).mock.calls[1];
      expect(secondGeneratingCall[3]).toBe(false);
    });

    it("should not leave isGenerating stuck even if setGenerating(false) itself fails", async () => {
      vi.mocked(ConversationService.setGenerating)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("DB write failed"));

      await expect(
        ConversationTimerService.executeAgenticLoop(
          TIMER_FIXTURE,
          CONVERSATION_FIXTURE,
          REMINDER_MESSAGE
        )
      ).resolves.not.toThrow();

      expect(ConversationService.setGenerating).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ConversationService.setGenerating).mock.calls[1][3]).toBe(false);
    });

    it("should invoke AgenticLoopService with correct parameters", async () => {
      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArguments.agentConversationId).toBeTruthy();
      expect(loopArguments.agentConversationId).not.toBe("session-abc-123");
      expect(loopArguments.conversationId).toBe("session-abc-123");
      expect(loopArguments.providerName).toBe(PROVIDERS.GOOGLE);
      expect(loopArguments.resolvedModel).toBe("gemini-3-flash");
      expect(loopArguments.project).toBe("coding");
      expect(loopArguments.username).toBe("testuser");
      expect(loopArguments.options.agenticLoopEnabled).toBe(true);
      expect(loopArguments.options.functionCallingEnabled).toBe(true);
      expect(loopArguments.messages).toHaveLength(2);
      expect(loopArguments.messages[1].content).toContain("Notification");
    });

    it("should spawn agents with the exact options and settings of the parent conversation", async () => {
      const conversationWithSettings = {
        ...CONVERSATION_FIXTURE,
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3.5-flash",
          agent: "CUSTOM_DEVELOPER",
          workspaceRoot: "/custom/root",
          toolConfig: {
            availableTools: ["read_file", "write_file", "search_web"],
            disabledTools: ["search_web"],
            enabledTools: ["read_file", "write_file"],
          },
        },
      };

      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        conversationWithSettings,
        REMINDER_MESSAGE
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

      const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArguments.providerName).toBe(PROVIDERS.GOOGLE);
      expect(loopArguments.resolvedModel).toBe("gemini-3.5-flash");
      expect(loopArguments.agent).toBe("CUSTOM_DEVELOPER");
      expect(loopArguments.workspaceRoot).toBe("/custom/root");

      expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file"]);
      expect(loopArguments.options.disabledTools).toEqual(["search_web"]);

      expect(loopArguments.options.agenticLoopEnabled).toBe(true);
      expect(loopArguments.options.functionCallingEnabled).toBe(true);
    });

    it("should use agent_conversations collection for setGenerating", async () => {
      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE
      );

      for (const call of vi.mocked(ConversationService.setGenerating).mock.calls) {
        const collectionOption = call[4] as any;
        expect(collectionOption.collection).toBe(COLLECTIONS.AGENT_CONVERSATIONS);
      }
    });

    it("should throw when provider/model settings are missing", async () => {
      const invalidConversation = {
        ...CONVERSATION_FIXTURE,
        settings: {
          provider: "",
          model: "",
        },
      };

      await expect(
        ConversationTimerService.executeAgenticLoop(
          TIMER_FIXTURE,
          invalidConversation,
          REMINDER_MESSAGE
        )
      ).rejects.toThrow("Invalid model/provider settings on conversation");
    });

    it("should throw when provider is not found", async () => {
      const invalidConversation = {
        ...CONVERSATION_FIXTURE,
        settings: {
          provider: "nonexistent-provider",
          model: "some-model",
        },
      };

      vi.spyOn(providersModule, "getProvider").mockReturnValueOnce(undefined as any);

      await expect(
        ConversationTimerService.executeAgenticLoop(
          TIMER_FIXTURE,
          invalidConversation,
          REMINDER_MESSAGE
        )
      ).rejects.toThrow("LLM provider nonexistent-provider is unavailable");
    });

    it("should return early when database is unavailable in executeAgenticLoop", async () => {
      mockDbUnavailable = true;

      await ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE
      );

      expect(ConversationService.setGenerating).not.toHaveBeenCalled();
    });
  });
});
