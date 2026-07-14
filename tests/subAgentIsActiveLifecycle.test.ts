/**
 * Sub-agent isActive/isGenerating lifecycle — regression tests.
 *
 * Bug: sub-agent conversation documents were never marked isActive:true while
 * running, so the client's live-stream gate (which reduces to the persisted
 * isActive flag for a merely-viewed conversation) never opened the WebSocket
 * subscription — a viewed sub-agent conversation showed nothing until the
 * sub-agent finished and the completed messages were fetched from the DB.
 *
 * Invariant under test: the sub-agent's agent_conversations document carries
 * isActive:true + isGenerating:true exactly while the sub-agent runs:
 * - registerSubAgent (spawn)          → raised
 * - markSubAgentActive (continue)     → raised again after re-activation
 * - markSubAgentTerminal (all ends)   → cleared, terminal status persisted
 * - SubAgentLifecycleService stop/abort → cleared via the same write path
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

const PARENT_CONVERSATION_ID = "parent-conv-1";
const SUB_AGENT_CONVERSATION_ID = "sub-conv-1";
const TEST_PROJECT = "coding";
const TEST_USER = "testuser";

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
  TOOLS_SERVICE_URL: "http://localhost:5590",
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(),
    getCollection: vi.fn(),
  },
}));

const MongoWrapper = (await import("#src/wrappers/MongoWrapper")).default;
const { SubAgentPersistenceService } = await import(
  "#src/services/orchestrator/SubAgentPersistenceService"
);
const { SubAgentLifecycleService } = await import(
  "#src/services/orchestrator/SubAgentLifecycleService"
);
const { SYSTEM_STATUSES } = await import("#src/constants");
import type { SubAgentState } from "#src/types/orchestrator";

let mockCollection: ReturnType<typeof createMockCollection>;

const REGISTER_ARGUMENTS = {
  parentConversationId: PARENT_CONVERSATION_ID,
  project: TEST_PROJECT,
  username: TEST_USER,
  subAgentConversationId: SUB_AGENT_CONVERSATION_ID,
  agentId: "agent-1",
  description: "Test sub-agent",
  subAgentProvider: "anthropic",
  subAgentModel: "claude-sonnet-5",
  currentRecursionDepth: 0,
  branchName: null,
  files: [],
  agentConversationId: "agent-conv-1",
  subAgentAgentType: null,
  worktreeError: null,
};

function createSubAgentState(
  overrides: Partial<SubAgentState> = {},
): SubAgentState {
  return {
    agentId: "agent-1",
    description: "Test sub-agent",
    status: SYSTEM_STATUSES.RUNNING,
    startedAt: Date.now() - 1000,
    subAgentConversationId: SUB_AGENT_CONVERSATION_ID,
    parentConversationId: PARENT_CONVERSATION_ID,
    abortController: new AbortController(),
    isolated: false,
    worktreePath: null,
    repositoryPath: null,
    ...overrides,
  } as unknown as SubAgentState;
}

async function getSubAgentDocument(): Promise<Record<string, any> | null> {
  return await mockCollection.findOne({ id: SUB_AGENT_CONVERSATION_ID });
}

describe("sub-agent isActive lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection = createMockCollection();
    vi.mocked(MongoWrapper.getCollection).mockReturnValue(
      mockCollection as unknown as ReturnType<typeof MongoWrapper.getCollection>,
    );
  });

  describe("registerSubAgent (spawn)", () => {
    it("marks a freshly-created child conversation isActive + isGenerating", async () => {
      await SubAgentPersistenceService.registerSubAgent(REGISTER_ARGUMENTS);

      const document = await getSubAgentDocument();
      expect(document).not.toBeNull();
      expect(document?.isActive).toBe(true);
      expect(document?.isGenerating).toBe(true);
      expect(document?.isSubAgent).toBe(true);
      expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.RUNNING);
      expect(document?.updatedAt).toBeDefined();
    });

    it("re-raises the flags on an existing child conversation document", async () => {
      mockCollection._setData([
        {
          id: SUB_AGENT_CONVERSATION_ID,
          isActive: false,
          isGenerating: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      await SubAgentPersistenceService.registerSubAgent(REGISTER_ARGUMENTS);

      const document = await getSubAgentDocument();
      expect(document?.isActive).toBe(true);
      expect(document?.isGenerating).toBe(true);
      // $setOnInsert must not clobber the existing creation timestamp
      expect(document?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("still records the child on the parent (hasSubAgents + subAgentIds)", async () => {
      mockCollection._setData([
        {
          id: PARENT_CONVERSATION_ID,
          project: TEST_PROJECT,
          username: TEST_USER,
        },
      ]);

      await SubAgentPersistenceService.registerSubAgent(REGISTER_ARGUMENTS);

      const parent = await mockCollection.findOne({ id: PARENT_CONVERSATION_ID });
      expect(parent?.hasSubAgents).toBe(true);
      expect(parent?.subAgentIds).toEqual([SUB_AGENT_CONVERSATION_ID]);
    });
  });

  describe("markSubAgentTerminal", () => {
    it("clears isActive/isGenerating and persists the terminal status", async () => {
      mockCollection._setData([
        {
          id: SUB_AGENT_CONVERSATION_ID,
          isActive: true,
          isGenerating: true,
          subAgentStatus: SYSTEM_STATUSES.RUNNING,
        },
      ]);

      await SubAgentPersistenceService.markSubAgentTerminal({
        subAgentConversationId: SUB_AGENT_CONVERSATION_ID,
        status: SYSTEM_STATUSES.COMPLETE,
        extraFields: {
          subAgentDurationMilliseconds: 1234,
          subAgentToolUses: 3,
        },
      });

      const document = await getSubAgentDocument();
      expect(document?.isActive).toBe(false);
      expect(document?.isGenerating).toBe(false);
      expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.COMPLETE);
      expect(document?.subAgentCompletedAt).toBeDefined();
      expect(document?.subAgentDurationMilliseconds).toBe(1234);
      expect(document?.subAgentToolUses).toBe(3);
    });

    it("does not throw when the conversation document is missing", async () => {
      await expect(
        SubAgentPersistenceService.markSubAgentTerminal({
          subAgentConversationId: "nonexistent-conv",
          status: SYSTEM_STATUSES.FAILED,
        }),
      ).resolves.toBeUndefined();
    });

    it("does not throw when the MongoDB connection is unavailable", async () => {
      vi.mocked(MongoWrapper.getCollection).mockReturnValue(
        null as unknown as ReturnType<typeof MongoWrapper.getCollection>,
      );

      await expect(
        SubAgentPersistenceService.markSubAgentTerminal({
          subAgentConversationId: SUB_AGENT_CONVERSATION_ID,
          status: SYSTEM_STATUSES.FAILED,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("markSubAgentActive (continuation/resume)", () => {
    it("re-raises the flags and running status on a completed document", async () => {
      mockCollection._setData([
        {
          id: SUB_AGENT_CONVERSATION_ID,
          isActive: false,
          isGenerating: false,
          subAgentStatus: SYSTEM_STATUSES.COMPLETE,
        },
      ]);

      await SubAgentPersistenceService.markSubAgentActive(
        SUB_AGENT_CONVERSATION_ID,
      );

      const document = await getSubAgentDocument();
      expect(document?.isActive).toBe(true);
      expect(document?.isGenerating).toBe(true);
      expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.RUNNING);
    });
  });

  describe("SubAgentLifecycleService stop/abort", () => {
    it("stopSubAgent clears the lifecycle flags on the child document", async () => {
      mockCollection._setData([
        {
          id: SUB_AGENT_CONVERSATION_ID,
          isActive: true,
          isGenerating: true,
          subAgentStatus: SYSTEM_STATUSES.RUNNING,
        },
      ]);
      const subAgent = createSubAgentState();
      const activeSubAgents = new Map([["agent-1", subAgent]]);

      const result = await SubAgentLifecycleService.stopSubAgent(
        "agent-1",
        activeSubAgents,
      );

      expect("error" in result).toBe(false);
      const document = await getSubAgentDocument();
      expect(document?.isActive).toBe(false);
      expect(document?.isGenerating).toBe(false);
      expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.STOPPED);
      expect(document?.subAgentCompletedAt).toBeDefined();
    });

    it("abortSubAgentsByConversation clears the flags for every running child", async () => {
      mockCollection._setData([
        {
          id: "sub-conv-a",
          isActive: true,
          isGenerating: true,
          subAgentStatus: SYSTEM_STATUSES.RUNNING,
        },
        {
          id: "sub-conv-b",
          isActive: true,
          isGenerating: true,
          subAgentStatus: SYSTEM_STATUSES.RUNNING,
        },
      ]);
      const activeSubAgents = new Map([
        [
          "agent-a",
          createSubAgentState({
            agentId: "agent-a",
            subAgentConversationId: "sub-conv-a",
          }),
        ],
        [
          "agent-b",
          createSubAgentState({
            agentId: "agent-b",
            subAgentConversationId: "sub-conv-b",
          }),
        ],
      ]);

      await SubAgentLifecycleService.abortSubAgentsByConversation(
        PARENT_CONVERSATION_ID,
        activeSubAgents,
      );

      for (const conversationId of ["sub-conv-a", "sub-conv-b"]) {
        const document = await mockCollection.findOne({ id: conversationId });
        expect(document?.isActive).toBe(false);
        expect(document?.isGenerating).toBe(false);
        expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.STOPPED);
      }
    });
  });

  describe("full lifecycle arc", () => {
    it("spawn → active, terminal → inactive, continue → active again", async () => {
      await SubAgentPersistenceService.registerSubAgent(REGISTER_ARGUMENTS);
      let document = await getSubAgentDocument();
      expect(document?.isActive).toBe(true);

      await SubAgentPersistenceService.markSubAgentTerminal({
        subAgentConversationId: SUB_AGENT_CONVERSATION_ID,
        status: SYSTEM_STATUSES.COMPLETE,
      });
      document = await getSubAgentDocument();
      expect(document?.isActive).toBe(false);

      await SubAgentPersistenceService.markSubAgentActive(
        SUB_AGENT_CONVERSATION_ID,
      );
      document = await getSubAgentDocument();
      expect(document?.isActive).toBe(true);
      expect(document?.subAgentStatus).toBe(SYSTEM_STATUSES.RUNNING);
    });
  });
});
