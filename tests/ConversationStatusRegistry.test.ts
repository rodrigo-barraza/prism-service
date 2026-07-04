import { describe, it, expect, beforeEach } from "vitest";

// Use a fresh import per test suite — the module is a singleton Map.
const { default: ConversationStatusRegistry } = await import(
  "../src/services/ConversationStatusRegistry.ts"
);

const TEST_CONVERSATION_ID = "test-conv-001";
const TEST_SUB_AGENT_ID = "sub-agent-alpha";

function buildSampleStatus() {
  return {
    phase: "generating" as const,
    label: null,
    iteration: 1,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    phaseStartedAt: new Date().toISOString(),
    tokensPerSecond: null,
    activeRequests: 0,
    outputTokens: 0,
    inputTokens: 0,
    totalTokens: 0,
    subAgents: {},
  };
}

describe("ConversationStatusRegistry", () => {
  beforeEach(() => {
    // Clean up any leftover entries from previous tests
    ConversationStatusRegistry.remove(TEST_CONVERSATION_ID);
  });

  describe("set / get", () => {
    it("stores and retrieves a full status entry", () => {
      const status = buildSampleStatus();
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, status);

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.phase).toBe("generating");
      expect(retrieved!.iteration).toBe(1);
      expect(retrieved!.maxIterations).toBe(10);
    });

    it("returns null for unknown conversation IDs", () => {
      expect(ConversationStatusRegistry.get("nonexistent")).toBeNull();
    });

    it("overwrites existing entries on set", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());
      const updatedStatus = {
        ...buildSampleStatus(),
        phase: "thinking",
        iteration: 5,
      };
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, updatedStatus);

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.phase).toBe("thinking");
      expect(retrieved!.iteration).toBe(5);
    });
  });

  describe("patch", () => {
    it("merges partial updates into an existing entry", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());
      ConversationStatusRegistry.patch(TEST_CONVERSATION_ID, {
        iteration: 3,
        tokensPerSecond: 42.5,
      });

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.iteration).toBe(3);
      expect(retrieved!.tokensPerSecond).toBe(42.5);
      expect(retrieved!.phase).toBe("generating"); // unchanged
    });

    it("updates phaseStartedAt when phase changes", () => {
      const oldTimestamp = "2020-01-01T00:00:00.000Z";
      const initialStatus = buildSampleStatus();
      initialStatus.phaseStartedAt = oldTimestamp;
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, initialStatus);

      ConversationStatusRegistry.patch(TEST_CONVERSATION_ID, {
        phase: "executing",
      });

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.phase).toBe("executing");
      // phaseStartedAt should have been updated to a recent timestamp
      expect(retrieved!.phaseStartedAt).not.toBe(oldTimestamp);
    });

    it("does not update phaseStartedAt when phase stays the same", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());
      const originalPhaseStartedAt = ConversationStatusRegistry.get(
        TEST_CONVERSATION_ID,
      )!.phaseStartedAt;

      ConversationStatusRegistry.patch(TEST_CONVERSATION_ID, {
        phase: "generating", // same phase
        iteration: 2,
      });

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.phaseStartedAt).toBe(originalPhaseStartedAt);
    });

    it("creates a new entry with defaults when patching a nonexistent conversation", () => {
      ConversationStatusRegistry.patch("new-conv", {
        phase: "thinking",
        iteration: 1,
      });

      const retrieved = ConversationStatusRegistry.get("new-conv");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.phase).toBe("thinking");
      expect(retrieved!.iteration).toBe(1);
      expect(retrieved!.subAgents).toEqual({});

      // Cleanup
      ConversationStatusRegistry.remove("new-conv");
    });
  });

  describe("remove", () => {
    it("removes an existing entry", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());
      expect(ConversationStatusRegistry.get(TEST_CONVERSATION_ID)).not.toBeNull();

      ConversationStatusRegistry.remove(TEST_CONVERSATION_ID);
      expect(ConversationStatusRegistry.get(TEST_CONVERSATION_ID)).toBeNull();
    });

    it("is a no-op for nonexistent conversations", () => {
      // Should not throw
      ConversationStatusRegistry.remove("nonexistent");
    });
  });

  describe("sub-agent management", () => {
    it("patches a sub-agent entry within a parent conversation", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());

      ConversationStatusRegistry.patchSubAgent(
        TEST_CONVERSATION_ID,
        TEST_SUB_AGENT_ID,
        { phase: "generating", label: "Writing code..." },
      );

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.subAgents[TEST_SUB_AGENT_ID]).toBeDefined();
      expect(retrieved!.subAgents[TEST_SUB_AGENT_ID].phase).toBe("generating");
      expect(retrieved!.subAgents[TEST_SUB_AGENT_ID].label).toBe("Writing code...");
    });

    it("merges partial sub-agent updates", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());

      ConversationStatusRegistry.patchSubAgent(
        TEST_CONVERSATION_ID,
        TEST_SUB_AGENT_ID,
        { phase: "generating", conversationId: "sub-conv-001" },
      );
      ConversationStatusRegistry.patchSubAgent(
        TEST_CONVERSATION_ID,
        TEST_SUB_AGENT_ID,
        { phase: "thinking" },
      );

      const subAgent =
        ConversationStatusRegistry.get(TEST_CONVERSATION_ID)!.subAgents[
          TEST_SUB_AGENT_ID
        ];
      expect(subAgent.phase).toBe("thinking");
      expect(subAgent.conversationId).toBe("sub-conv-001"); // preserved
    });

    it("removes a sub-agent entry", () => {
      ConversationStatusRegistry.set(TEST_CONVERSATION_ID, buildSampleStatus());
      ConversationStatusRegistry.patchSubAgent(
        TEST_CONVERSATION_ID,
        TEST_SUB_AGENT_ID,
        { phase: "generating" },
      );

      ConversationStatusRegistry.removeSubAgent(
        TEST_CONVERSATION_ID,
        TEST_SUB_AGENT_ID,
      );

      const retrieved = ConversationStatusRegistry.get(TEST_CONVERSATION_ID);
      expect(retrieved!.subAgents[TEST_SUB_AGENT_ID]).toBeUndefined();
    });

    it("is a no-op when removing a sub-agent from a nonexistent parent", () => {
      // Should not throw
      ConversationStatusRegistry.removeSubAgent("nonexistent", TEST_SUB_AGENT_ID);
    });
  });

  describe("activeCount", () => {
    it("tracks the number of active entries", () => {
      const initialCount = ConversationStatusRegistry.activeCount;

      ConversationStatusRegistry.set("count-test-1", buildSampleStatus());
      ConversationStatusRegistry.set("count-test-2", buildSampleStatus());
      expect(ConversationStatusRegistry.activeCount).toBe(initialCount + 2);

      ConversationStatusRegistry.remove("count-test-1");
      expect(ConversationStatusRegistry.activeCount).toBe(initialCount + 1);

      ConversationStatusRegistry.remove("count-test-2");
      expect(ConversationStatusRegistry.activeCount).toBe(initialCount);
    });
  });
});
