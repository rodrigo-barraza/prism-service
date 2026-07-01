import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

// Unmock RequestLogger so we test the actual implementation
vi.unmock("../src/services/RequestLogger.ts");

// ── Mock MongoWrapper ─────────────────────────────────────────────────
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "mock-id" });
const mockUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const mockCollection = {
  insertOne: (...arguments_: any[]) => mockInsertOne(...arguments_),
  updateOne: (...arguments_: any[]) => mockUpdateOne(...arguments_),
};
const mockGetDb = vi.fn().mockReturnValue({
  collection: () => mockCollection,
});

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: (...arguments_: any[]) => mockGetDb(...arguments_),
  },
}));

// ── Mock WebhookEventBus ──────────────────────────────────────────────
const mockWebhookEmit = vi.fn();
vi.mock("../src/services/WebhookEventBus.ts", () => ({
  default: {
    emit: (...arguments_: any[]) => mockWebhookEmit(...arguments_),
  },
}));

import RequestLogger from "../src/services/RequestLogger.ts";

describe("RequestLogger Unit Tests Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("log", () => {
    it("should successfully log request parameters into MongoDB collection", async () => {
      await RequestLogger.log({
        requestId: "request-123",
        endpoint: "chat",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        success: true,
        inputTokens: 100,
        outputTokens: 50,
      });

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.requestId).toBe("request-123");
      expect(insertedDocument.provider).toBe(PROVIDERS.GOOGLE);
      expect(insertedDocument.model).toBe("gemini-3.5-flash");
      expect(insertedDocument.success).toBe(true);
      expect(insertedDocument.inputTokens).toBe(100);
      expect(insertedDocument.outputTokens).toBe(50);
      expect(insertedDocument.createdAt).toBeDefined();

      expect(mockWebhookEmit).toHaveBeenCalledWith(
        "request.created",
        expect.objectContaining({
          requestId: "request-123",
        })
      );
    });

    it("should include status 'completed' on all log() calls", async () => {
      await RequestLogger.log({
        requestId: "status-check-123",
        endpoint: "chat",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        success: true,
      });

      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.status).toBe("completed");
    });

    it("should fail gracefully if MongoDB is unavailable", async () => {
      mockGetDb.mockReturnValueOnce(null);

      // Should not throw
      await expect(
        RequestLogger.log({
          requestId: "request-456",
          endpoint: "chat",
          provider: PROVIDERS.OPENAI,
          model: "gpt-4o",
          success: true,
        })
      ).resolves.not.toThrow();

      expect(mockInsertOne).not.toHaveBeenCalled();
    });
  });

  describe("logChatGeneration", () => {
    it("should correctly compile and log chat generation metadata and payloads", async () => {
      await RequestLogger.logChatGeneration({
        requestId: "chat-request-123",
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-3-opus",
        success: true,
        usage: {
          inputTokens: 120,
          outputTokens: 80,
          cacheReadInputTokens: 20,
        },
        options: {
          temperature: 0.7,
          maxTokens: 1000,
        },
        messages: [
          { role: "user", content: "Hello" },
        ],
        text: "Hi there!",
      });

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.requestId).toBe("chat-request-123");
      expect(insertedDocument.inputTokens).toBe(140);
      expect(insertedDocument.outputTokens).toBe(80);
      expect(insertedDocument.cacheReadInputTokens).toBe(20);
      expect(insertedDocument.temperature).toBe(0.7);
      expect(insertedDocument.maxTokens).toBe(1000);
      expect(insertedDocument.requestPayload.messages).toEqual([
        { role: "user", content: "Hello" },
      ]);
      expect(insertedDocument.responsePayload.text).toBe("Hi there!");
    });
  });

  describe("logBackgroundLlmCall", () => {
    it("should calculate correct timing, tokens, and log background call", async () => {
      const requestStartMilliseconds = performance.now() - 500; // 500ms duration

      await RequestLogger.logBackgroundLlmCall({
        requestId: "bg-request-123",
        endpoint: "background",
        operation: "extraction",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        aiMessages: [
          { role: "user", content: "Extract info" },
        ],
        resultText: "Extracted data",
        requestStartMilliseconds: requestStartMilliseconds,
        success: true,
      });

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.requestId).toBe("bg-request-123");
      expect(insertedDocument.endpoint).toBe("background");
      expect(insertedDocument.operation).toBe("extraction");
      expect(insertedDocument.success).toBe(true);

      // totalTime should be around 0.5s or rounded milliseconds
      expect(insertedDocument.totalTime).toBeGreaterThanOrEqual(0.4);
      expect(insertedDocument.inputCharacters).toBe("Extract info".length);
      expect(insertedDocument.responsePayload.textPreview).toBe("Extracted data");
    });
  });

  // ── Two-Phase Request Lifecycle ─────────────────────────────────────

  describe("insertPending", () => {
    it("should insert a minimal pending skeleton document and return the insertedId", async () => {
      const mockObjectId = "68abc123def456";
      mockInsertOne.mockResolvedValueOnce({ insertedId: mockObjectId });

      const insertedId = await RequestLogger.insertPending({
        requestId: "req-abc-1",
        endpoint: "/agent",
        operation: "agent:iteration",
        project: "test-project",
        username: "test-user",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        conversationId: "conv-123",
        agentConversationId: "agent-conv-456",
        agenticIteration: 1,
      });

      expect(insertedId).toBe(mockObjectId);
      expect(mockInsertOne).toHaveBeenCalledTimes(1);

      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.status).toBe("pending");
      expect(insertedDocument.requestId).toBe("req-abc-1");
      expect(insertedDocument.provider).toBe(PROVIDERS.GOOGLE);
      expect(insertedDocument.model).toBe("gemini-3.5-flash");
      expect(insertedDocument.conversationId).toBe("conv-123");
      expect(insertedDocument.agentConversationId).toBe("agent-conv-456");
      expect(insertedDocument.agenticIteration).toBe(1);
      expect(insertedDocument.createdAt).toBeDefined();

      // Pending documents should have zeroed telemetry
      expect(insertedDocument.inputTokens).toBe(0);
      expect(insertedDocument.outputTokens).toBe(0);
      expect(insertedDocument.estimatedCost).toBeNull();
      expect(insertedDocument.success).toBeNull();
    });

    it("should return null if MongoDB is unavailable", async () => {
      mockGetDb.mockReturnValueOnce(null);

      const insertedId = await RequestLogger.insertPending({
        requestId: "req-fail-1",
      });

      expect(insertedId).toBeNull();
      expect(mockInsertOne).not.toHaveBeenCalled();
    });

    it("should return null and not throw if insert fails", async () => {
      mockInsertOne.mockRejectedValueOnce(new Error("MongoDB write error"));

      const insertedId = await RequestLogger.insertPending({
        requestId: "req-error-1",
        provider: PROVIDERS.OPENAI,
        model: "gpt-4o",
      });

      expect(insertedId).toBeNull();
    });

    it("should conditionally spread agentConversationId and parentAgentConversationId", async () => {
      mockInsertOne.mockResolvedValueOnce({ insertedId: "id-1" });

      await RequestLogger.insertPending({
        requestId: "req-no-agent-conv",
        agentConversationId: null,
        parentAgentConversationId: null,
      });

      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument).not.toHaveProperty("agentConversationId");
      expect(insertedDocument).not.toHaveProperty("parentAgentConversationId");
    });

    it("should include agentConversationId when provided", async () => {
      mockInsertOne.mockResolvedValueOnce({ insertedId: "id-2" });

      await RequestLogger.insertPending({
        requestId: "req-with-agent",
        agentConversationId: "agent-123",
        parentAgentConversationId: "parent-456",
      });

      const insertedDocument = mockInsertOne.mock.calls[0][0];
      expect(insertedDocument.agentConversationId).toBe("agent-123");
      expect(insertedDocument.parentAgentConversationId).toBe("parent-456");
    });
  });

  describe("completePending", () => {
    it("should update the pending document with full payload and set status to completed", async () => {
      const pendingDocumentId = "68pending123" as any;

      await RequestLogger.completePending(pendingDocumentId, {
        requestId: "req-abc-1",
        endpoint: "/agent",
        operation: "agent:iteration",
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-sonnet-4",
        conversationId: "conv-123",
        success: true,
        inputTokens: 500,
        outputTokens: 200,
        estimatedCost: 0.0042,
        tokensPerSec: 85,
        totalTime: 2.5,
      });

      expect(mockUpdateOne).toHaveBeenCalledTimes(1);

      const [filter, update] = mockUpdateOne.mock.calls[0];
      expect(filter._id).toBe(pendingDocumentId);

      const setFields = update.$set;
      expect(setFields.status).toBe("completed");
      expect(setFields.requestId).toBe("req-abc-1");
      expect(setFields.provider).toBe(PROVIDERS.ANTHROPIC);
      expect(setFields.model).toBe("claude-sonnet-4");
      expect(setFields.success).toBe(true);
      expect(setFields.inputTokens).toBe(500);
      expect(setFields.outputTokens).toBe(200);
      expect(setFields.estimatedCost).toBe(0.0042);

      expect(mockWebhookEmit).toHaveBeenCalledWith(
        "request.completed",
        expect.objectContaining({
          _id: pendingDocumentId,
          status: "completed",
        })
      );
    });

    it("should fall back to full insert via log() if the pending document is not found", async () => {
      const pendingDocumentId = "68missing789" as any;
      mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

      await RequestLogger.completePending(pendingDocumentId, {
        requestId: "req-fallback-1",
        endpoint: "/agent",
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        success: true,
      });

      // updateOne was called but found no match
      expect(mockUpdateOne).toHaveBeenCalledTimes(1);

      // Should have fallen back to insertOne via log()
      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const fallbackDocument = mockInsertOne.mock.calls[0][0];
      expect(fallbackDocument.requestId).toBe("req-fallback-1");
      expect(fallbackDocument.status).toBe("completed");
    });

    it("should fall back to log() if updateOne throws an error", async () => {
      const pendingDocumentId = "68error456" as any;
      mockUpdateOne.mockRejectedValueOnce(new Error("Network partition"));

      await RequestLogger.completePending(pendingDocumentId, {
        requestId: "req-error-recovery",
        endpoint: "/agent",
        provider: PROVIDERS.OPENAI,
        model: "gpt-4o",
        success: true,
      });

      // Should have tried to insert as fallback
      expect(mockInsertOne).toHaveBeenCalledTimes(1);
    });

    it("should not throw if MongoDB is entirely unavailable", async () => {
      mockGetDb.mockReturnValueOnce(null);

      await expect(
        RequestLogger.completePending("68unavailable" as any, {
          requestId: "req-unavail",
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3.5-flash",
          success: false,
        })
      ).resolves.not.toThrow();
    });

    it("should conditionally include cache and reasoning token fields only when positive", async () => {
      const pendingDocumentId = "68tokens123" as any;

      await RequestLogger.completePending(pendingDocumentId, {
        requestId: "req-tokens-1",
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-sonnet-4",
        success: true,
        cacheReadInputTokens: 150,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 42,
      });

      const setFields = mockUpdateOne.mock.calls[0][1].$set;
      expect(setFields.cacheReadInputTokens).toBe(150);
      expect(setFields).not.toHaveProperty("cacheCreationInputTokens");
      expect(setFields.reasoningOutputTokens).toBe(42);
    });
  });
});
