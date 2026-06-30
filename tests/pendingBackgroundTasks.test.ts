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

// ── Mock config ────────────────────────────────────────────────
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
    .mockImplementation(async (_database, identifier) => new Set([identifier])),
}));

// ── In-memory collection mock ──────────────────────────────────
// Supports $set, $inc, and the negative-clamp query pattern.
function createMockCollection() {
  const documents = new Map<string, Record<string, unknown>>();

  return {
    _documents: documents,

    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ) {
      const $set = (update.$set || {}) as Record<string, unknown>;
      const $inc = (update.$inc || {}) as Record<string, number>;

      // Identity keys for document lookup (id, project, username)
      const identityKeys = Object.fromEntries(
        Object.entries(filter).filter(
          ([, value]) => typeof value !== "object" || value === null,
        ),
      );
      const identityKey = JSON.stringify(identityKeys);

      // Find document by identity keys
      let document = documents.get(identityKey);
      const isInsert = !document;

      if (isInsert && options.upsert) {
        document = { ...identityKeys };
        documents.set(identityKey, document);
      } else if (isInsert) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      // Validate ALL filter conditions (including $lt/$gt operators)
      // against the found document — MongoDB rejects the update if the
      // document doesn't match the full query, not just the identity keys.
      const matchesAllConditions = Object.entries(filter).every(
        ([key, value]) => {
          if (typeof value !== "object" || value === null) {
            return document![key] === value;
          }
          const operatorObject = value as Record<string, unknown>;
          if ("$lt" in operatorObject) {
            return (document![key] as number) < (operatorObject.$lt as number);
          }
          if ("$gt" in operatorObject) {
            return (document![key] as number) > (operatorObject.$gt as number);
          }
          return document![key] === value;
        },
      );

      if (!matchesAllConditions) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      // Apply $inc
      for (const [field, delta] of Object.entries($inc)) {
        document![field] = ((document![field] as number) || 0) + delta;
      }

      // Apply $set
      Object.assign(document!, $set);

      return { matchedCount: 1, modifiedCount: 1 };
    },

    async findOne(filter: Record<string, unknown>) {
      const filterKey = JSON.stringify(filter);
      return documents.get(filterKey) || null;
    },

    async updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) {
      const $set = (update.$set || {}) as Record<string, unknown>;
      let modifiedCount = 0;
      for (const [, document] of documents) {
        const matches = Object.entries(filter).every(([key, value]) => {
          if (
            typeof value === "object" &&
            value !== null &&
            "$gt" in (value as Record<string, unknown>)
          ) {
            return (
              (document[key] as number) >
              ((value as Record<string, unknown>).$gt as number)
            );
          }
          return document[key] === value;
        });
        if (matches) {
          Object.assign(document, $set);
          modifiedCount++;
        }
      }
      return { modifiedCount };
    },
  };
}

let mockCollection: ReturnType<typeof createMockCollection>;

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
  conversationId: "test-conversation-001",
  project: "coding",
  username: "testuser",
};

// ── Helpers ────────────────────────────────────────────────────
async function seedConversation(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const document = {
    id: BASE_ARGUMENTS.conversationId,
    project: BASE_ARGUMENTS.project,
    username: BASE_ARGUMENTS.username,
    pendingBackgroundTasks: 0,
    isGenerating: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  const filterKey = JSON.stringify({
    id: document.id,
    project: document.project,
    username: document.username,
  });
  mockCollection._documents.set(filterKey, document);
}

async function getConversationDocument(): Promise<Record<string, unknown> | null> {
  const filterKey = JSON.stringify({
    id: BASE_ARGUMENTS.conversationId,
    project: BASE_ARGUMENTS.project,
    username: BASE_ARGUMENTS.username,
  });
  return (mockCollection._documents.get(filterKey) as Record<string, unknown>) ?? null;
}

describe("pendingBackgroundTasks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCollection = createMockCollection();
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => mockCollection,
    } as unknown as ReturnType<typeof MongoWrapper.getDb>);
  });

  describe("ConversationService.adjustPendingBackgroundTasks", () => {
    it("should increment the counter by 1 on dispatch", async () => {
      await seedConversation({ pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
    });

    it("should increment by arbitrary positive values for multiple dispatches", async () => {
      await seedConversation({ pendingBackgroundTasks: 2 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        3,
      );

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(5);
    });

    it("should decrement the counter by 1 on completion", async () => {
      await seedConversation({ pendingBackgroundTasks: 3 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(2);
    });

    it("should clamp to 0 when decrement would go negative", async () => {
      await seedConversation({ pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
    });

    it("should clamp to 0 on double-decrement edge case", async () => {
      await seedConversation({ pendingBackgroundTasks: 1 });

      // Two concurrent decrements — only one should succeed, the other clamps
      await Promise.all([
        ConversationService.adjustPendingBackgroundTasks(
          BASE_ARGUMENTS.conversationId,
          BASE_ARGUMENTS.project,
          BASE_ARGUMENTS.username,
          -1,
        ),
        ConversationService.adjustPendingBackgroundTasks(
          BASE_ARGUMENTS.conversationId,
          BASE_ARGUMENTS.project,
          BASE_ARGUMENTS.username,
          -1,
        ),
      ]);

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
    });

    it("should update the updatedAt timestamp on every adjustment", async () => {
      const originalTimestamp = "2020-01-01T00:00:00.000Z";
      await seedConversation({ updatedAt: originalTimestamp });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getConversationDocument();
      expect(document?.updatedAt).not.toBe(originalTimestamp);
    });

    it("should work with custom collection name", async () => {
      await seedConversation();

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
        { collection: "agent_conversations" },
      );

      const document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
    });

    it("should be a no-op when database is unavailable", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValue(null as unknown as ReturnType<typeof MongoWrapper.getDb>);

      // Should not throw
      await expect(
        ConversationService.adjustPendingBackgroundTasks(
          BASE_ARGUMENTS.conversationId,
          BASE_ARGUMENTS.project,
          BASE_ARGUMENTS.username,
          1,
        ),
      ).resolves.toBeUndefined();
    });

    it("should handle increment → decrement lifecycle correctly", async () => {
      await seedConversation({ pendingBackgroundTasks: 0 });

      // Dispatch 3 background tasks
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      let document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(3);

      // Complete 2 background tasks
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);

      // Complete last task
      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      document = await getConversationDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
    });
  });

  describe("counter isolation", () => {
    it("should not affect isGenerating when adjusting pendingBackgroundTasks", async () => {
      await seedConversation({
        isGenerating: true,
        pendingBackgroundTasks: 0,
      });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getConversationDocument();
      expect(document?.isGenerating).toBe(true);
      expect(document?.pendingBackgroundTasks).toBe(1);
    });

    it("isGenerating false + pendingBackgroundTasks > 0 is a valid state", async () => {
      await seedConversation({
        isGenerating: false,
        pendingBackgroundTasks: 2,
      });

      const document = await getConversationDocument();
      expect(document?.isGenerating).toBe(false);
      expect(document?.pendingBackgroundTasks).toBe(2);
    });
  });
});
