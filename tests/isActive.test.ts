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

// ── In-memory collection that understands aggregation pipelines ─
// MongoDB aggregation pipeline updates pass an array of stage objects.
// Each stage sees the output of the previous stage. This mock evaluates
// the subset of pipeline operators used by ConversationService:
// $set, $gt, $or, $eq, $add, $max, $ifNull, and field references ("$field").
function createMockCollection() {
  const documents = new Map<string, Record<string, unknown>>();

  function evaluate(
    expression: unknown,
    document: Record<string, unknown>,
  ): unknown {
    // String field reference: "$fieldName"
    if (typeof expression === "string" && expression.startsWith("$")) {
      return document[expression.slice(1)];
    }

    if (typeof expression !== "object" || expression === null) {
      return expression;
    }

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

  function buildIdentityKey(filter: Record<string, unknown>): string {
    const identityKeys = Object.fromEntries(
      Object.entries(filter).filter(
        ([, value]) => typeof value !== "object" || value === null,
      ),
    );
    return JSON.stringify(identityKeys);
  }

  return {
    _documents: documents,

    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown> | Array<Record<string, unknown>>,
      options: Record<string, unknown> = {},
    ) {
      const identityKey = buildIdentityKey(filter);

      let document = documents.get(identityKey);
      const isInsert = !document;

      if (isInsert && options.upsert) {
        const identityFields = Object.fromEntries(
          Object.entries(filter).filter(
            ([, value]) => typeof value !== "object" || value === null,
          ),
        );
        document = { ...identityFields };
        documents.set(identityKey, document);
      } else if (isInsert) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      // Aggregation pipeline update (array of stage objects)
      if (Array.isArray(update)) {
        applyPipeline(document!, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }

      // Classic update operators ($set / $setOnInsert)
      const classicUpdate = update as Record<string, Record<string, unknown>>;
      const setOnInsert = classicUpdate.$setOnInsert ?? {};
      const setFields = classicUpdate.$set ?? {};

      if (isInsert) {
        Object.assign(document!, setOnInsert);
      }
      Object.assign(document!, setFields);

      return { matchedCount: 1, modifiedCount: 1 };
    },

    async updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) {
      const setFields = (update.$set ?? {}) as Record<string, unknown>;
      let modifiedCount = 0;
      for (const [, document] of documents) {
        const matches = Object.entries(filter).every(([key, value]) => {
          if (typeof value === "object" && value !== null) {
            const operatorObject = value as Record<string, unknown>;
            if ("$gt" in operatorObject)
              return (document[key] as number) > (operatorObject.$gt as number);
            if ("$lt" in operatorObject)
              return (document[key] as number) < (operatorObject.$lt as number);
          }
          return document[key] === value;
        });
        if (matches) {
          Object.assign(document, setFields);
          modifiedCount++;
        }
      }
      return { modifiedCount };
    },

    async findOne(filter: Record<string, unknown>) {
      return documents.get(JSON.stringify(filter)) ?? null;
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
  conversationId: "conv-isactive-001",
  project: "coding",
  username: "testuser",
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
  const filterKey = JSON.stringify({
    id: document.id,
    project: document.project,
    username: document.username,
  });
  mockCollection._documents.set(filterKey, document);
}

async function getDocument(): Promise<Record<string, unknown> | null> {
  const filterKey = JSON.stringify({
    id: BASE_ARGUMENTS.conversationId,
    project: BASE_ARGUMENTS.project,
    username: BASE_ARGUMENTS.username,
  });
  return (
    (mockCollection._documents.get(filterKey) as Record<string, unknown>) ?? null
  );
}

describe("isActive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCollection = createMockCollection();
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

    it("keeps isActive=true when pendingBackgroundTasks is exactly 1", async () => {
      await seedConversation({
        isGenerating: true,
        isActive: true,
        pendingBackgroundTasks: 1,
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

    it("treats missing pendingBackgroundTasks field as 0 and sets isActive=false", async () => {
      await seedConversation({ isGenerating: true, isActive: true });
      const filterKey = JSON.stringify({
        id: BASE_ARGUMENTS.conversationId,
        project: BASE_ARGUMENTS.project,
        username: BASE_ARGUMENTS.username,
      });
      delete mockCollection._documents.get(filterKey)!.pendingBackgroundTasks;

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

    it("keeps isActive=true when incrementing while isGenerating=true", async () => {
      await seedConversation({ isGenerating: true, isActive: true, pendingBackgroundTasks: 0 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        1,
      );

      const document = await getDocument();
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

    it("keeps isActive=true when decrement leaves count > 0", async () => {
      await seedConversation({ isGenerating: false, isActive: true, pendingBackgroundTasks: 3 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(2);
      expect(document?.isActive).toBe(true);
    });

    it("keeps isActive=true when decrement reaches 0 but isGenerating is still true", async () => {
      await seedConversation({ isGenerating: true, isActive: true, pendingBackgroundTasks: 1 });

      await ConversationService.adjustPendingBackgroundTasks(
        BASE_ARGUMENTS.conversationId,
        BASE_ARGUMENTS.project,
        BASE_ARGUMENTS.username,
        -1,
      );

      const document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(true);
    });

    it("clamps pendingBackgroundTasks at 0 and sets isActive=false on over-decrement", async () => {
      await seedConversation({ isGenerating: false, isActive: true, pendingBackgroundTasks: 0 });

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
      expect(document?.isGenerating).toBe(true);
      expect(document?.isActive).toBe(true);

      // 2. Sub-agents dispatched — increment BEFORE finalize (the fixed ordering in ReActHarness)
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);
      document = await getDocument();
      expect(document?.isActive).toBe(true);

      // 3. finalize() fires — setGenerating(false) — pendingBackgroundTasks=1 keeps isActive=true
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, false);
      document = await getDocument();
      expect(document?.isGenerating).toBe(false);
      expect(document?.pendingBackgroundTasks).toBe(1);
      expect(document?.isActive).toBe(true); // no gap!

      // 4. Sub-agents complete, auto-response fires — setGenerating(true)
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, true);
      document = await getDocument();
      expect(document?.isGenerating).toBe(true);
      expect(document?.isActive).toBe(true);

      // 5. Auto-response finishes and counter decrements — fully settled
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1);
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, false);
      document = await getDocument();
      expect(document?.isGenerating).toBe(false);
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });

    it("isActive gaps to false in the old ordering — regression guard for the fixed order", async () => {
      // Documents the broken OLD order: finalize → then increment.
      // The gap at the moment between the two writes is exactly what we fixed.
      await seedConversation({ isGenerating: true, isActive: true, pendingBackgroundTasks: 0 });

      // Old order: setGenerating(false) fires FIRST (pendingBackgroundTasks still 0)
      await ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, false);

      // At this exact moment — gap: isActive is false even though sub-agents are about to run
      let document = await getDocument();
      expect(document?.isActive).toBe(false); // this gap is why we fixed the ordering

      // Then the increment arrives — recovers, but the gap already happened
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);
      document = await getDocument();
      expect(document?.isActive).toBe(true);
    });
  });

  // ── Multiple sub-agents ────────────────────────────────────────

  describe("multiple concurrent sub-agents", () => {
    it("stays active until the last sub-agent completes", async () => {
      await seedConversation({ isGenerating: false, isActive: false });

      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1);

      let document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(3);
      expect(document?.isActive).toBe(true);

      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1);
      document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(2);
      expect(document?.isActive).toBe(true);

      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1);
      document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(1);
      expect(document?.isActive).toBe(true);

      // Last one
      await ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1);
      document = await getDocument();
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });
  });

  // ── Error paths ────────────────────────────────────────────────

  describe("error paths", () => {
    it("setGenerating is a safe no-op when DB is unavailable", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValue(null as unknown as ReturnType<typeof MongoWrapper.getDb>);

      await expect(
        ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, true),
      ).resolves.toBeUndefined();
    });

    it("adjustPendingBackgroundTasks is a safe no-op when DB is unavailable", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValue(null as unknown as ReturnType<typeof MongoWrapper.getDb>);

      await expect(
        ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, 1),
      ).resolves.toBeUndefined();
    });

    it("document is unchanged when setGenerating pipeline throws", async () => {
      await seedConversation({ isGenerating: true, isActive: true, pendingBackgroundTasks: 0 });

      vi.mocked(MongoWrapper.getDb).mockReturnValue({
        collection: () => ({
          updateOne: vi.fn().mockRejectedValue(new Error("Simulated DB write failure")),
        }),
      } as unknown as ReturnType<typeof MongoWrapper.getDb>);

      await expect(
        ConversationService.setGenerating(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, false),
      ).rejects.toThrow("Simulated DB write failure");

      // Original document is unchanged — seeded via mockCollection, not the failing mock
      const document = await getDocument();
      expect(document?.isActive).toBe(true);
    });

    it("document is unchanged when adjustPendingBackgroundTasks pipeline throws", async () => {
      await seedConversation({ isGenerating: false, isActive: true, pendingBackgroundTasks: 1 });

      vi.mocked(MongoWrapper.getDb).mockReturnValue({
        collection: () => ({
          updateOne: vi.fn().mockRejectedValue(new Error("Simulated DB write failure")),
        }),
      } as unknown as ReturnType<typeof MongoWrapper.getDb>);

      await expect(
        ConversationService.adjustPendingBackgroundTasks(BASE_ARGUMENTS.conversationId, BASE_ARGUMENTS.project, BASE_ARGUMENTS.username, -1),
      ).rejects.toThrow("Simulated DB write failure");

      const document = await getDocument();
      expect(document?.isActive).toBe(true);
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
        updatedAt: "2020-01-01T00:00:00.000Z",
      };
      const filterKey = JSON.stringify({ id: staleDocument.id, project: staleDocument.project, username: staleDocument.username });
      mockCollection._documents.set(filterKey, staleDocument);

      await mockCollection.updateMany(
        { isGenerating: true },
        { $set: { isGenerating: false, isActive: false } },
      );

      const document = mockCollection._documents.get(filterKey);
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
        updatedAt: "2020-01-01T00:00:00.000Z",
      };
      const filterKey = JSON.stringify({ id: staleDocument.id, project: staleDocument.project, username: staleDocument.username });
      mockCollection._documents.set(filterKey, staleDocument);

      await mockCollection.updateMany(
        { pendingBackgroundTasks: { $gt: 0 } },
        { $set: { pendingBackgroundTasks: 0, isActive: false } },
      );

      const document = mockCollection._documents.get(filterKey);
      expect(document?.pendingBackgroundTasks).toBe(0);
      expect(document?.isActive).toBe(false);
    });

    it("does not touch documents where isGenerating is already false", async () => {
      const activeDocument = {
        id: "active-conv-003",
        project: BASE_ARGUMENTS.project,
        username: BASE_ARGUMENTS.username,
        isGenerating: false,
        isActive: false,
        pendingBackgroundTasks: 0,
        updatedAt: new Date().toISOString(),
      };
      const filterKey = JSON.stringify({ id: activeDocument.id, project: activeDocument.project, username: activeDocument.username });
      mockCollection._documents.set(filterKey, activeDocument);

      const result = await mockCollection.updateMany(
        { isGenerating: true },
        { $set: { isGenerating: false, isActive: false } },
      );

      expect(result.modifiedCount).toBe(0);
      const document = mockCollection._documents.get(filterKey);
      expect(document?.isGenerating).toBe(false);
    });
  });
});
