/**
 * pendingBackgroundTasks — Tests for the atomic counter that tracks
 * in-flight async tool work (sub-agents, long-running tools, etc.)
 * on agent_conversations documents.
 *
 * Covers:
 * - ConversationService.adjustPendingBackgroundTasks (increment/decrement/clamp)
 * - BackgroundHousekeepingService stale counter cleanup
 * - ReActHarness non-blocking dispatch flow (mocked)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

const TEST_PROJECT = "coding";
const TEST_USER = "testuser";
const TEST_CONVERSATION_ID = "sess-123";

// ── Mock config ────────────────────────────────────────────────
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

vi.mock("#src/utils/ConversationDiscovery", () => ({
  discoverDescendantConversationIds: vi
    .fn()
    .mockImplementation(async (_database, identifier) => new Set([identifier])),
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

describe("pendingBackgroundTasks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const baseCollection = createMockCollection();
    
    // Add updateMany specific to housekeeping cleanup tests
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

  describe("adjustPendingBackgroundTasks", () => {
    it("increments the counter atomically", async () => {
      await seedConversation({ pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
    });

    it("decrements the counter atomically", async () => {
      await seedConversation({ pendingBackgroundTasks: 5 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(4);
    });

    it("clamps the counter at 0 (never negative)", async () => {
      await seedConversation({ pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
    });
  });
});
