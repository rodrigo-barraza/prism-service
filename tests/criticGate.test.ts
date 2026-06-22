import { describe, it, expect, vi, beforeEach } from "vitest";
import CriticGate from "../src/services/harnesses/lifecycle/CriticGate.ts";
import { APPROVAL_TIERS } from "../src/services/AutoApprovalEngine.ts";
import type { ToolCall, AgenticContext } from "../src/services/harnesses/types.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

function createMockContext(overrides?: Partial<AgenticContext>): AgenticContext {
  return {
    project: "test",
    username: "user",
    agent: "CODING",
    providerName: "google",
    resolvedModel: "gemini-3.5-flash",
    traceId: "trace-critic",
    agentConversationId: "session-critic",
    conversationId: "conv-critic",
    requestId: "req-critic",
    emit: vi.fn(),
    options: {},
    provider: {
      generateTextStream: vi.fn(),
    },
    ...overrides,
  } as unknown as AgenticContext;
}

function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tc-1",
    name: overrides?.name ?? "execute_shell",
    args: overrides?.args ?? { command: "ls -la" },
    _approval: overrides?._approval ?? { tier: APPROVAL_TIERS.DANGER },
    ...overrides,
  } as ToolCall;
}

describe("CriticGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("review — tier filtering", () => {
    it("should auto-approve tools below DANGER tier (SAFE)", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({
        name: "read_file",
        _approval: { tier: APPROVAL_TIERS.SAFE },
      });
      const context = createMockContext();

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("below_danger_tier");
    });

    it("should auto-approve tools below DANGER tier (WRITE)", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({
        name: "write_file",
        _approval: { tier: APPROVAL_TIERS.WRITE },
      });
      const context = createMockContext();

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("below_danger_tier");
    });

    it("should default to WRITE tier when _approval is undefined", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({ _approval: undefined });
      const context = createMockContext();

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("below_danger_tier");
    });
  });

  describe("review — skipCritic option", () => {
    it("should skip critic review when skipCritic option is true", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();
      const context = createMockContext({ options: { skipCritic: true } as any });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_skipped");
    });
  });

  describe("review — APPROVE responses", () => {
    it("should approve when critic responds with APPROVE", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "APPROVE";
        yield "\nCommand is safe.";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_approved");
      expect(result.criticModel).toBe("gemini-3.5-flash");
    });

    it("should approve when critic responds with 'APPROVE - safe'", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "APPROVE - Command appears safe\nNo issues found.";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_approved");
    });
  });

  describe("review — DENY responses", () => {
    it("should deny when critic responds with DENY and provide reason", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({
        args: { command: "rm -rf /" },
      });

      async function* mockStream() {
        yield "DENY\nDestructive command: rm -rf / would delete all files.";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(false);
      expect(result.reason).toContain("Destructive command");
    });

    it("should use default denial reason when no explanation follows DENY", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "DENY";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(false);
      expect(result.reason).toBe("critic_denied");
    });
  });

  describe("review — ambiguous responses", () => {
    it("should default to approve on ambiguous critic response", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "I'm not sure about this one. It looks okay I guess?";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_parse_fallback");
    });

    it("should default to approve on empty critic response", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_parse_fallback");
    });
  });

  describe("review — error handling (fail-open)", () => {
    it("should fail-open when critic model throws an error", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockImplementation(() => {
            throw new Error("Model unavailable");
          }),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_error_fallback");
    });

    it("should fail-open when stream iterator throws", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* failingStream() {
        yield "APPR";
        throw new Error("Connection reset");
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(failingStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("critic_error_fallback");
    });
  });

  describe("custom critic model", () => {
    it("should use custom critic model from constructor options", async () => {
      const gate = new CriticGate({ model: "gemini-2.0-flash" });
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "APPROVE";
      }
      const context = createMockContext({
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.criticModel).toBe("gemini-2.0-flash");
    });

    it("should fall back to context.resolvedModel when no custom model specified", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall();

      async function* mockStream() {
        yield "APPROVE";
      }
      const context = createMockContext({
        resolvedModel: "claude-4-sonnet",
        provider: {
          generateTextStream: vi.fn().mockReturnValue(mockStream()),
        } as any,
      });

      const result = await gate.review(toolCall, context);

      expect(result.criticModel).toBe("claude-4-sonnet");
    });
  });

  describe("review prompt construction", () => {
    it("should include tool name and arguments in the review prompt sent to critic", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({
        name: "execute_shell",
        args: { command: "sudo apt-get install something" },
      });

      async function* mockStream() {
        yield "APPROVE";
      }
      const mockGenerateTextStream = vi.fn().mockReturnValue(mockStream());
      const context = createMockContext({
        provider: {
          generateTextStream: mockGenerateTextStream,
        } as any,
      });

      await gate.review(toolCall, context);

      const calledMessages = mockGenerateTextStream.mock.calls[0][0];
      const promptContent = calledMessages[0].content;
      expect(promptContent).toContain("execute_shell");
      expect(promptContent).toContain("sudo apt-get install something");
      expect(promptContent).toContain("APPROVE or DENY");
    });

    it("should truncate arguments longer than 1000 chars", async () => {
      const gate = new CriticGate();
      const longCommand = "A".repeat(2000);
      const toolCall = createMockToolCall({
        args: { command: longCommand },
      });

      async function* mockStream() {
        yield "APPROVE";
      }
      const mockGenerateTextStream = vi.fn().mockReturnValue(mockStream());
      const context = createMockContext({
        provider: {
          generateTextStream: mockGenerateTextStream,
        } as any,
      });

      await gate.review(toolCall, context);

      const calledMessages = mockGenerateTextStream.mock.calls[0][0];
      const promptContent = calledMessages[0].content;
      // The full JSON would be >2000 chars but should be sliced to 1000 max
      expect(promptContent.length).toBeLessThan(1500);
    });
  });

  describe("createHook", () => {
    it("should return a function that calls review()", async () => {
      const gate = new CriticGate();
      const hook = gate.createHook();

      const toolCall = createMockToolCall({
        name: "read_file",
        _approval: { tier: APPROVAL_TIERS.SAFE },
      });
      const context = createMockContext();

      const result = await hook(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("below_danger_tier");
    });
  });
});
