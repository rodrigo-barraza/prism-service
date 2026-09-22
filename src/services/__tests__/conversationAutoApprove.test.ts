/**
 * "Auto-approve this conversation" reaches the NEXT turn of that
 * conversation — and of no other. The flag lives on the conversation
 * (ConversationApprovalSettings); runAgenticLoop reads it at turn start and
 * hands the harness `options.autoApprove`. Nothing the browser tab holds is
 * involved: the second conversation starts with the client's own value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const harnessOptionsSeen: Array<{ conversationId: string; autoApprove: unknown }> = [];

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("#src/services/ConversationApprovalSettings", () => ({
  default: {
    isAutoApproveEnabled: vi.fn(async (conversationId: string) => conversationId === "conversation-a"),
  },
}));
vi.mock("#src/services/harnesses/HarnessRegistry", () => ({
  default: {
    get: () =>
      class FakeHarness {
        static id = "fake";
        static label = "Fake";
        private context: { conversationId: string; options: Record<string, unknown> };
        constructor(context: { conversationId: string; options: Record<string, unknown> }) {
          this.context = context;
        }
        async run() {
          harnessOptionsSeen.push({
            conversationId: this.context.conversationId,
            autoApprove: this.context.options.autoApprove,
          });
          return { messages: [] };
        }
      },
    list: () => [],
  },
}));
vi.mock("#src/services/AgenticToolResolver", () => ({
  default: { resolve: vi.fn().mockResolvedValue({ finalTools: [], resolvedEnabledTools: [] }) },
}));
vi.mock("#src/services/harnesses/lifecycle/PreflightToolDiscovery", () => ({
  runPreflightToolDiscovery: vi.fn().mockResolvedValue({ enabledTools: [] }),
}));
vi.mock("#src/services/ToolContext", () => ({
  default: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    getStore: vi.fn().mockReturnValue(new Map([["dynamicEnabledTools", []], ["dynamicSeedTools", []]])),
    set: vi.fn(),
    cleanupInMemory: vi.fn(),
  },
}));
vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn().mockResolvedValue({ harness: "fake", topology: "flat", thoughtStructure: "cot" }) },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({ default: { cleanup: vi.fn() } }));
vi.mock("#src/services/ConversationStatusRegistry", () => ({ default: { remove: vi.fn() } }));
vi.mock("#src/services/OrchestratorService", () => ({ default: { cleanupConversation: vi.fn() } }));

const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");

function turn(conversationId: string, options: Record<string, unknown> = {}) {
  return AgenticLoopService.runAgenticLoop({
    conversationId,
    agentConversationId: `agent-${conversationId}`,
    project: "test",
    username: "testuser",
    isNewConversation: false,
    messages: [{ role: "user", content: "next step" }],
    options: { autoApprove: false, ...options },
    emit: vi.fn(),
  } as never);
}

describe("a conversation's persisted auto-approve", () => {
  beforeEach(() => {
    harnessOptionsSeen.length = 0;
  });

  it("turns autoApprove on for the next turn of that conversation only", async () => {
    await turn("conversation-a");
    await turn("conversation-b");

    expect(harnessOptionsSeen).toEqual([
      { conversationId: "conversation-a", autoApprove: true },
      { conversationId: "conversation-b", autoApprove: false },
    ]);
  });

  it("is not consulted for sub-agents — they inherit the parent's mode", async () => {
    await turn("conversation-a", { isSubAgent: true });
    expect(harnessOptionsSeen).toEqual([{ conversationId: "conversation-a", autoApprove: false }]);
  });
});
