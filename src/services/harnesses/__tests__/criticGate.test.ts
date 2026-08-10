import { describe, it, expect, vi, beforeEach } from "vitest";
import CriticGate from "#src/services/harnesses/lifecycle/CriticGate";
import { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import type { ToolCall, AgenticContext } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

// The gate now streams through getProvider(chainEntry.provider) — delegate
// to the most recently created mock context's provider stub so each test's
// per-context generateTextStream mock keeps working unchanged.
let activeProviderStub: {
  generateTextStream: (...args: unknown[]) => unknown;
} | null = null;

vi.mock("#src/providers/index", () => ({
  getProvider: () => ({
    generateTextStream: (...args: unknown[]) =>
      activeProviderStub!.generateTextStream(...args),
  }),
}));

vi.mock("#src/services/ModelRoleRouter", () => ({
  MODEL_ROLES: {
    DEFAULT: "default",
    UTILITY: "utility",
    CRITIC: "critic",
    PLAN: "plan",
    VISION: "vision",
  },
  default: {
    resolveChain: vi
      .fn()
      .mockResolvedValue([{ provider: "google", model: "gemini-3.5-flash" }]),
    runWithChain: vi.fn().mockImplementation(
      async (
        chain: Array<{ provider: string; model: string }>,
        attempt: (
          entry: { provider: string; model: string },
          index: number,
        ) => Promise<unknown>,
      ) => {
        let lastError: unknown;
        for (let index = 0; index < chain.length; index++) {
          try {
            return { value: await attempt(chain[index], index), entry: chain[index] };
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError ?? new Error("empty chain");
      },
    ),
  },
}));

function createMockContext(overrides?: Partial<AgenticContext>): AgenticContext {
  const context = {
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
  activeProviderStub = (
    context as unknown as { provider: typeof activeProviderStub }
  ).provider;
  return context;
}

function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tc-1",
    name: overrides?.name ?? "execute_shell",
    args: overrides?.args ?? { command: "ls -la" },
    _approval: overrides?._approval ?? { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "danger" },
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
        _approval: { tier: APPROVAL_TIERS.AUTO as any, tierLabel: "auto" },
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
        _approval: { tier: APPROVAL_TIERS.WRITE as any, tierLabel: "write" },
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
      expect(result.criticModel).toBe("google/gemini-3.5-flash");
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

  describe("review — ambiguous responses (fail-closed)", () => {
    it("should deny on ambiguous critic response", async () => {
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

      expect(result.isApproved).toBe(false);
      expect(result.reason).toBe("critic_ambiguous_fail_closed");
    });

    it("should deny on empty critic response", async () => {
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

      expect(result.isApproved).toBe(false);
      expect(result.reason).toBe("critic_ambiguous_fail_closed");
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

      expect(result.criticModel).toBe("google/gemini-2.0-flash");
    });

    it("routes through the critic role chain — NEVER the main conversation model — when no custom model is specified", async () => {
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

      // Resolved from the critic role chain (mocked), not resolvedModel
      expect(result.criticModel).toBe("google/gemini-3.5-flash");
      expect(result.criticModel).not.toContain("claude-4-sonnet");
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

    it("should include the FULL command in the prompt — no head-only truncation", async () => {
      const gate = new CriticGate();
      // A benign 2000-char prefix used to push the dangerous tail past the
      // old 1000-char head-only slice, hiding it from the critic entirely.
      const longCommand = "A".repeat(2000) + "; rm -rf /";
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
      expect(promptContent).toContain("rm -rf /");
    });

    it("should preserve head AND tail when args exceed the review cap", async () => {
      const gate = new CriticGate();
      const toolCall = createMockToolCall({
        args: { command: "HEAD_MARKER " + "A".repeat(60_000) + " TAIL_MARKER; rm -rf /" },
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

      const promptContent = mockGenerateTextStream.mock.calls[0][0][0].content;
      expect(promptContent).toContain("HEAD_MARKER");
      expect(promptContent).toContain("TAIL_MARKER; rm -rf /");
      expect(promptContent).toContain("chars omitted");
    });
  });

  describe("createHook", () => {
    it("should return a function that calls review()", async () => {
      const gate = new CriticGate();
      const hook = gate.createHook();

      const toolCall = createMockToolCall({
        name: "read_file",
        _approval: { tier: APPROVAL_TIERS.AUTO as any, tierLabel: "auto" },
      });
      const context = createMockContext();

      const result = await hook(toolCall, context);

      expect(result.isApproved).toBe(true);
      expect(result.reason).toBe("below_danger_tier");
    });
  });
});
