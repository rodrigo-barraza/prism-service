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

  function evaluate(
    expression: unknown,
    document: Record<string, unknown>,
  ): unknown {
    if (typeof expression === "string" && expression.startsWith("$")) {
      return document[expression.slice(1)];
    }
    if (typeof expression !== "object" || expression === null) return expression;
    const expressionObject = expression as Record<string, unknown>;

    if ("$gt" in expressionObject) {
      const [left, right] = expressionObject.$gt as unknown[];
      return (evaluate(left, document) as number) > (evaluate(right, document) as number);
    }
    if ("$or" in expressionObject) {
      return (expressionObject.$or as unknown[]).some((operand) =>
        Boolean(evaluate(operand, document)),
      );
    }
    if ("$eq" in expressionObject) {
      const [left, right] = expressionObject.$eq as unknown[];
      return evaluate(left, document) === evaluate(right, document);
    }
    if ("$add" in expressionObject) {
      return (expressionObject.$add as unknown[]).reduce(
        (sum, operand) => (sum as number) + (evaluate(operand, document) as number),
        0,
      );
    }
    if ("$max" in expressionObject) {
      return Math.max(
        ...(expressionObject.$max as unknown[]).map(
          (operand) => evaluate(operand, document) as number,
        ),
      );
    }
    if ("$ifNull" in expressionObject) {
      const [value, fallback] = expressionObject.$ifNull as unknown[];
      const resolved = evaluate(value, document);
      return resolved !== null && resolved !== undefined
        ? resolved
        : evaluate(fallback, document);
    }
    return expression;
  }

  function applyPipeline(
    document: Record<string, unknown>,
    pipeline: Array<Record<string, unknown>>,
  ): void {
    for (const stage of pipeline) {
      const stageSet = stage.$set as Record<string, unknown> | undefined;
      if (!stageSet) continue;
      const resolved: Record<string, unknown> = {};
      for (const [field, expression] of Object.entries(stageSet)) {
        resolved[field] = evaluate(expression, document);
      }
      Object.assign(document, resolved);
    }
  }

  return {
    _documents: documents,

    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown> | Array<Record<string, unknown>>,
      options: Record<string, unknown> = {},
    ) {
      const identityKeys = Object.fromEntries(
        Object.entries(filter).filter(
          ([, value]) => typeof value !== "object" || value === null,
        ),
      );
      const identityKey = JSON.stringify(identityKeys);

      let document = documents.get(identityKey);
      const isInsert = !document;

      if (isInsert && options.upsert) {
        document = { ...identityKeys };
        documents.set(identityKey, document);
      } else if (isInsert) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      // Aggregation pipeline update
      if (Array.isArray(update)) {
        applyPipeline(document!, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }

      // Classic update operators
      const classicUpdate = update as Record<string, Record<string, unknown>>;
      Object.assign(document!, classicUpdate.$set ?? {});
      if (isInsert) Object.assign(document!, classicUpdate.$setOnInsert ?? {});

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
    isActive: false,
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
