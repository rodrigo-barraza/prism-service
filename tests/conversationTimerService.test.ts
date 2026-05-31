/**
 * ConversationTimerService — isGenerating lifecycle regression tests.
 *
 * Root cause: executeAgenticLoop() set isGenerating=true before calling
 * AgenticLoopService.runAgenticLoop(), but only cleared it in the catch
 * block (error path). On a successful run the conversation document was
 * permanently stuck with isGenerating: true, causing the client UI to
 * display "Starting..." indefinitely.
 *
 * Fix: the cleanup was moved to a `finally` block so it executes on both
 * success and error paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config ────────────────────────────────────────────────
vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  getModelByName: vi.fn().mockReturnValue({
    name: "test-model",
    provider: "google",
    contextLength: 128_000,
  }),
}));

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

// ── Mock ScheduledTaskService ──────────────────────────────────
vi.mock("../src/services/ScheduledTaskService.ts", () => ({
  matchCron: vi.fn().mockReturnValue(false),
}));

// ── Track ConversationService.setGenerating calls ──────────────
const mockSetGenerating = vi.fn().mockResolvedValue(undefined);
const mockAppendMessages = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    setGenerating: (...args: unknown[]) => mockSetGenerating(...args),
    appendMessages: (...args: unknown[]) => mockAppendMessages(...args),
  },
}));

// ── Mock AgenticLoopService ────────────────────────────────────
const mockRunAgenticLoop = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// ── Mock providers ─────────────────────────────────────────────
vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockReturnValue({
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  }),
}));

// ── Mock MongoWrapper ──────────────────────────────────────────
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockFindOneAndUpdate = vi.fn().mockResolvedValue({ id: "timer-test-001" });
const mockFindDocuments = vi.fn().mockReturnValue({
  sort: vi.fn().mockReturnValue({
    toArray: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        findOne: (...args: unknown[]) => mockFindOne(...args),
        updateOne: (...args: unknown[]) => mockUpdateOne(...args),
        updateMany: (...args: unknown[]) => mockUpdateMany(...args),
        findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
        find: (...args: unknown[]) => mockFindDocuments(...args),
        insertOne: vi.fn().mockResolvedValue({ insertedId: "test" }),
      }),
    }),
    getCollection: vi.fn(),
  },
}));

// ── Import AFTER mocks are wired ───────────────────────────────
const { default: ConversationTimerService } = await import(
  "../src/services/ConversationTimerService.ts"
);

// ── Test fixtures ──────────────────────────────────────────────
const TIMER_FIXTURE = {
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
    provider: "google",
    model: "gemini-3-flash",
  },
  isGenerating: false,
  traceId: "trace-xyz",
};

const REMINDER_MESSAGE = {
  role: "user",
  content: "🔔 Notification: Run the health check",
  timestamp: new Date().toISOString(),
};

// ═══════════════════════════════════════════════════════════════
describe("ConversationTimerService.executeAgenticLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should set isGenerating=true before running the agentic loop", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.executeAgenticLoop(
      TIMER_FIXTURE,
      CONVERSATION_FIXTURE,
      REMINDER_MESSAGE,
    );

    // First setGenerating call should be true (before the loop)
    const firstGeneratingCall = mockSetGenerating.mock.calls[0];
    expect(firstGeneratingCall[0]).toBe("session-abc-123");
    expect(firstGeneratingCall[1]).toBe("coding");
    expect(firstGeneratingCall[2]).toBe("testuser");
    expect(firstGeneratingCall[3]).toBe(true);
  });

  it("should clear isGenerating=false AFTER a successful agentic loop", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.executeAgenticLoop(
      TIMER_FIXTURE,
      CONVERSATION_FIXTURE,
      REMINDER_MESSAGE,
    );

    // Should have been called exactly twice: true (before), false (after)
    expect(mockSetGenerating).toHaveBeenCalledTimes(2);

    // Second call should be false (the finally block)
    const secondGeneratingCall = mockSetGenerating.mock.calls[1];
    expect(secondGeneratingCall[0]).toBe("session-abc-123");
    expect(secondGeneratingCall[3]).toBe(false);
  });

  it("should clear isGenerating=false when the agentic loop throws an error", async () => {
    mockRunAgenticLoop.mockRejectedValueOnce(
      new Error("Provider timeout"),
    );

    await expect(
      ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE,
      ),
    ).rejects.toThrow("Provider timeout");

    // Should still have called setGenerating(false) via the finally block
    expect(mockSetGenerating).toHaveBeenCalledTimes(2);

    const secondGeneratingCall = mockSetGenerating.mock.calls[1];
    expect(secondGeneratingCall[3]).toBe(false);
  });

  it("should not leave isGenerating stuck even if setGenerating(false) itself fails", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);
    // First call (true) succeeds, second call (false) rejects
    mockSetGenerating
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DB write failed"));

    // Should NOT throw — the .catch(() => {}) swallows the setGenerating error
    await expect(
      ConversationTimerService.executeAgenticLoop(
        TIMER_FIXTURE,
        CONVERSATION_FIXTURE,
        REMINDER_MESSAGE,
      ),
    ).resolves.not.toThrow();

    // Verify setGenerating(false) was still attempted
    expect(mockSetGenerating).toHaveBeenCalledTimes(2);
    expect(mockSetGenerating.mock.calls[1][3]).toBe(false);
  });

  it("should invoke AgenticLoopService with correct parameters", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.executeAgenticLoop(
      TIMER_FIXTURE,
      CONVERSATION_FIXTURE,
      REMINDER_MESSAGE,
    );

    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

    const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
    expect(loopArguments.agentSessionId).toBe("session-abc-123");
    expect(loopArguments.providerName).toBe("google");
    expect(loopArguments.resolvedModel).toBe("gemini-3-flash");
    expect(loopArguments.project).toBe("coding");
    expect(loopArguments.username).toBe("testuser");
    expect(loopArguments.options.agenticLoopEnabled).toBe(true);
    expect(loopArguments.options.functionCallingEnabled).toBe(true);
    // Messages should include existing conversation + reminder
    expect(loopArguments.messages).toHaveLength(2);
    expect(loopArguments.messages[1].content).toContain("Notification");
  });

  it("should spawn agents with the exact options and settings of the parent conversation", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    const conversationWithSettings = {
      ...CONVERSATION_FIXTURE,
      settings: {
        provider: "google",
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
      REMINDER_MESSAGE,
    );

    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

    const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
    expect(loopArguments.providerName).toBe("google");
    expect(loopArguments.resolvedModel).toBe("gemini-3.5-flash");
    expect(loopArguments.agent).toBe("CUSTOM_DEVELOPER");
    expect(loopArguments.workspaceRoot).toBe("/custom/root");
    
    // Verify the enabledTools from toolConfig are passed exactly
    expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file"]);
    
    // Ensure base defaults like agenticLoopEnabled are still preserved
    expect(loopArguments.options.agenticLoopEnabled).toBe(true);
    expect(loopArguments.options.functionCallingEnabled).toBe(true);
  });

  it("should use agent_conversations collection for setGenerating", async () => {
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.executeAgenticLoop(
      TIMER_FIXTURE,
      CONVERSATION_FIXTURE,
      REMINDER_MESSAGE,
    );

    // Both setGenerating calls should target agent_conversations
    for (const call of mockSetGenerating.mock.calls) {
      const collectionOption = call[4];
      expect(collectionOption.collection).toBe("agent_conversations");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationTimerService.tick — isGenerating lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should defer execution when conversation isGenerating is true", async () => {
    // Mock: find one due timer
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    // Mock: conversation is currently generating
    mockFindOne.mockResolvedValueOnce({
      ...CONVERSATION_FIXTURE,
      isGenerating: true,
    });

    await ConversationTimerService.tick();

    // AgenticLoopService should NOT have been called (deferred)
    expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    // Timer should NOT have been updated (no status change)
    expect(mockSetGenerating).not.toHaveBeenCalled();
  });

  it("should fire timer when conversation isGenerating is false", async () => {
    // Mock: find one due timer
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    // Mock: conversation is NOT generating
    mockFindOne.mockResolvedValueOnce({
      ...CONVERSATION_FIXTURE,
      isGenerating: false,
    });

    // Mock: timer update succeeds
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    // Mock: agentic loop succeeds
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.tick();

    // Timer status should have been updated to "fired"
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
    // Reminder message should have been appended
    expect(mockAppendMessages).toHaveBeenCalled();
  });

  it("should fallback to model_conversations when conversation is not in agent_conversations", async () => {
    // Mock: find one due timer
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    // Mock: agent_conversations findOne returns null, but model_conversations findOne succeeds
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...CONVERSATION_FIXTURE,
        isGenerating: false,
      });

    // Mock: timer update succeeds
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    // Mock: agentic loop succeeds
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.tick();

    // Timer status should have been updated to "fired"
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
    
    // Reminder message should have been appended with collection set to model_conversations
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "session-abc-123",
      "coding",
      "testuser",
      expect.any(Array),
      null,
      { collection: "model_conversations" }
    );
  });

  it("should expire timer if conversation is not found in either collection", async () => {
    // Mock: find one due timer
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    // Mock: both agent_conversations and model_conversations lookups return null
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    // Mock: timer update succeeds
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await ConversationTimerService.tick();

    // Should have updated timer status to "expired"
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { id: "timer-test-001" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "expired"
        })
      })
    );

    // Should NOT have run agentic loop or appended messages
    expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    expect(mockAppendMessages).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationTimerService.tick — redundant wake-up prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should cancel other active one-shot timers for the same conversation when a timer fires", async () => {
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    mockFindOne.mockResolvedValueOnce({
      ...CONVERSATION_FIXTURE,
      isGenerating: false,
    });

    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.tick();

    // Verify updateMany was called with the redundant wake-up prevention filter
    expect(mockUpdateMany).toHaveBeenCalledWith(
      {
        conversationId: "session-abc-123",
        project: "coding",
        username: "testuser",
        status: "active",
        mode: "one_shot",
        id: { $ne: "timer-test-001" },
      },
      {
        $set: expect.objectContaining({
          status: "cancelled",
        }),
      }
    );
  });

  it("should not cancel recurring timers when a one-shot timer fires", async () => {
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    mockFindOne.mockResolvedValueOnce({
      ...CONVERSATION_FIXTURE,
      isGenerating: false,
    });

    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    await ConversationTimerService.tick();

    // The updateMany filter explicitly targets mode: "one_shot" only,
    // so recurring crons are never touched by the auto-cancel.
    const updateManyFilter = mockUpdateMany.mock.calls[0][0];
    expect(updateManyFilter.mode).toBe("one_shot");
  });

  it("should not cancel timers when the conversation is currently generating (deferred)", async () => {
    mockFindDocuments.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([TIMER_FIXTURE]),
    });

    mockFindOne.mockResolvedValueOnce({
      ...CONVERSATION_FIXTURE,
      isGenerating: true,
    });

    await ConversationTimerService.tick();

    // Deferred — nothing should fire, no auto-cancel should occur
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockRunAgenticLoop).not.toHaveBeenCalled();
  });
});
