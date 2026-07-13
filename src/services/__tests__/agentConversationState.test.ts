/**
 * Canonical agent-conversation state ladder — regression tests.
 *
 * `deriveAgentConversationState` computes the activity state served as
 * `state` on conversation list/detail responses. It mirrors the client-side
 * ladder in prism-client/src/utils/agentConversationStates.ts — the two must
 * stay in sync (the client keeps a copy because live sidebar surfaces derive
 * from SSE-patched props where a server snapshot would go stale).
 *
 * Priority order under test: generating → orchestrating → completed →
 * completed-with-errors → sub-agents-running → background-tasks → active.
 */
import { describe, it, expect } from "vitest";
import {
  attachConversationState,
  deriveAgentConversationState,
} from "#src/services/ConversationService";

describe("deriveAgentConversationState", () => {
  it("returns 'generating' when isGenerating and no sub-agents", () => {
    expect(
      deriveAgentConversationState({ isGenerating: true, isActive: true }),
    ).toBe("generating");
  });

  it("returns 'orchestrating' when isGenerating with sub-agents", () => {
    expect(
      deriveAgentConversationState({ isGenerating: true, hasSubAgents: true }),
    ).toBe("orchestrating");
  });

  it("prioritizes isGenerating over an explicitly ended session (stale isActive window)", () => {
    expect(
      deriveAgentConversationState({ isGenerating: true, isActive: false }),
    ).toBe("generating");
  });

  it("returns 'completed' when the session explicitly ended without errors", () => {
    expect(deriveAgentConversationState({ isActive: false })).toBe("completed");
    expect(
      deriveAgentConversationState({ isActive: false, requestErrorCount: 0 }),
    ).toBe("completed");
  });

  it("returns 'completed-with-errors' when ended with request errors", () => {
    expect(
      deriveAgentConversationState({ isActive: false, requestErrorCount: 2 }),
    ).toBe("completed-with-errors");
  });

  it("returns 'sub-agents-running' for pending tasks with sub-agents", () => {
    expect(
      deriveAgentConversationState({
        isActive: true,
        pendingBackgroundTasks: 3,
        hasSubAgents: true,
      }),
    ).toBe("sub-agents-running");
  });

  it("returns 'background-tasks' for pending tasks without sub-agents", () => {
    expect(
      deriveAgentConversationState({
        isActive: true,
        pendingBackgroundTasks: 1,
      }),
    ).toBe("background-tasks");
  });

  it("returns 'active' when nothing else applies (including missing isActive)", () => {
    expect(deriveAgentConversationState({ isActive: true })).toBe("active");
    expect(deriveAgentConversationState({})).toBe("active");
    expect(
      deriveAgentConversationState({ pendingBackgroundTasks: 0 }),
    ).toBe("active");
  });

  it("does not treat errors on a still-active conversation as completed-with-errors", () => {
    expect(
      deriveAgentConversationState({ isActive: true, requestErrorCount: 5 }),
    ).toBe("active");
  });
});

describe("attachConversationState", () => {
  it("stamps the derived state onto the record in place", () => {
    const record: Record<string, unknown> = {
      id: "conversation-1",
      isGenerating: true,
      hasSubAgents: true,
    };
    attachConversationState(record);
    expect(record.state).toBe("orchestrating");
  });

  it("stamps 'completed-with-errors' after error enrichment", () => {
    const record: Record<string, unknown> = {
      id: "conversation-2",
      isActive: false,
      requestErrorCount: 1,
    };
    attachConversationState(record);
    expect(record.state).toBe("completed-with-errors");
  });
});
