/**
 * isActive — lifecycle field tests.
 *
 * isActive = true for the entire duration of a user turn:
 *   message received → LLM generating → tool calls → sub-agents → final reply → done
 *
 * Covers:
 * - setGenerating(true)  → isActive=true
 * - setGenerating(false) → isActive derived from pendingBackgroundTasks (pipeline)
 * - adjustPendingBackgroundTasks → isActive derived from isGenerating||count>0 (pipeline)
 * - Full non-blocking dispatch ordering: pendingBackgroundTasks incremented BEFORE
 *   setGenerating(false) so isActive never gaps to false
 * - Error paths: DB unavailable, pipeline throws
 * - Stale state: updateMany cleanup sets isActive=false alongside isGenerating/pendingBackgroundTasks
 * - run_async_task continueWorking lifecycle: a completion delivered into the
 *   OPEN turn through the TurnInputMailbox leaves the counter alone; a
 *   completion after the turn ended wakes a new turn and pays the +1 back
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

const TEST_PROJECT = "coding";
const TEST_USER = "testuser";
const TEST_CONVERSATION_ID = "sess-123";

// ── Mocks ──────────────────────────────────────────────────────
vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/services/FileService", () => ({
  default: {
    isExternalStorage: () => false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://test/ref" }),
  },
}));

// ── continueWorking lifecycle mocks ──────────────────────────
const mockExecuteTool = vi.fn();
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    executeTool: (...callArguments: unknown[]) => mockExecuteTool(...(callArguments as [])),
    executeToolStreaming: vi.fn(),
    isStreamable: () => false,
  },
}));

const mockHandleAgent = vi.fn(() => Promise.resolve());
vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: (...callArguments: unknown[]) => mockHandleAgent(...(callArguments as [])),
}));

vi.mock("#src/services/ConversationService", () => ({
  default: { appendMessages: vi.fn(() => Promise.resolve()) },
}));

vi.mock("#src/websocket/WebSocketConnectionRegistry", () => ({
  default: { getEmitFunction: () => null },
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: { isSubAgentConversation: () => false, waitForAgents: async () => [] },
}));

vi.mock("#src/utils/CleanupRegistry", () => ({ registerCleanup: vi.fn() }));

vi.mock("#src/utils/ConversationDiscovery", () => ({
  discoverDescendantConversationIds: vi
    .fn()
    .mockImplementation(async (_database: unknown, identifier: string) =>
      new Set([identifier]),
    ),
}));

let mockCollection: ReturnType<typeof createMockCollection> & { updateMany: any };

vi.mock("#src/wrappers/MongoWrapper", () => {
  const getDbFunction = vi.fn();
  return {
    default: {
      getDb: getDbFunction,
      getCollection: vi.fn(),
    },
  };
});

const MongoWrapperModule = await import("#src/wrappers/MongoWrapper");
const MongoWrapper = MongoWrapperModule.default;
const { default: ConversationService } = await import(
  "#src/services/conversation/ConversationService"
);
const { default: asyncTaskTools } = await import("#src/services/tool-definitions/AsyncTaskTools");
const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
const { default: TurnInputMailbox } = await import("#src/services/TurnInputMailbox");
const runAsyncTask = asyncTaskTools[0];

const BASE_ARGUMENTS = {
  conversationId: TEST_CONVERSATION_ID,
  project: TEST_PROJECT,
  username: TEST_USER,
};

async function seedConversation(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const document = {
    id: BASE_ARGUMENTS.conversationId,
    project: BASE_ARGUMENTS.project,
    username: BASE_ARGUMENTS.username,
    isGenerating: false,
    isActive: false,
    pendingBackgroundTasks: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  mockCollection._setData([document]);
}

async function getDocument(): Promise<Record<string, any> | null> {
  return await mockCollection.findOne({
    id: BASE_ARGUMENTS.conversationId,
    project: BASE_ARGUMENTS.project,
    username: BASE_ARGUMENTS.username,
  });
}

describe("isActive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const baseCollection = createMockCollection();
    
    // Add updateMany specific to isActive cleanup tests
    mockCollection = {
      ...baseCollection,
      updateMany: async (filter: any, update: any) => {
        const setFields = update.$set || {};
        let modifiedCount = 0;
        for (const doc of (baseCollection as any)._docs.values()) {
          let matches = true;
          for (const [key, val] of Object.entries(filter)) {
            if (val && typeof val === "object" && "$gt" in (val as any)) {
              if (!((doc[key] || 0) > (val as any).$gt)) matches = false;
            } else if (doc[key] !== val) {
              matches = false;
            }
          }
          if (matches) {
            Object.assign(doc, setFields);
            modifiedCount++;
          }
        }
        return { modifiedCount };
      }
    } as any;

    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => mockCollection,
    } as unknown as ReturnType<typeof MongoWrapper.getDb>);
  });

  // ── setGenerating ──────────────────────────────────────────────

  describe("setGenerating(true)", () => {
    it("sets isActive=true on existing document", async () => {
      await seedConversation({ isGenerating: false, isActive: false });

      await ConversationService.setGenerating(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        true,
      );

      const document = await getDocument();
      expect(document?.isGenerating).toBe(true);
      expect(document?.isActive).toBe(true);
    });

    it("sets isActive=true on upsert (new conversation stub)", async () => {
      await ConversationService.setGenerating(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        true,
        { collection: "agent_conversations" },
      );

      const document = await getDocument();
      expect(document?.isGenerating).toBe(true);
      expect(document?.isActive).toBe(true);
    });
  });

  describe("setGenerating(false)", () => {
    it("sets isActive=false when pendingBackgroundTasks is 0", async () => {
      await seedConversation({
        isGenerating: true,
        isActive: true,
        pendingBackgroundTasks: 0,
      });

      await ConversationService.setGenerating(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        false,
      );

      const document = await getDocument();
      expect(document?.isGenerating).toBe(false);
      expect(document?.isActive).toBe(false);
    });

    it("keeps isActive=true when pendingBackgroundTasks > 0 (sub-agents still running)", async () => {
      await seedConversation({
        isGenerating: true,
        isActive: true,
        pendingBackgroundTasks: 2,
      });

      await ConversationService.setGenerating(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        false,
      );

      const document = await getDocument();
      expect(document?.isGenerating).toBe(false);
      expect(document?.isActive).toBe(true);
    });
  });

  // ── adjustPendingBackgroundTasks ───────────────────────────────

  describe("adjustPendingBackgroundTasks", () => {
    it("sets isActive=true when incrementing from 0 with isGenerating=false", async () => {
      await seedConversation({ isGenerating: false, isActive: false, pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
      expect(document?.isActive).toBe(true);
    });

    it("sets isActive=false when decrement brings count to 0 and isGenerating=false", async () => {
      await seedConversation({ isGenerating: false, isActive: true, pendingBackgroundTasks: 1 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });
  });

  // ── Full turn arc ──────────────────────────────────────────────

  describe("full non-blocking dispatch lifecycle", () => {
    it("isActive stays true throughout the entire arc with correct ordering", async () => {
      await seedConversation({ isGenerating: false, isActive: false });

      // 1. Turn starts
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, true);
      let document = await getDocument();
      expect(document?.isActive).toBe(true);

      // 2. Sub-agents dispatched — increment BEFORE finalize
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);
      document = await getDocument();
      expect(document?.isActive).toBe(true);

      // 3. finalize() fires — setGenerating(false)
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, false);
      document = await getDocument();
      expect(document?.isActive).toBe(true); // no gap!

      // 4. Sub-agents complete
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1);
      document = await getDocument();
      expect(document?.isActive).toBe(false);
    });
  });

  // ── Stale cleanup (updateMany path) ───────────────────────────

  describe("stale flag cleanup (updateMany simulation)", () => {
    it("clears isActive when updateMany clears stale isGenerating flags", async () => {
      const staleDocument = {
        id: "stale-conv-001",
        project: BASE_ARGUMENTS.project,
        username: BASE_ARGUMENTS.username,
        isGenerating: true,
        isActive: true,
        pendingBackgroundTasks: 0,
      };
      mockCollection._setData([staleDocument]);

      await mockCollection.updateMany(
        { isGenerating: true },
        { $set: { isGenerating: false, isActive: false } },
      );

      const document = await mockCollection.findOne({ id: "stale-conv-001" });
      expect(document?.isGenerating).toBe(false);
      expect(document?.isActive).toBe(false);
    });

    it("clears isActive when updateMany clears stale pendingBackgroundTasks counters", async () => {
      const staleDocument = {
        id: "stale-conv-002",
        project: BASE_ARGUMENTS.project,
        username: BASE_ARGUMENTS.username,
        isGenerating: false,
        isActive: true,
        pendingBackgroundTasks: 3,
      };
      mockCollection._setData([staleDocument]);

      await mockCollection.updateMany(
        { pendingBackgroundTasks: { $gt: 0 } },
        { $set: { pendingBackgroundTasks: 0, isActive: false } },
      );

      const document = await mockCollection.findOne({ id: "stale-conv-002" });
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });
  });

  // ── run_async_task continueWorking lifecycle ──────────────────

  describe("continueWorking async task lifecycle", () => {
    const toolContext = {
      agentConversationId: TEST_CONVERSATION_ID,
      conversationId: TEST_CONVERSATION_ID,
      project: TEST_PROJECT,
      username: TEST_USER,
    };

    function deferExecution() {
      let resolve!: (value: unknown) => void;
      mockExecuteTool.mockReturnValueOnce(new Promise<unknown>((innerResolve) => { resolve = innerResolve; }));
      return { resolve };
    }

    beforeEach(async () => {
      AsyncTaskRegistry.clear();
      TurnInputMailbox._clearAll();
      mockHandleAgent.mockClear();
      mockExecuteTool.mockReset();
      // The auto-response path looks the conversation up by agentConversationId
      // through getCollection; route it to the same in-memory collection.
      vi.mocked(MongoWrapper.getCollection).mockReturnValue(mockCollection as any);
      await seedConversation({
        agentConversationId: TEST_CONVERSATION_ID,
        messages: [{ role: "user", content: "start" }],
        settings: { provider: "google", model: "gemini-3-flash-preview" },
      });
    });

    it("delivers a completion into the OPEN turn via the mailbox and leaves the counter untouched", async () => {
      // 1. Turn starts — the loop opens the mailbox.
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, true);
      TurnInputMailbox.open(TEST_CONVERSATION_ID);

      // 2. The model dispatches with continueWorking and keeps its turn.
      const { resolve } = deferExecution();
      const dispatch = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "make" }, continueWorking: true },
        toolContext,
      );
      expect(dispatch).toHaveProperty("_directive", "DETACHED_WORK");

      // 3. The task completes while the turn is still open.
      resolve({ output: "built" });
      await vi.waitFor(() => {
        expect(TurnInputMailbox.pendingCount(TEST_CONVERSATION_ID)).toBe(1);
      });
      const [entry] = TurnInputMailbox.drain(TEST_CONVERSATION_ID);
      expect(entry.kind).toBe("task_completion");
      expect(entry.text).toContain("built");

      // 4. No new turn, no counter movement: the harness never +1s for work
      //    that finished before the turn ended.
      let document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(mockHandleAgent).not.toHaveBeenCalled();

      // 5. Turn ends normally.
      TurnInputMailbox.close(TEST_CONVERSATION_ID);
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, false);
      document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });

    it("wakes a new turn and decrements the counter when the task completes after the turn ended", async () => {
      // 1. Turn starts; dispatch with continueWorking.
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, true);
      TurnInputMailbox.open(TEST_CONVERSATION_ID);
      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "make" }, continueWorking: true },
        toolContext,
      );
      const [taskState] = AsyncTaskRegistry.listTasks(TEST_CONVERSATION_ID);

      // 2. Turn ends with the task STILL running — the harness does exactly
      //    this: +1 (before setGenerating(false)), then the mailbox closes.
      expect(AsyncTaskRegistry.countRunningTasks(TEST_CONVERSATION_ID)).toBe(1);
      await ConversationService.adjustPendingBackgroundTasks(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, 1);
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, false);
      TurnInputMailbox.close(TEST_CONVERSATION_ID);
      let document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
      expect(document?.isActive).toBe(true); // awaiting background work

      // 3. The task completes → no open turn → auto-response wakes a new one.
      resolve({ output: "late" });
      await vi.waitFor(() => {
        expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      });
      expect(TurnInputMailbox.openCount).toBe(0);
      expect(taskState.deliveredVia).toBe("auto_response");

      // 4. The auto-response's finally pays the +1 back → idle again.
      await vi.waitFor(async () => {
        const fresh = await getDocument();
        expect(fresh?.pendingBackgroundTasks).toBe(0);
      });
      document = await getDocument();
      expect(document?.isActive).toBe(false);
    });

    it("pays the +1 back when a task counted at turn end completes during a LATER open turn", async () => {
      // 1. Turn N: dispatch with continueWorking; turn ends with it running.
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, true);
      TurnInputMailbox.open(TEST_CONVERSATION_ID);
      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "make" }, continueWorking: true },
        toolContext,
      );
      const [taskState] = AsyncTaskRegistry.listTasks(TEST_CONVERSATION_ID);
      // The harness does exactly this at loop end: +1, then marks the running tasks.
      await ConversationService.adjustPendingBackgroundTasks(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, 1);
      expect(AsyncTaskRegistry.markRunningAsCounted(TEST_CONVERSATION_ID)).toBe(1);
      expect(taskState.countedAsPending).toBe(true);
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, false);
      TurnInputMailbox.close(TEST_CONVERSATION_ID);
      expect((await getDocument())?.pendingBackgroundTasks).toBe(1);

      // 2. The user starts turn N+1 (the loop opens the mailbox again).
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, true);
      TurnInputMailbox.open(TEST_CONVERSATION_ID);

      // 3. The task completes now → delivered into turn N+1 via the mailbox …
      resolve({ output: "eventually" });
      await vi.waitFor(() => {
        expect(TurnInputMailbox.pendingCount(TEST_CONVERSATION_ID)).toBe(1);
      });
      expect(taskState.deliveredVia).toBe("mailbox");
      expect(mockHandleAgent).not.toHaveBeenCalled();

      // 4. … and turn N's +1 is paid back, once, so the conversation goes
      //    idle when turn N+1 ends instead of sticking on "awaiting tasks".
      await vi.waitFor(async () => {
        expect((await getDocument())?.pendingBackgroundTasks).toBe(0);
      });
      expect(taskState.countedAsPending).toBe(false);
      TurnInputMailbox.close(TEST_CONVERSATION_ID);
      await ConversationService.setGenerating(TEST_CONVERSATION_ID, TEST_PROJECT, TEST_USER, false);
      expect((await getDocument())?.isActive).toBe(false);
    });
  });
});
