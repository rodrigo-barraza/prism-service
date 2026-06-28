import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isAtOutputCeiling,
  calculateEscalatedMaxTokens,
} from "../src/services/harnesses/lifecycle/OutputTruncationRecovery.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_INPUT_TOKENS,
  OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../src/constants/TokenBudgetDefaults.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";
import type {
  ConversationMessage,
  AgenticContext,
} from "../src/services/harnesses/types.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/services/ConversationGenerationTracker.ts", () => ({
  default: { registerRequest: vi.fn(), finalizeRequest: vi.fn() },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: { log: vi.fn() },
}));

function createMinimalHarness(
  overrides: Partial<AgenticContext> = {},
): BaseAgenticHarness {
  const context = {
    provider: {
      generateTextStream: vi.fn(),
      generateTextStreamLive: vi.fn(),
    },
    resolvedModel: "test-model",
    modelDefinition: {
      maxInputTokens: 90_000,
      maxOutputTokens: 64_000,
    },
    options: { maxTokens: 64_000 },
    emit: vi.fn(),
    signal: undefined,
    ...overrides,
  } as unknown as AgenticContext;

  return new (BaseAgenticHarness as any)(
    context,
    { iterations: 0, originalMessageCount: 0 },
    { finalTools: [], allowedToolNames: new Set() },
  );
}

function createMessage(content: string, role = "user"): ConversationMessage {
  return { role, content } as ConversationMessage;
}

function createMessagesWithTokenCount(targetTokens: number): ConversationMessage[] {
  const characterCount = targetTokens * 4;
  return [createMessage("x".repeat(characterCount))];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  isAtOutputCeiling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("isAtOutputCeiling", () => {
  it("should return true when maxTokens equals the model ceiling", () => {
    expect(isAtOutputCeiling(64_000, 64_000)).toBe(true);
  });

  it("should return true when maxTokens exceeds the model ceiling", () => {
    expect(isAtOutputCeiling(80_000, 64_000)).toBe(true);
  });

  it("should return false when maxTokens is below the model ceiling", () => {
    expect(isAtOutputCeiling(16_384, 64_000)).toBe(false);
  });

  it("should return false when model ceiling is undefined", () => {
    expect(isAtOutputCeiling(64_000, undefined)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  calculateEscalatedMaxTokens (with ceiling)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("calculateEscalatedMaxTokens — ceiling clamping", () => {
  it("should clamp to ceiling when escalated value exceeds it", () => {
    const escalated = calculateEscalatedMaxTokens(50_000, 1, 64_000);
    expect(escalated).toBe(64_000);
  });

  it("should not clamp when escalated value is below ceiling", () => {
    const escalated = calculateEscalatedMaxTokens(8_192, 1, 64_000);
    const expectedEscalated = Math.ceil(8_192 * 1.5);
    expect(escalated).toBe(expectedEscalated);
  });

  it("should return unclamped value when no ceiling is provided", () => {
    const escalated = calculateEscalatedMaxTokens(50_000, 1);
    const expectedEscalated = Math.ceil(50_000 * 1.5);
    expect(escalated).toBe(expectedEscalated);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Dynamic Output Token Clamping (BaseAgenticHarness)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Dynamic Output Token Clamping", () => {
  let harness: BaseAgenticHarness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("clampOutputTokens (via prototype access)", () => {
    it("should not clamp when maxTokens + input fits within context window", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 128_000 },
        options: { maxTokens: 16_384 },
      } as any);

      const messages = createMessagesWithTokenCount(10_000);
      const clamped = (harness as any).clampOutputTokens(messages, 16_384);

      expect(clamped).toBe(16_384);
    });

    it("should clamp when maxTokens + input exceeds context window", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 90_000 },
        options: { maxTokens: 64_000 },
      } as any);

      const messages = createMessagesWithTokenCount(30_000);
      const clamped = (harness as any).clampOutputTokens(messages, 64_000);

      const expectedClamped = 90_000 - 30_000 - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
      expect(clamped).toBe(expectedClamped);
      expect(clamped).toBeLessThan(64_000);
    });

    it("should reproduce the exact Gemma 4 12B failure scenario (90K context, 64K output, ~26K input)", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 90_000 },
        options: { maxTokens: 64_000 },
      } as any);

      const messages = createMessagesWithTokenCount(26_001);
      const clamped = (harness as any).clampOutputTokens(messages, 64_000);

      // Without clamping: 26001 + 64000 = 90001 > 90000 → 400 error
      expect(26_001 + 64_000).toBeGreaterThan(90_000);

      // With clamping: should fit
      expect(26_001 + clamped + OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN).toBeLessThanOrEqual(90_000);
      expect(clamped).toBe(90_000 - 26_001 - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN);
    });

    it("should floor at MINIMUM_CLAMPED_OUTPUT_TOKENS when context is nearly exhausted", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 32_000 },
        options: { maxTokens: 16_384 },
      } as any);

      const messages = createMessagesWithTokenCount(31_500);
      const clamped = (harness as any).clampOutputTokens(messages, 16_384);

      expect(clamped).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });

    it("should return undefined when maxTokens is undefined", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 90_000 },
      } as any);

      const messages = createMessagesWithTokenCount(10_000);
      const clamped = (harness as any).clampOutputTokens(messages, undefined);

      expect(clamped).toBeUndefined();
    });

    it("should return original value when context window is unknown", () => {
      harness = createMinimalHarness({
        modelDefinition: {},
        options: { maxTokens: 64_000 },
      } as any);

      const messages = createMessagesWithTokenCount(30_000);
      const clamped = (harness as any).clampOutputTokens(messages, 64_000);

      expect(clamped).toBe(64_000);
    });

    it("should account for the safety margin in the clamped value", () => {
      harness = createMinimalHarness({
        modelDefinition: { maxInputTokens: 50_000 },
        options: { maxTokens: 40_000 },
      } as any);

      const messages = createMessagesWithTokenCount(15_000);
      const clamped = (harness as any).clampOutputTokens(messages, 40_000);

      const expectedWithoutMargin = 50_000 - 15_000;
      const expectedWithMargin = expectedWithoutMargin - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
      expect(clamped).toBe(expectedWithMargin);
      expect(clamped).toBeLessThan(expectedWithoutMargin);
    });
  });

  describe("estimateInputTokens (via prototype access)", () => {
    it("should estimate plain text messages at ~4 chars per token", () => {
      harness = createMinimalHarness();

      const messages = [createMessage("a".repeat(4000))];
      const estimated = (harness as any).estimateInputTokens(messages);

      expect(estimated).toBe(1000);
    });

    it("should sum tokens across multiple messages", () => {
      harness = createMinimalHarness();

      const messages = [
        createMessage("a".repeat(4000)),
        createMessage("b".repeat(8000)),
      ];
      const estimated = (harness as any).estimateInputTokens(messages);

      expect(estimated).toBe(3000);
    });

    it("should include thinking content in the estimate", () => {
      harness = createMinimalHarness();

      const messages = [{
        role: "assistant",
        content: "a".repeat(4000),
        thinking: "b".repeat(8000),
      }] as ConversationMessage[];
      const estimated = (harness as any).estimateInputTokens(messages);

      expect(estimated).toBe(3000);
    });

    it("should include tool_calls JSON in the estimate", () => {
      harness = createMinimalHarness();

      const toolCallsJson = JSON.stringify([{ name: "test", arguments: { query: "hello" } }]);
      const messages = [{
        role: "assistant",
        content: "",
        tool_calls: [{ name: "test", arguments: { query: "hello" } }],
      }] as unknown as ConversationMessage[];
      const estimated = (harness as any).estimateInputTokens(messages);

      expect(estimated).toBe(Math.ceil(toolCallsJson.length / 4));
    });

    it("should add 1000 tokens per image", () => {
      harness = createMinimalHarness();

      const messages = [{
        role: "user",
        content: "",
        images: ["data:image/png;base64,abc", "data:image/png;base64,def"],
      }] as unknown as ConversationMessage[];
      const estimated = (harness as any).estimateInputTokens(messages);

      expect(estimated).toBe(2000);
    });

    it("should return 0 for empty message array", () => {
      harness = createMinimalHarness();
      const estimated = (harness as any).estimateInputTokens([]);
      expect(estimated).toBe(0);
    });
  });

  describe("createProviderStream — integration with clamping", () => {
    it("should pass clamped maxTokens to the provider when overflow would occur", () => {
      const mockGenerateTextStream = vi.fn().mockReturnValue((async function* () {})());

      harness = createMinimalHarness({
        provider: {
          generateTextStream: mockGenerateTextStream,
        },
        modelDefinition: { maxInputTokens: 90_000 },
        options: { maxTokens: 64_000 },
      } as any);

      const messages = createMessagesWithTokenCount(30_000);
      harness.createProviderStream(messages, { maxTokens: 64_000 } as any);

      const passedOptions = mockGenerateTextStream.mock.calls[0][2];
      const expectedClamped = 90_000 - 30_000 - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
      expect(passedOptions.maxTokens).toBe(expectedClamped);
      expect(passedOptions.maxTokens).toBeLessThan(64_000);
    });

    it("should pass original maxTokens when no clamping is needed", () => {
      const mockGenerateTextStream = vi.fn().mockReturnValue((async function* () {})());

      harness = createMinimalHarness({
        provider: {
          generateTextStream: mockGenerateTextStream,
        },
        modelDefinition: { maxInputTokens: 200_000 },
        options: { maxTokens: 16_384 },
      } as any);

      const messages = createMessagesWithTokenCount(10_000);
      harness.createProviderStream(messages, { maxTokens: 16_384 } as any);

      const passedOptions = mockGenerateTextStream.mock.calls[0][2];
      expect(passedOptions.maxTokens).toBe(16_384);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Constants Verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("TokenBudgetDefaults — constant values", () => {
  it("DEFAULT_MAX_OUTPUT_TOKENS should be 16384", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16_384);
  });

  it("DEFAULT_MAX_INPUT_TOKENS should be 128000", () => {
    expect(DEFAULT_MAX_INPUT_TOKENS).toBe(128_000);
  });

  it("OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN should be 256", () => {
    expect(OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN).toBe(256);
  });

  it("MINIMUM_CLAMPED_OUTPUT_TOKENS should be 1024", () => {
    expect(MINIMUM_CLAMPED_OUTPUT_TOKENS).toBe(1_024);
  });
});
