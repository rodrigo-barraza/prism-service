/**
 * Prompt 22 L3 — the stored transcript a turn's taint registry is seeded
 * from (StoredTranscript): read as its owner, from the collection the
 * Finalizer wrote it to, and fail-open.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
const getCollection = vi.fn((_database: string, _collection: string) => ({ findOne }));
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getCollection: (database: string, collection: string) => getCollection(database, collection) },
}));
const warn = vi.fn();
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: (...args: unknown[]) => warn(...args), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: { isAgentProject: (project: string) => project === "lupos" },
}));

import { loadStoredTranscript } from "#src/services/permissions/StoredTranscript";
import { COLLECTIONS } from "#src/constants";

describe("loadStoredTranscript", () => {
  beforeEach(() => {
    findOne.mockReset();
    getCollection.mockClear();
    warn.mockReset();
  });

  it("reads the conversation's messages as its owner, from the agent collection for an agent's turn", async () => {
    const messages = [{ role: "tool", name: "read_web_page", content: "page" }];
    findOne.mockResolvedValue({ messages });
    const owner = { conversationId: "c1", project: "prism-chat", username: "rodrigo", agent: "CODING" };
    expect(await loadStoredTranscript(owner)).toEqual(messages);
    expect(getCollection.mock.calls[0][1]).toBe(COLLECTIONS.AGENT_CONVERSATIONS);
    expect(findOne).toHaveBeenCalledWith(
      { id: "c1", project: "prism-chat", username: "rodrigo" },
      { projection: { messages: 1 } },
    );
  });

  it("uses the Finalizer's collection rule: an agent project, else model conversations", async () => {
    findOne.mockResolvedValue(null);
    await loadStoredTranscript({ conversationId: "c2", project: "lupos", username: "bot" });
    await loadStoredTranscript({ conversationId: "c3", project: "prism-chat", username: "rodrigo" });
    expect(getCollection.mock.calls.map((call) => call[1])).toEqual([
      COLLECTIONS.AGENT_CONVERSATIONS,
      COLLECTIONS.MODEL_CONVERSATIONS,
    ]);
  });

  it("a new conversation (nothing stored, or no id yet) has an empty transcript, and reads nothing without an owner", async () => {
    findOne.mockResolvedValue(null);
    expect(await loadStoredTranscript({ conversationId: "new", project: "p", username: "u", agent: "CODING" })).toEqual([]);
    expect(await loadStoredTranscript({ conversationId: null, project: "p", username: "u" })).toEqual([]);
    expect(await loadStoredTranscript({ conversationId: "c", project: "p", username: null })).toEqual([]);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it("fails open with a warning when the read fails", async () => {
    findOne.mockRejectedValue(new Error("connection reset"));
    expect(await loadStoredTranscript({ conversationId: "c4", project: "p", username: "u", agent: "CODING" })).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("connection reset");
  });
});
