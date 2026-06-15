import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock dependencies
vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
}));

// We will mock MongoWrapper to return controlled databases and collections
const mockWatch = vi.fn();
const mockCollection = vi.fn(() => ({
  watch: mockWatch,
  updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
}));
const mockDatabase = {
  collection: mockCollection,
};

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn((databaseName: string) => {
      if (databaseName === "prism-test") {
        return mockDatabase;
      }
      return null;
    }),
  },
}));

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Import the service under test
import ChangeStreamService from "../src/services/ChangeStreamService.ts";

class MockChangeStream extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);
}

describe("ChangeStreamService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("should warn and set available to false if database is not available during init", async () => {
    const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
    const getDatabaseSpy = vi.spyOn(MongoWrapper, "getDb").mockReturnValueOnce(null as any);

    await ChangeStreamService.init();

    expect(ChangeStreamService.available).toBe(false);
    getDatabaseSpy.mockRestore();
  });

  it("should set available to false if test stream fails (e.g., standalone mode)", async () => {
    mockWatch.mockImplementationOnce(() => {
      throw new Error("Change streams only supported on replica sets");
    });

    await ChangeStreamService.init();

    expect(ChangeStreamService.available).toBe(false);
  });

  it("should initialize streams and set available to true when replica sets are active", async () => {
    const mockTestStream = new MockChangeStream();
    const mockConversationsStream = new MockChangeStream();
    const mockAgentsStream = new MockChangeStream();
    const mockRequestsStream = new MockChangeStream();

    // First call is the test watch, next calls are real collection watches
    mockWatch
      .mockReturnValueOnce(mockTestStream)
      .mockReturnValueOnce(mockConversationsStream)
      .mockReturnValueOnce(mockAgentsStream)
      .mockReturnValueOnce(mockRequestsStream);

    await ChangeStreamService.init();

    expect(ChangeStreamService.available).toBe(true);
    expect(mockWatch).toHaveBeenCalledTimes(4); // 1 test watch + 3 watched collections

    // Clean up
    await ChangeStreamService.close();
  });

  it("should subscribe, unsubscribe, and dispatch events correctly", async () => {
    const mockTestStream = new MockChangeStream();
    const mockConversationsStream = new MockChangeStream();
    const mockAgentsStream = new MockChangeStream();
    const mockRequestsStream = new MockChangeStream();

    mockWatch
      .mockReturnValueOnce(mockTestStream)
      .mockReturnValueOnce(mockConversationsStream)
      .mockReturnValueOnce(mockAgentsStream)
      .mockReturnValueOnce(mockRequestsStream);

    await ChangeStreamService.init();

    const receivedPayloads: any[] = [];
    const callback = (payload: any) => {
      receivedPayloads.push(payload);
    };

    ChangeStreamService.subscribe(callback);

    // Emit a change event from the mock stream
    const rawChangeEvent = {
      operationType: "update",
      documentKey: { _id: "document-id-123" },
      fullDocument: { id: "conversation-abc", isGenerating: true },
      updateDescription: { updatedFields: { isGenerating: true } },
    };

    mockConversationsStream.emit("change", rawChangeEvent);

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toEqual(
      expect.objectContaining({
        collection: expect.any(String),
        operationType: "update",
        documentId: "document-id-123",
        id: "conversation-abc",
        isGenerating: true,
      })
    );

    // Unsubscribe and verify no more events are received
    ChangeStreamService.unsubscribe(callback);
    mockConversationsStream.emit("change", rawChangeEvent);
    expect(receivedPayloads).toHaveLength(1);

    await ChangeStreamService.close();
  });

  it("should enrich request collection change events with conversationId", async () => {
    const mockTestStream = new MockChangeStream();
    const mockConversationsStream = new MockChangeStream();
    const mockAgentsStream = new MockChangeStream();
    const mockRequestsStream = new MockChangeStream();

    mockWatch
      .mockReturnValueOnce(mockTestStream)
      .mockReturnValueOnce(mockConversationsStream)
      .mockReturnValueOnce(mockAgentsStream)
      .mockReturnValueOnce(mockRequestsStream);

    await ChangeStreamService.init();

    const receivedPayloads: any[] = [];
    const callback = (payload: any) => {
      receivedPayloads.push(payload);
    };

    ChangeStreamService.subscribe(callback);

    const rawChangeEvent = {
      operationType: "insert",
      documentKey: { _id: "request-id-456" },
      fullDocument: { conversationId: "conversation-789" },
    };

    mockRequestsStream.emit("change", rawChangeEvent);

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].conversationId).toBe("conversation-789");

    ChangeStreamService.unsubscribe(callback);
    await ChangeStreamService.close();
  });

  it("should reconnect after stream error after delay", async () => {
    const mockTestStream = new MockChangeStream();
    const mockConversationsStream = new MockChangeStream();
    const mockAgentsStream = new MockChangeStream();
    const mockRequestsStream = new MockChangeStream();
    const mockReopenedStream = new MockChangeStream();

    mockWatch
      .mockReturnValueOnce(mockTestStream)
      .mockReturnValueOnce(mockConversationsStream)
      .mockReturnValueOnce(mockAgentsStream)
      .mockReturnValueOnce(mockRequestsStream)
      .mockReturnValueOnce(mockReopenedStream);

    await ChangeStreamService.init();
    expect(mockWatch).toHaveBeenCalledTimes(4);

    // Trigger error on the active stream
    mockConversationsStream.emit("error", new Error("Connection lost"));

    // Advance fake timers to trigger reconnection timeout (5000ms)
    await vi.advanceTimersByTimeAsync(5000);

    // It should try to reopen the collection stream
    expect(mockWatch).toHaveBeenCalledTimes(5);

    await ChangeStreamService.close();
  });
});
