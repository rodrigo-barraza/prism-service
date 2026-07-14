/**
 * Turn checkpoint — crash-safety shadow persistence for in-flight turns.
 *
 * Root cause: agentic turns only persist messages at finalize. A process
 * crash/restart mid-turn (observed when users stop a generation mid-tool-call
 * and an abort-path promise rejection killed the process) lost the ENTIRE
 * turn including the user's message, leaving the conversation as an empty
 * stub in MongoDB.
 *
 * These tests validate:
 *   1. saveTurnCheckpoint writes the shadow copy ($set turnCheckpoint)
 *   2. appendMessages atomically clears the checkpoint ($unset)
 *   3. recoverOrphanedTurnCheckpoints appends orphaned messages for real
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

const mockCollection = {
  updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  findOne: vi.fn(),
  find: vi.fn(),
};

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({}),
    getCollection: vi.fn(() => mockCollection),
  },
}));

vi.mock("../utils.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../utils.ts")>();
  return {
    ...original,
    extractFiles: vi.fn(async (messages: unknown[]) => messages),
    aggregateConversationTotalsFromRequests: vi.fn().mockResolvedValue(null),
  };
});

import ConversationService from "../ConversationService.ts";

describe("saveTurnCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the shadow copy via $set turnCheckpoint", async () => {
    const messages = [{ role: "user", content: "make a song" }];
    await ConversationService.saveTurnCheckpoint(
      "conversation-1",
      "any",
      "rodrigo",
      messages,
      { collection: "agent_conversations" },
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockCollection.updateOne.mock.calls[0];
    expect(filter).toEqual({
      id: "conversation-1",
      project: "any",
      username: "rodrigo",
    });
    expect(update.$set.turnCheckpoint.messages).toEqual(messages);
    expect(typeof update.$set.turnCheckpoint.savedAt).toBe("string");
  });

  it("no-ops when there are no messages to checkpoint", async () => {
    await ConversationService.saveTurnCheckpoint(
      "conversation-1",
      "any",
      "rodrigo",
      [],
    );
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });
});

describe("appendMessages checkpoint clearing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.findOne.mockResolvedValue({
      id: "conversation-1",
      title: "existing title",
      messages: [{ role: "user", content: "make a song" }],
      settings: {},
    });
  });

  it("atomically $unsets turnCheckpoint in the same update as the $push", async () => {
    await ConversationService.appendMessages(
      "conversation-1",
      "any",
      "rodrigo",
      [{ role: "assistant", content: "done" }],
      null,
      { collection: "agent_conversations" },
    );

    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$push).toBeDefined();
    expect(update.$unset).toEqual({ turnCheckpoint: "" });
  });
});

describe("recoverOrphanedTurnCheckpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends orphaned checkpoint messages and reports the count", async () => {
    const orphanedMessages = [
      { role: "user", content: "make a song" },
      { role: "assistant", content: "", toolCalls: [{ name: "generate_audio", args: {} }] },
    ];
    mockCollection.find.mockReturnValue({
      project: () => ({
        toArray: async () => [
          {
            id: "conversation-1",
            project: "any",
            username: "rodrigo",
            turnCheckpoint: { messages: orphanedMessages },
          },
        ],
      }),
    });
    mockCollection.findOne.mockResolvedValue({
      id: "conversation-1",
      title: "make a song",
      messages: orphanedMessages,
      settings: {},
    });

    const recoveredCount =
      await ConversationService.recoverOrphanedTurnCheckpoints({
        collection: "agent_conversations",
      });

    expect(recoveredCount).toBe(1);
    // The recovery ran appendMessages: pushed the orphaned messages and
    // cleared the checkpoint in the same atomic update.
    const appendUpdate = mockCollection.updateOne.mock.calls[0][1];
    expect(appendUpdate.$push.messages.$each).toEqual(orphanedMessages);
    expect(appendUpdate.$unset).toEqual({ turnCheckpoint: "" });
  });

  it("returns 0 when no orphaned checkpoints exist", async () => {
    mockCollection.find.mockReturnValue({
      project: () => ({ toArray: async () => [] }),
    });
    const recoveredCount =
      await ConversationService.recoverOrphanedTurnCheckpoints();
    expect(recoveredCount).toBe(0);
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });
});
