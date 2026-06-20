import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

// Unmock RequestLogger so we test the actual implementation
vi.unmock("../src/services/RequestLogger.ts");

// ── Mock MongoWrapper ─────────────────────────────────────────────────
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "mock-id" });
const mockCollection = {
  insertOne: (...arguments_: any[]) => mockInsertOne(...arguments_),
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
      expect(insertedDocument.timestamp).toBeDefined();

      expect(mockWebhookEmit).toHaveBeenCalledWith(
        "request.created",
        expect.objectContaining({
          requestId: "request-123",
        })
      );
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
        requestStartMs: requestStartMilliseconds,
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
});
