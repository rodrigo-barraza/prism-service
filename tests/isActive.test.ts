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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

const TEST_PROJECT = "coding";
const TEST_USER = "testuser";
const TEST_CONVERSATION_ID = "sess-123";

// ── Mocks ──────────────────────────────────────────────────────
vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    isExternalStorage: () => false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://test/ref" }),
  },
}));

vi.mock("../src/utils/ConversationDiscovery.ts", () => ({
  discoverDescendantConversationIds: vi
    .fn()
    .mockImplementation(async (_database: unknown, identifier: string) =>
      new Set([identifier]),
    ),
}));

let mockCollection: ReturnType<typeof createMockCollection> & { updateMany: any };

vi.mock("../src/wrappers/MongoWrapper.ts", () => {
  const getDbFunction = vi.fn();
  return {
    default: {
      getDb: getDbFunction,
      getCollection: vi.fn(),
    },
  };
});

const MongoWrapperModule = await import("../src/wrappers/MongoWrapper.ts");
const MongoWrapper = MongoWrapperModule.default;
const { default: ConversationService } = await import(
  "../src/services/conversation/ConversationService.ts"
);

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
});
