import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Suppress logger output during tests
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock MongoWrapper — the test verifies in-memory behavior and checks that
// MongoDB calls are made correctly via the mock.
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockFindOne = vi.fn().mockResolvedValue(null);
const mockDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn().mockReturnValue({
      updateOne: (...args: unknown[]) => mockUpdateOne(...args),
      findOne: (...args: unknown[]) => mockFindOne(...args),
      deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
    }),
  },
}));

vi.mock("../../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
}));

import ToolContext from "../src/services/ToolContext.ts";

// ═══════════════════════════════════════════════════════════════
// In-Memory CRUD Operations
// ═══════════════════════════════════════════════════════════════

describe("ToolContext — in-memory CRUD", () => {
  const SESSION = "test-session-crud";

  afterEach(() => {
    ToolContext.cleanup(SESSION);
    vi.clearAllMocks();
  });

  it("getStore() creates a new store lazily", () => {
    const store = ToolContext.getStore(SESSION);
    expect(store).toBeInstanceOf(Map);
    expect(store.size).toBe(0);
  });

  it("getStore() returns the same store on subsequent calls", () => {
    const store1 = ToolContext.getStore(SESSION);
    const store2 = ToolContext.getStore(SESSION);
    expect(store1).toBe(store2);
  });

  it("set() stores a value retrievable by get()", () => {
    ToolContext.set(SESSION, "cursor", 42);
    expect(ToolContext.get(SESSION, "cursor")).toBe(42);
  });

  it("set() overwrites existing values", () => {
    ToolContext.set(SESSION, "page", 1);
    ToolContext.set(SESSION, "page", 2);
    expect(ToolContext.get(SESSION, "page")).toBe(2);
  });

  it("get() returns undefined for non-existent keys", () => {
    expect(ToolContext.get(SESSION, "nope")).toBeUndefined();
  });

  it("get() returns undefined for non-existent sessions", () => {
    expect(ToolContext.get("nonexistent", "key")).toBeUndefined();
  });

  it("has() returns true for existing keys", () => {
    ToolContext.set(SESSION, "exists", true);
    expect(ToolContext.has(SESSION, "exists")).toBe(true);
  });

  it("has() returns false for non-existent keys", () => {
    expect(ToolContext.has(SESSION, "nope")).toBe(false);
  });

  it("has() returns false for non-existent sessions", () => {
    expect(ToolContext.has("nonexistent", "key")).toBe(false);
  });

  it("delete() removes a key and returns true", () => {
    ToolContext.set(SESSION, "temp", "value");
    const result = ToolContext.delete(SESSION, "temp");
    expect(result).toBe(true);
    expect(ToolContext.has(SESSION, "temp")).toBe(false);
  });

  it("delete() returns false for non-existent keys", () => {
    ToolContext.set(SESSION, "other", "value");
    const result = ToolContext.delete(SESSION, "nonexistent");
    expect(result).toBe(false);
  });

  it("delete() returns false for non-existent sessions", () => {
    const result = ToolContext.delete("nonexistent", "key");
    expect(result).toBe(false);
  });

  it("keys() returns all stored keys", () => {
    ToolContext.set(SESSION, "a", 1);
    ToolContext.set(SESSION, "b", 2);
    ToolContext.set(SESSION, "c", 3);
    const keys = ToolContext.keys(SESSION);
    expect(keys).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(keys).toHaveLength(3);
  });

  it("keys() returns empty array for non-existent sessions", () => {
    expect(ToolContext.keys("nonexistent")).toEqual([]);
  });

  it("stores complex values (objects, arrays)", () => {
    const complexValue = { data: [1, 2, 3], nested: { deep: true } };
    ToolContext.set(SESSION, "complex", complexValue);
    expect(ToolContext.get(SESSION, "complex")).toEqual(complexValue);
  });

  it("supports typed get<T>()", () => {
    ToolContext.set(SESSION, "count", 42);
    const value = ToolContext.get<number>(SESSION, "count");
    expect(value).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════

describe("ToolContext — cleanup", () => {
  const SESSION = "test-session-cleanup";

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cleanup() removes all state for a session", () => {
    ToolContext.set(SESSION, "a", 1);
    ToolContext.set(SESSION, "b", 2);
    ToolContext.cleanup(SESSION);

    expect(ToolContext.get(SESSION, "a")).toBeUndefined();
    expect(ToolContext.get(SESSION, "b")).toBeUndefined();
    expect(ToolContext.keys(SESSION)).toEqual([]);
  });

  it("cleanup() is safe to call on non-existent sessions", () => {
    expect(() => ToolContext.cleanup("nonexistent")).not.toThrow();
  });

  it("cleanup() calls MongoDB deleteOne", () => {
    ToolContext.set(SESSION, "data", "value");
    ToolContext.cleanup(SESSION);

    expect(mockDeleteOne).toHaveBeenCalledWith({ conversationId: SESSION });
  });

  it("cleanup() decrements activeConversationCount", () => {
    const before = ToolContext.activeConversationCount;
    ToolContext.set(SESSION, "data", "value");
    expect(ToolContext.activeConversationCount).toBe(before + 1);
    ToolContext.cleanup(SESSION);
    expect(ToolContext.activeConversationCount).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════
// MongoDB Write-Through
// ═══════════════════════════════════════════════════════════════

describe("ToolContext — MongoDB write-through", () => {
  const SESSION = "test-session-mongo-write";

  afterEach(() => {
    ToolContext.cleanup(SESSION);
    vi.clearAllMocks();
  });

  it("set() triggers MongoDB upsert asynchronously", async () => {
    ToolContext.set(SESSION, "key", "value");

    // Give the async write-through time to complete
    await vi.waitFor(() => {
      expect(mockUpdateOne).toHaveBeenCalled();
    });

    const call = mockUpdateOne.mock.calls[0];
    expect(call[0]).toEqual({ conversationId: SESSION });
    expect(call[1].$set.conversationId).toBe(SESSION);
    expect(call[1].$set.state).toEqual({ key: "value" });
    expect(call[2]).toEqual({ upsert: true });
  });

  it("delete() triggers MongoDB persist after removing key", async () => {
    ToolContext.set(SESSION, "toDelete", "value");
    await vi.waitFor(() => expect(mockUpdateOne).toHaveBeenCalledTimes(1));

    mockUpdateOne.mockClear();
    ToolContext.delete(SESSION, "toDelete");

    await vi.waitFor(() => {
      expect(mockUpdateOne).toHaveBeenCalled();
    });

    // State should have the key removed
    const call = mockUpdateOne.mock.calls[0];
    expect(call[1].$set.state).not.toHaveProperty("toDelete");
  });
});

// ═══════════════════════════════════════════════════════════════
// MongoDB Read-Through (ensureLoaded)
// ═══════════════════════════════════════════════════════════════

describe("ToolContext — ensureLoaded (MongoDB read-through)", () => {
  const SESSION = "test-session-load";

  afterEach(() => {
    ToolContext.cleanup(SESSION);
    vi.clearAllMocks();
  });

  it("ensureLoaded() restores state from MongoDB", async () => {
    mockFindOne.mockResolvedValueOnce({
      conversationId: SESSION,
      state: { cursor: 5, page: "results" },
    });

    await ToolContext.ensureLoaded(SESSION);

    expect(ToolContext.get(SESSION, "cursor")).toBe(5);
    expect(ToolContext.get(SESSION, "page")).toBe("results");
  });

  it("ensureLoaded() is idempotent (only loads once)", async () => {
    mockFindOne.mockResolvedValueOnce({
      conversationId: SESSION,
      state: { key: "first" },
    });

    await ToolContext.ensureLoaded(SESSION);
    await ToolContext.ensureLoaded(SESSION);

    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it("ensureLoaded() doesn't overwrite in-memory state", async () => {
    // Set in-memory state first
    ToolContext.set(SESSION, "winner", "memory");

    mockFindOne.mockResolvedValueOnce({
      conversationId: SESSION,
      state: { winner: "mongo", newKey: "from-mongo" },
    });

    // Cleanup and re-init to clear the loadedSessions flag
    ToolContext.cleanup(SESSION);
    ToolContext.set(SESSION, "winner", "memory");
    await ToolContext.ensureLoaded(SESSION);

    // In-memory value should win on conflict
    expect(ToolContext.get(SESSION, "winner")).toBe("memory");
    // New keys from MongoDB should be merged
    expect(ToolContext.get(SESSION, "newKey")).toBe("from-mongo");
  });

  it("ensureLoaded() handles no MongoDB document gracefully", async () => {
    mockFindOne.mockResolvedValueOnce(null);

    await ToolContext.ensureLoaded(SESSION);

    // Session should exist but be empty
    expect(ToolContext.keys(SESSION)).toEqual([]);
  });

  it("ensureLoaded() handles MongoDB errors gracefully", async () => {
    mockFindOne.mockRejectedValueOnce(new Error("connection failed"));

    // Should not throw
    await expect(ToolContext.ensureLoaded(SESSION)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// activeConversationCount
// ═══════════════════════════════════════════════════════════════

describe("ToolContext — activeConversationCount", () => {
  it("tracks multiple sessions", () => {
    const base = ToolContext.activeConversationCount;
    ToolContext.set("session-a", "k", 1);
    ToolContext.set("session-b", "k", 2);
    expect(ToolContext.activeConversationCount).toBe(base + 2);

    ToolContext.cleanup("session-a");
    expect(ToolContext.activeConversationCount).toBe(base + 1);

    ToolContext.cleanup("session-b");
    expect(ToolContext.activeConversationCount).toBe(base);
  });
});
