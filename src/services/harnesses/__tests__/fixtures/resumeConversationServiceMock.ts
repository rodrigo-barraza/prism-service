/**
 * The conversation store as far as a turn and a restart use it — checkpoint,
 * append, salvage — over the mock collections of a restart test
 * (resumeParkedTurns.test.ts). Behaves like ConversationService in what
 * those tests observe: appendMessages persists and drops the checkpoint
 * atomically; salvage merges every checkpoint it is not told to skip.
 */
import type { createMockCollection } from "../../../../../tests/mongoMock.ts";

type MockCollection = ReturnType<typeof createMockCollection>;

interface SharedStore {
  collections: Map<string, MockCollection>;
}

function persisted(message: Record<string, unknown>): Record<string, unknown> {
  const { _alreadyPersisted: _flag, ...rest } = message;
  return rest;
}

export function createConversationServiceMock(shared: SharedStore) {
  const documentOf = (collection: string | undefined, id: string) =>
    shared.collections.get(collection ?? "agent_conversations")?._docs.get(id) as
      | Record<string, any>
      | undefined;

  return {
    async saveTurnCheckpoint(
      conversationId: string,
      _project: string,
      _username: string,
      messages: Array<Record<string, unknown>>,
      {
        collection,
        iteration,
        allowEmpty = false,
      }: { collection?: string; iteration?: number; allowEmpty?: boolean } = {},
    ) {
      if (!conversationId || (messages.length === 0 && !allowEmpty)) return;
      const document = documentOf(collection, conversationId);
      if (!document) return;
      document.turnCheckpoint = {
        messages: messages.map(persisted),
        savedAt: new Date().toISOString(),
        ...(typeof iteration === "number" ? { iteration } : {}),
      };
    },

    async appendMessages(
      conversationId: string,
      _project: string,
      _username: string,
      messages: Array<Record<string, unknown>>,
      _meta: unknown,
      { collection }: { collection?: string } = {},
    ) {
      const document = documentOf(collection, conversationId);
      if (!document) return;
      document.messages = [
        ...(document.messages ?? []),
        ...messages.filter((message) => message._alreadyPersisted !== true).map(persisted),
      ];
      delete document.turnCheckpoint;
    },

    async recoverOrphanedTurnCheckpoints({
      collection,
      skipConversationIds,
    }: { collection?: string; skipConversationIds?: ReadonlySet<string> } = {}) {
      let recovered = 0;
      for (const document of shared.collections.get(collection ?? "")?._docs.values() ?? []) {
        if (!document.turnCheckpoint?.messages?.length) continue;
        if (skipConversationIds?.has(document.id)) continue;
        document.messages = [...(document.messages ?? []), ...document.turnCheckpoint.messages];
        delete document.turnCheckpoint;
        recovered++;
      }
      return recovered;
    },

    async adjustPendingBackgroundTasks() {},
  };
}
