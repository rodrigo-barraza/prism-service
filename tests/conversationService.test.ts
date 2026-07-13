/**
 * ConversationService.appendMessages — $set/$setOnInsert path conflict regression tests.
 *
 * Root cause: MongoDB throws `MongoServerError: Updating the path 'X' would
 * create a conflict at 'X'` when the same field appears in both $set and
 * $setOnInsert within a single updateOne. This broke all agent session
 * persistence when conversationMeta included a title (which is always the
 * case for the Coding Agent).
 *
 * These tests exercise appendMessages with an in-memory mock collection
 * that enforces the same constraint MongoDB does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_PROJECT, TEST_USER, TEST_CONVERSATION_ID } from "./setup.ts";
import { COLLECTIONS, PROVIDERS } from "#src/constants";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import {
  extractFiles,
  computeModalities,
  extractProviders,
  computeTotalCost,
  buildConversationPatchFields,
  enrichConversationsWithRequestCosts,
  enrichSingleConversationCost,
} from "#src/services/conversation/utils";


// ── Mock config ────────────────────────────────────────────────
vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

// ── Mock FileService (no MinIO in tests) ───────────────────────
vi.mock("#src/services/FileService", () => ({
  default: {
    isExternalStorage: () => (globalThis as any).isExternalStorageMockValue ?? false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockImplementation(async () => {
      if ((globalThis as any).uploadFileShouldThrow) {
        throw new Error("Upload failed");
      }
      return { ref: "minio://test/ref" };
    }),
  },
}));

// ── Mock ConversationDiscovery ────────────────────────────────
vi.mock("#src/utils/ConversationDiscovery", () => ({
  discoverDescendantConversationIds: vi.fn().mockImplementation(async (db, id) => {
    if (id === TEST_CONVERSATION_ID) {
      return new Set([TEST_CONVERSATION_ID, "sub-agent-session-abc"]);
    }
    return new Set([id]);
  }),
}));

import { createMockCollection } from "./mongoMock.ts";

let mockCollection: any;

// MongoWrapper mock — supports both getCollection() and getDb().collection()
vi.mock("#src/wrappers/MongoWrapper", () => {
  const getCollectionFn = vi.fn();
  const getDbFn = vi.fn();
  return {
    default: {
      getDb: getDbFn,
      getCollection: getCollectionFn,
    },
  };
});

// Import AFTER mocks are wired
vi.unmock("../src/services/ConversationService.ts");
vi.unmock("../src/services/ConversationService.js");
vi.unmock("../src/services/conversation/index.ts");
vi.unmock("../src/services/conversation/ConversationService.ts");
const MongoWrapperModule = await import("#src/wrappers/MongoWrapper");
const MongoWrapper = MongoWrapperModule.default;
const { default: ConversationService } = await import(
  "#src/services/conversation/ConversationService"
);

// ── Helpers ────────────────────────────────────────────────────
const BASE_ARGS = {
  conversationId: TEST_CONVERSATION_ID,
  project: TEST_PROJECT,
  username: TEST_USER,
};

function makeMessages(count = 1) {
  const msgs = [];
  msgs.push({
    role: "user",
    content: "Hello",
    timestamp: new Date().toISOString(),
  });
  for (let i = 1; i < count; i++) {
    msgs.push({
      role: "assistant",
      content: `Response ${i}`,
      model: "test-model",
      provider: PROVIDERS.OPENAI,
      timestamp: new Date().toISOString(),
    });
  }
  return msgs;
}

/** Pre-create a session stub as markGenerating() would. */
async function createStub(id = BASE_ARGS.conversationId) {
  await mockCollection.updateOne(
    { id, project: BASE_ARGS.project, username: BASE_ARGS.username },
    {
      $set: { isGenerating: true, updatedAt: new Date().toISOString() },
      $setOnInsert: {
        title: "New Conversation",
        messages: [],
        settings: {},
        modalities: {},
        providers: [],
        totalCost: 0,
        createdAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

// ═══════════════════════════════════════════════════════════════
describe("ConversationService.appendMessages", () => {
  beforeEach(() => {
    mockCollection = createMockCollection();
    (MongoWrapper.getCollection as any).mockReturnValue(mockCollection);
    (MongoWrapper.getDb as any).mockReturnValue({
      collection: () => mockCollection,
    });
  });

  // ── The regression scenario ────────────────────────────────
  describe("$set / $setOnInsert path conflict prevention", () => {
    it("should not conflict when meta.title is provided and document already exists", async () => {
      // Simulate markGenerating creating the stub first (as handleAgent does)
      await createStub();

      // This is the call that was failing — conversationMeta with title
      // causes `title` to appear in both $set and $setOnInsert
      await expect(
        ConversationService.appendMessages(
          BASE_ARGS.conversationId,
          BASE_ARGS.project,
          BASE_ARGS.username,
          makeMessages(2),
          { title: "User's first message", settings: { provider: PROVIDERS.OPENAI, model: "gpt-4o" } },
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        ),
      ).resolves.not.toThrow();
    });

    it("should not conflict when meta includes traceId and document already has one", async () => {
      // Stub with traceId already set
      await mockCollection.updateOne(
        { id: BASE_ARGS.conversationId, project: BASE_ARGS.project, username: BASE_ARGS.username },
        {
          $set: { isGenerating: true, updatedAt: new Date().toISOString(), traceId: "trace-1" },
          $setOnInsert: {
            title: "New Conversation",
            messages: [],
            settings: {},
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );

      await expect(
        ConversationService.appendMessages(
          BASE_ARGS.conversationId,
          BASE_ARGS.project,
          BASE_ARGS.username,
          makeMessages(2),
          { title: "With trace", traceId: "trace-1", settings: { provider: PROVIDERS.GOOGLE, model: "gemini" } },
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        ),
      ).resolves.not.toThrow();
    });

    it("should not conflict when meta includes parentAgentConversationId", async () => {
      await createStub();

      await expect(
        ConversationService.appendMessages(
          BASE_ARGS.conversationId,
          BASE_ARGS.project,
          BASE_ARGS.username,
          makeMessages(2),
          { title: "Worker task", parentAgentConversationId: "parent-abc", settings: {} },
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        ),
      ).resolves.not.toThrow();
    });

    it("should not conflict when ALL possible overlapping fields are present", async () => {
      // Worst case: meta supplies title, traceId, settings, parentAgentConversationId,
      // AND systemPrompt — all of which could end up in both operators
      await createStub();

      await expect(
        ConversationService.appendMessages(
          BASE_ARGS.conversationId,
          BASE_ARGS.project,
          BASE_ARGS.username,
          makeMessages(2),
          {
            title: "Full meta test",
            traceId: "trace-full",
            systemPrompt: "You are helpful",
            parentAgentConversationId: "parent-xyz",
            settings: { provider: PROVIDERS.ANTHROPIC, model: "claude-4" },
          },
          // Use conversations collection (not agent_sessions) to exercise systemPrompt path
          { collection: COLLECTIONS.MODEL_CONVERSATIONS },
        ),
      ).resolves.not.toThrow();
    });

    it("should work when conversationMeta is null (Lupos-style)", async () => {
      await createStub();

      await expect(
        ConversationService.appendMessages(
          BASE_ARGS.conversationId,
          BASE_ARGS.project,
          BASE_ARGS.username,
          makeMessages(2),
          null,
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        ),
      ).resolves.not.toThrow();
    });
  });

  // ── Functional correctness ─────────────────────────────────
  describe("message persistence", () => {
    it("should persist messages to existing document", async () => {
      await createStub();

      const result = await ConversationService.appendMessages(
        BASE_ARGS.conversationId,
        BASE_ARGS.project,
        BASE_ARGS.username,
        makeMessages(2),
        { title: "Test session" },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    it("should auto-create document on first append (upsert)", async () => {
      const result = await ConversationService.appendMessages(
        "brand-new-session",
        BASE_ARGS.project,
        BASE_ARGS.username,
        makeMessages(2),
        null, // no meta
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.messages).toHaveLength(2);
      expect(result.title).toBe("Hello");
    });

    it("should update title from conversationMeta", async () => {
      await createStub();

      const result = await ConversationService.appendMessages(
        BASE_ARGS.conversationId,
        BASE_ARGS.project,
        BASE_ARGS.username,
        makeMessages(1),
        { title: "My custom title" },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.title).toBe("My custom title");
    });

    it("should accumulate messages across multiple appends", async () => {
      const sessionId = "multi-append-session";

      await ConversationService.appendMessages(
        sessionId,
        BASE_ARGS.project,
        BASE_ARGS.username,
        [{ role: "user", content: "First message" }],
        { title: "Multi-turn" },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      const result = await ConversationService.appendMessages(
        sessionId,
        BASE_ARGS.project,
        BASE_ARGS.username,
        [{ role: "assistant", content: "Response", provider: PROVIDERS.OPENAI, model: "gpt-4o" }],
        null, // no meta on follow-up
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe("First message");
      expect(result.messages[1].content).toBe("Response");
    });
  });

  // ── Derived field computation ──────────────────────────────
  describe("derived fields", () => {
    it("should compute modalities from appended messages", async () => {
      const result = await ConversationService.appendMessages(
        "modality-test",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "What is this?" },
          { role: "assistant", content: "It's a test", provider: PROVIDERS.OPENAI, model: "gpt-4o" },
        ],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.modalities.textIn).toBe(true);
      expect(result.modalities.textOut).toBe(true);
    });

    it("should compute providers from appended messages", async () => {
      const result = await ConversationService.appendMessages(
        "provider-test",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi", provider: PROVIDERS.ANTHROPIC, model: "claude-4" },
        ],
        { settings: { provider: PROVIDERS.ANTHROPIC, model: "claude-4" } },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.providers).toContain(PROVIDERS.ANTHROPIC);
    });

    it("should compute totalCost from appended messages (legacy fallback — no requests rows)", async () => {
      const result = await ConversationService.appendMessages(
        "cost-test",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi", estimatedCost: 0.0025, provider: PROVIDERS.OPENAI },
          { role: "assistant", content: "More", estimatedCost: 0.0015, provider: PROVIDERS.OPENAI },
        ],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      expect(result.totalCost).toBeCloseTo(0.004);
    });

    it("should roll up totalCost/tokens from the requests collection while messages stay telemetry-free", async () => {
      // Requests collection is the write-side source of truth: persisted
      // messages carry no telemetry (messageTelemetrySeparation), so the
      // rollup must come from the per-request rows.
      const requestsAggregate = vi.fn().mockReturnValue({
        toArray: async () => [
          {
            totalCost: 3.650435,
            inputTokens: 822377,
            outputTokens: 23439,
            cacheReadInputTokens: 673937,
            cacheCreationInputTokens: 148373,
            reasoningOutputTokens: 0,
            modelNames: ["claude-fable-5", null],
            providers: ["anthropic", ""],
          },
        ],
      });
      const requestsCollection = { aggregate: requestsAggregate };
      (MongoWrapper.getCollection as any).mockImplementation(
        (_db: string, name: string) =>
          name === COLLECTIONS.REQUESTS ? requestsCollection : mockCollection,
      );

      const result = await ConversationService.appendMessages(
        "rollup-from-requests",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "Make me a song" },
          // Telemetry-free assistant message — the canonical persisted shape
          { role: "assistant", content: "Done!" },
        ],
        { settings: { provider: PROVIDERS.ANTHROPIC, model: "claude-fable-5" } },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      // Match covers all request keying shapes for this conversation
      const pipeline = requestsAggregate.mock.calls[0][0];
      expect(pipeline[0].$match.$or).toEqual(
        expect.arrayContaining([
          { conversationId: "rollup-from-requests" },
          { agentConversationId: "rollup-from-requests" },
        ]),
      );

      expect(result.totalCost).toBeCloseTo(3.650435);
      expect(result.inputTokens).toBe(822377);
      expect(result.outputTokens).toBe(23439);
      expect(result.cacheReadInputTokens).toBe(673937);
      expect(result.cacheCreationInputTokens).toBe(148373);
      expect(result.modelNames).toContain("claude-fable-5");
      expect(result.providers).toContain(PROVIDERS.ANTHROPIC);
      // Persisted messages remain telemetry-free
      for (const message of result.messages as any[]) {
        expect(message).not.toHaveProperty("estimatedCost");
        expect(message).not.toHaveProperty("usage");
      }
    });

    it("should prefer the larger of request totals and message-derived cost (Math.max)", async () => {
      const requestsCollection = {
        aggregate: vi.fn().mockReturnValue({
          toArray: async () => [
            {
              totalCost: 0.001,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              reasoningOutputTokens: 0,
              modelNames: [],
              providers: [],
            },
          ],
        }),
      };
      (MongoWrapper.getCollection as any).mockImplementation(
        (_db: string, name: string) =>
          name === COLLECTIONS.REQUESTS ? requestsCollection : mockCollection,
      );

      // Image-path style message with per-message estimatedCost larger than
      // the requests aggregate — the message-derived value must win.
      const result = await ConversationService.appendMessages(
        "rollup-max",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "Draw" },
          { role: "assistant", content: "img", estimatedCost: 0.09 },
        ],
        null,
        { collection: COLLECTIONS.MODEL_CONVERSATIONS },
      );

      expect(result.totalCost).toBeCloseTo(0.09);
    });

    it("should fall back to message-derived stats when the requests aggregation throws", async () => {
      const requestsCollection = {
        aggregate: vi.fn(() => {
          throw new Error("requests collection unavailable");
        }),
      };
      (MongoWrapper.getCollection as any).mockImplementation(
        (_db: string, name: string) =>
          name === COLLECTIONS.REQUESTS ? requestsCollection : mockCollection,
      );

      const result = await ConversationService.appendMessages(
        "rollup-fallback",
        BASE_ARGS.project,
        BASE_ARGS.username,
        [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi", estimatedCost: 0.002 },
        ],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );

      // Aggregation failure must never block persistence
      expect(result.totalCost).toBeCloseTo(0.002);
    });
  });

  // ── Timer isolation (appendMessages must not touch timers) ───
  // Timer lifecycle is managed by ConversationTimerService (fire/expire)
  // and the cancel_timer tool (explicit cancel). The conversation persistence
  // layer must never mutate timer state — this aligns with Antigravity's
  // architecture where auto-cancel lives in the messaging dispatch layer.
  describe("timer isolation from message persistence", () => {
    let mockTimersCollection: any;

    beforeEach(() => {
      mockTimersCollection = createMockCollection();
      (MongoWrapper.getDb as any).mockReturnValue({
        collection: (name: any) => {
          if (name === COLLECTIONS.CONVERSATION_TIMERS) {
            return mockTimersCollection;
          }
          return mockCollection;
        },
      });
    });

    async function createActiveTimer(sessionId: any) {
      const filter = {
        conversationId: sessionId,
        project: TEST_PROJECT,
        username: TEST_USER,
        status: "active",
        mode: "one_shot",
      };

      await mockTimersCollection.updateOne(
        filter,
        {
          $set: { id: "timer-1", updatedAt: new Date().toISOString() },
          $setOnInsert: { createdAt: new Date().toISOString() },
        },
        { upsert: true }
      );

      return filter;
    }

    it("should not cancel timers when a user message is appended", async () => {
      const sessionId = "session-timer-abc";
      await createStub(sessionId);
      const filter = await createActiveTimer(sessionId);

      await ConversationService.appendMessages(
        sessionId,
        TEST_PROJECT,
        TEST_USER,
        [{ role: "user", content: "Check status please" }],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS }
      );

      const timer = await mockTimersCollection.findOne(filter);
      expect(timer.status).toBe("active");
    });

    it("should not cancel timers when an assistant message is appended", async () => {
      const sessionId = "session-timer-abc";
      await createStub(sessionId);
      const filter = await createActiveTimer(sessionId);

      await ConversationService.appendMessages(
        sessionId,
        TEST_PROJECT,
        TEST_USER,
        [{ role: "assistant", content: "I've set a timer for 1 minute. Stay hydrated! 💧", model: "gemini-3.5-flash", provider: PROVIDERS.GOOGLE }],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS }
      );

      const timer = await mockTimersCollection.findOne(filter);
      expect(timer.status).toBe("active");
    });

    it("should not cancel timers when a notification message is appended", async () => {
      const sessionId = "session-timer-abc";
      await createStub(sessionId);
      const filter = await createActiveTimer(sessionId);

      await ConversationService.appendMessages(
        sessionId,
        TEST_PROJECT,
        TEST_USER,
        [{ role: "user", content: "🔔 Notification: check build status" }],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS }
      );

      const timer = await mockTimersCollection.findOne(filter);
      expect(timer.status).toBe("active");
    });

    it("should not cancel timers when a mixed batch of messages is appended", async () => {
      const sessionId = "session-timer-abc";
      await createStub(sessionId);
      const filter = await createActiveTimer(sessionId);

      await ConversationService.appendMessages(
        sessionId,
        TEST_PROJECT,
        TEST_USER,
        [
          { role: "user", content: "What's the status?" },
          { role: "assistant", content: "Let me check.", model: "gemini-3.5-flash", provider: PROVIDERS.GOOGLE },
          { role: "tool", content: JSON.stringify({ result: "success" }) },
          { role: "assistant", content: "All good!", model: "gemini-3.5-flash", provider: PROVIDERS.GOOGLE },
        ],
        null,
        { collection: COLLECTIONS.AGENT_CONVERSATIONS }
      );

      const timer = await mockTimersCollection.findOne(filter);
      expect(timer.status).toBe("active");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationService.setGenerating", () => {
  beforeEach(() => {
    mockCollection = createMockCollection();
    (MongoWrapper.getDb as any).mockReturnValue({
      collection: () => mockCollection,
    });
  });

  it("should create stub document when setting generating=true", async () => {
    await ConversationService.setGenerating(
      "gen-test",
      TEST_PROJECT,
      TEST_USER,
      true,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );

    const doc = await mockCollection.findOne({
      id: "gen-test",
      project: TEST_PROJECT,
      username: TEST_USER,
    });

    expect(doc).not.toBeNull();
    expect(doc.isGenerating).toBe(true);
    expect(doc.messages).toEqual([]);
    expect(doc.title).toBe("New Conversation");
  });

  it("should create stub document when setting generating=true with a custom title", async () => {
    await ConversationService.setGenerating(
      "gen-test-title",
      TEST_PROJECT,
      TEST_USER,
      true,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS, title: "Custom Title" },
    );

    const doc = await mockCollection.findOne({
      id: "gen-test-title",
      project: TEST_PROJECT,
      username: TEST_USER,
    });

    expect(doc).not.toBeNull();
    expect(doc.isGenerating).toBe(true);
    expect(doc.title).toBe("Custom Title");
  });

  it("should clear generating flag on existing document", async () => {
    // Pre-create
    await mockCollection.updateOne(
      { id: "gen-test", project: TEST_PROJECT, username: TEST_USER },
      {
        $set: { isGenerating: true },
        $setOnInsert: { title: "Test", messages: [], createdAt: new Date().toISOString() },
      },
      { upsert: true },
    );

    await ConversationService.setGenerating(
      "gen-test",
      TEST_PROJECT,
      TEST_USER,
      false,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );

    const doc = await mockCollection.findOne({
      id: "gen-test",
      project: TEST_PROJECT,
      username: TEST_USER,
    });

    expect(doc.isGenerating).toBe(false);
  });
});

describe("ConversationService.getConversationStats", () => {
  let mockRequestsCollection: any;

  beforeEach(() => {
    mockRequestsCollection = {
      find: vi.fn().mockReturnValue({
        project: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              estimatedCost: 0.0015,
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              reasoningOutputTokens: 0,
              provider: PROVIDERS.OPENAI,
              model: "gpt-4",
              operation: "chat",
              createdAt: "2026-06-20T10:00:00.000Z",
              modalities: { textIn: true, textOut: true },
              toolApiNames: ["read_file"],
              success: true,
              agentConversationId: TEST_CONVERSATION_ID,
            },
            {
              estimatedCost: 0.002,
              inputTokens: 120,
              outputTokens: 80,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 20,
              reasoningOutputTokens: 5,
              provider: PROVIDERS.GOOGLE,
              model: "gemini",
              operation: "chat",
              createdAt: "2026-06-20T10:05:00.000Z",
              modalities: { textIn: true, textOut: true, imageIn: true },
              toolApiNames: [],
              success: false,
              conversationId: "sub-agent-conv-id",
              agentConversationId: "sub-agent-session-abc",
            }
          ])
        })
      })
    };

    (MongoWrapper.getDb as any).mockReturnValue({
      collection: (collectionName: string) => {
        if (collectionName === COLLECTIONS.REQUESTS) {
          return mockRequestsCollection;
        }
        return mockCollection;
      }
    });
  });

  it("should return aggregated stats correctly for main and sub-agents", async () => {
    const statsResult = await ConversationService.getConversationStats(
      TEST_CONVERSATION_ID,
      TEST_PROJECT,
      TEST_USER
    );

    expect(statsResult).not.toBeNull();
    if (statsResult) {
      expect(statsResult.requestCount).toBe(2);
      expect(statsResult.subAgentRequestCount).toBe(1);
      expect(statsResult.totalCost).toBeCloseTo(0.0035);
      expect(statsResult.totalInputTokens).toBe(220);
      expect(statsResult.totalOutputTokens).toBe(130);
      expect(statsResult.totalTokens).toBe(350);
      expect(statsResult.totalCacheReadInputTokens).toBe(10);
      expect(statsResult.totalCacheCreationInputTokens).toBe(20);
      expect(statsResult.totalReasoningOutputTokens).toBe(5);
      expect(statsResult.providers).toContain(PROVIDERS.OPENAI);
      expect(statsResult.providers).toContain(PROVIDERS.GOOGLE);
      expect(statsResult.models).toContain("gpt-4");
      expect(statsResult.models).toContain("gemini");
      expect(statsResult.operations).toContain("chat");
      expect(statsResult.modalities.textIn).toBe(true);
      expect(statsResult.modalities.imageIn).toBe(true);
      expect(statsResult.toolCounts.read_file).toBe(1);
      expect(statsResult.requestErrorCount).toBe(1);
      expect(statsResult.totalElapsedTime).toBe(300);
      expect(statsResult.createdAt).toBe("2026-06-20T10:00:00.000Z");
      expect(statsResult.updatedAt).toBe("2026-06-20T10:05:00.000Z");
    }
  });

  it("should return null if no request log records exist", async () => {
    mockRequestsCollection.find().project().toArray.mockResolvedValueOnce([]);
    const statsResult = await ConversationService.getConversationStats(
      TEST_CONVERSATION_ID,
      TEST_PROJECT,
      TEST_USER
    );
    expect(statsResult).toBeNull();
  });
});

describe("Conversation Utilities (utils.ts)", () => {
  describe("extractFiles", () => {
    beforeEach(() => {
      (globalThis as any).isExternalStorageMockValue = false;
      (globalThis as any).uploadFileShouldThrow = false;
    });

    it("should return original messages if external storage is disabled", async () => {
      const messagesInput = [
        { role: "user", content: "hello", images: ["data:image/jpeg;base64,abc"] }
      ];
      const processedMessages = await extractFiles(messagesInput, TEST_PROJECT, TEST_USER);
      expect(processedMessages).toEqual(messagesInput);
    });

    it("should upload data URLs to external storage and replace them when enabled", async () => {
      (globalThis as any).isExternalStorageMockValue = true;
      const messagesInput = [
        {
          role: "user",
          content: "hello",
          images: [
            "data:image/jpeg;base64,abc",
            "minio://existing/image.jpg",
            "http://example.com/external.png"
          ]
        },
        {
          role: "assistant",
          content: "response",
          audio: "data:audio/mp3;base64,def"
        }
      ];

      const processedMessages = await extractFiles(messagesInput, TEST_PROJECT, TEST_USER);
      expect(processedMessages[0].images).toEqual([
        "minio://test/ref",
        "minio://existing/image.jpg",
        "http://example.com/external.png"
      ]);
      expect(processedMessages[1].audio).toBe("minio://test/ref");
    });

    it("should fallback to original data URL if upload throws", async () => {
      (globalThis as any).isExternalStorageMockValue = true;
      (globalThis as any).uploadFileShouldThrow = true;

      const messagesInput = [
        { role: "user", content: "hello", images: ["data:image/jpeg;base64,abc"] }
      ];

      const processedMessages = await extractFiles(messagesInput, TEST_PROJECT, TEST_USER);
      expect(processedMessages[0].images).toEqual(["data:image/jpeg;base64,abc"]);
    });
  });

  describe("computeModalities", () => {
    it("should compute base text modalities correctly", () => {
      const messages = [
        { role: "user", content: "hey" },
        { role: "assistant", content: "hello" }
      ];
      const modalities = computeModalities(messages);
      expect(modalities.textIn).toBe(true);
      expect(modalities.textOut).toBe(true);
      expect(modalities.imageIn).toBe(false);
    });

    it("should compute image, video and document modalities correctly", () => {
      const messages = [
        {
          role: "user",
          content: "look",
          images: [
            "data:image/png;base64,abc",
            "data:application/pdf;base64,def",
            "test-video.mp4"
          ]
        },
        {
          role: "assistant",
          content: "here",
          images: [
            "data:image/png;base64,ghi"
          ]
        }
      ];
      const modalities = computeModalities(messages);
      expect(modalities.imageIn).toBe(true);
      expect(modalities.imageOut).toBe(true);
      expect(modalities.docIn).toBe(true);
      expect(modalities.videoIn).toBe(true);
    });

    it("should compute audio modalities correctly", () => {
      const messages = [
        { role: "user", content: "audio content", audio: "minio://audio-in" },
        { role: "assistant", content: "vocal reply", audio: "minio://audio-out" }
      ];
      const modalities = computeModalities(messages);
      expect(modalities.audioIn).toBe(true);
      expect(modalities.audioOut).toBe(true);
    });

    it("should compute tools and streaming sources correctly", () => {
      const messages = [
        {
          role: "assistant",
          content: "running code",
          toolCalls: [
            { id: "call-1", name: TOOL_NAMES.CODE_EXECUTION, args: {}, result: "done" },
            { id: "call-2", name: TOOL_NAMES.SEARCH_WEB, args: {}, result: "results" },
            { id: "call-3", name: "custom_function", args: {}, result: "output" }
          ]
        },
        {
          role: "assistant",
          content: "> **Sources:** google.com\n```exec-shell\npython\n```"
        }
      ];
      const modalities = computeModalities(messages as any);
      expect(modalities.codeExecution).toBe(true);
      expect(modalities.webSearch).toBe(true);
      expect(modalities.functionCalling).toBe(true);
    });
  });

  describe("extractProviders & computeTotalCost", () => {
    it("should extract unique lowercased providers correctly", () => {
      const messages = [
        { role: "assistant", content: "msg1", provider: "OpenAI" },
        { role: "assistant", content: "msg2", provider: "Google" }
      ];
      const settings = { provider: PROVIDERS.ANTHROPIC };
      const providers = extractProviders(messages as any, settings as any);
      expect(providers).toContain(PROVIDERS.OPENAI);
      expect(providers).toContain(PROVIDERS.GOOGLE);
      expect(providers).toContain(PROVIDERS.ANTHROPIC);
      expect(providers).toHaveLength(3);
    });

    it("should compute total cost summing up message estimatedCost values", () => {
      const messages = [
        { role: "user", content: "no cost" },
        { role: "assistant", content: "costly", estimatedCost: 0.001 },
        { role: "assistant", content: "more costly", estimatedCost: 0.004 }
      ];
      const cost = computeTotalCost(messages as any);
      expect(cost).toBeCloseTo(0.005);
    });
  });

  describe("buildConversationPatchFields", () => {
    it("should build correct fields dictionary for updates", () => {
      const messages = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", model: "gpt-4" }
      ];
      const settings = { model: "gpt-4", provider: PROVIDERS.OPENAI };

      const patchFields = buildConversationPatchFields({
        title: "Updated Title",
        messages: messages as any,
        systemPrompt: "You are a compiler",
        settings: settings as any
      });

      expect(patchFields.title).toBe("Updated Title");
      expect(patchFields.systemPrompt).toBe("You are a compiler");
      expect(patchFields.settings).toEqual({
        model: "gpt-4",
        provider: PROVIDERS.OPENAI
      });
      expect(patchFields.messages).toEqual(messages);
      expect(patchFields.modalities?.textIn).toBe(true);
      expect(patchFields.providers).toContain(PROVIDERS.OPENAI);
      // totalCost/inputTokens/outputTokens are deliberately NOT set on PATCH:
      // persisted messages are telemetry-free, and message edits must not
      // zero (or "refund") spend recorded in the requests collection.
      expect(patchFields).not.toHaveProperty("totalCost");
      expect(patchFields).not.toHaveProperty("inputTokens");
      expect(patchFields).not.toHaveProperty("outputTokens");
      expect(patchFields.modelNames).toContain("gpt-4");
    });
  });

  describe("enrichConversationsWithRequestCosts & enrichSingleConversationCost", () => {
    it("should enrich list of conversations with request costs map", () => {
      const conversations = [
        { id: "conv-1", totalCost: 0.001 },
        { id: "conv-2" }
      ];
      const requestLogCosts = [
        { _id: "conv-1", totalCost: 0.005, requestErrorCount: 2 },
        { _id: "conv-2", totalCost: 0.003 }
      ];

      enrichConversationsWithRequestCosts(conversations as any, requestLogCosts);

      expect(conversations[0].totalCost).toBe(0.005);
      expect((conversations[0] as any).requestErrorCount).toBe(2);
      expect(conversations[1].totalCost).toBe(0.003);
    });

    it("should enrich single conversation correctly", () => {
      const conversation = { id: "conv-1", totalCost: 0.001 };
      const requestLogAggregation = [
        { _id: "conv-1", totalCost: 0.008, requestErrorCount: 5 }
      ];

      enrichSingleConversationCost(conversation as any, requestLogAggregation);

      expect(conversation.totalCost).toBe(0.008);
      expect((conversation as any).requestErrorCount).toBe(5);
    });
  });
});
