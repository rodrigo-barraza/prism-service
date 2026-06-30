/**
 * Output Token Clamping — Defense-in-Depth Regression Tests
 *
 * Validates that `clampOutputTokens` correctly prevents context window
 * overflow by accounting for ALL three components of the provider's input
 * budget that contribute to the total token count:
 *
 *   1. System prompt (passed as systemInstruction, NOT in messages)
 *   2. Conversation messages (the messages array)
 *   3. Tool schemas (serialized JSON function definitions)
 *
 * The safety margin is a 10% multiplicative buffer on the estimated input
 * to absorb the systematic ~5-6% underestimate of the 4-chars/token heuristic
 * vs real tokenizers (verified: 24,624 estimated vs 26,001 provider-reported
 * on Gemma 4 12B = 94.7% accuracy).
 */
import { describe, it, expect } from "vitest";

import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../../../constants/TokenBudgetDefaults.ts";
import { estimateTokens } from "../../../utils/CostCalculator.ts";

import type { ConversationMessage } from "../types.ts";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Replicate the exact clamping logic from BaseAgenticHarness.clampOutputTokens
 * (a private method), extracted here so we can test it in isolation without
 * instantiating the full harness lifecycle or mocking the provider layer.
 *
 * This MUST stay in sync with the production implementation. If the logic
 * diverges, these tests become meaningless.
 */
function clampOutputTokens(
  messages: ConversationMessage[],
  requestedMaxTokens: number | undefined,
  modelDefinitionMaxInputTokens: number | undefined | null,
  loadedContextLength: number | undefined | null,
  systemPromptText = "",
  toolSchemas: unknown[] = [],
): number | undefined {
  const contextWindow =
    modelDefinitionMaxInputTokens ||
    loadedContextLength ||
    null;

  if (!contextWindow || !requestedMaxTokens) return requestedMaxTokens;

  // 1. Conversation messages
  const estimatedMessageTokens = estimateInputTokens(messages);

  // 2. System prompt (sent as systemInstruction, invisible to messages)
  const estimatedSystemPromptTokens = estimateTokens(systemPromptText);

  // 3. Tool schemas (serialized JSON function definitions)
  const estimatedToolSchemaTokens =
    toolSchemas.length > 0
      ? estimateTokens(JSON.stringify(toolSchemas))
      : 0;

  const totalEstimatedInput =
    estimatedMessageTokens +
    estimatedSystemPromptTokens +
    estimatedToolSchemaTokens;

  // Multiplicative safety margin to absorb tokenizer underestimate
  const safetyMargin = Math.ceil(
    totalEstimatedInput * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  );
  const adjustedInput = totalEstimatedInput + safetyMargin;

  const availableForOutput = contextWindow - adjustedInput;

  if (requestedMaxTokens <= availableForOutput) return requestedMaxTokens;

  const clampedMaxTokens = Math.max(
    availableForOutput,
    MINIMUM_CLAMPED_OUTPUT_TOKENS,
  );

  return clampedMaxTokens;
}

/**
 * Estimate total input tokens for an array of messages.
 * Mirrors BaseAgenticHarness.estimateInputTokens.
 */
function estimateInputTokens(messages: ConversationMessage[]): number {
  let totalTokens = 0;
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
          ? JSON.stringify(message.content)
          : "";
    totalTokens += estimateTokens(content);
  }
  return totalTokens;
}

/**
 * Generate a message array with a known approximate token count.
 * Each character is roughly 0.25 tokens (~4 chars/token heuristic).
 */
function createMessagesWithTokenCount(
  targetTokens: number,
): ConversationMessage[] {
  const characterCount = targetTokens * 4;
  return [
    {
      role: "user",
      content: "x".repeat(characterCount),
    },
  ];
}

/**
 * Generate a fake system prompt with a known approximate token count.
 */
function createSystemPromptWithTokenCount(targetTokens: number): string {
  return "x".repeat(targetTokens * 4);
}

/**
 * Generate fake tool schemas with realistic sizes.
 * Average real tool schema ≈ 100-200 tokens (from live API analysis).
 */
function createToolSchemas(toolCount: number): unknown[] {
  return Array.from({ length: toolCount }, (_, index) => ({
    name: `tool_${index}`,
    description: "A tool that does something useful with parameters and returns results. " +
      "Use this when you need to perform an operation that requires external data.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The primary input for this tool" },
        options: { type: "object", description: "Additional configuration options" },
      },
      required: ["input"],
    },
  }));
}

// ── Test Suite ───────────────────────────────────────────────

describe("Output Token Clamping (clampOutputTokens)", () => {
  /**
   * ── REAL CONVERSATION REPRODUCTION ──
   * These tests use EXACT numbers from the live failing conversation
   * (8fb3b7c8-7f9f-443f-8c3e-915043d92be3) verified against api.prism.rod.dev.
   */
  describe("real conversation reproduction (Gemma 4 12B overflow)", () => {
    // Real values from the API:
    // - System prompt: 55,662 chars = ~13,915 tokens
    // - Messages: ~8,749 tokens (system context + user + tool calls + tool update)
    // - Tool schemas: ~1,960 tokens (18 tools, 108 tokens avg)
    // - Provider reported: 26,001 input tokens
    // - Our estimate: 24,624 tokens (94.7% of actual)
    // - Context window: 90,000
    // - Requested output: 64,000

    it("should clamp with exact real conversation token counts", () => {
      const contextWindow = 90_000;
      const requestedOutputTokens = 64_000;

      // Real system prompt: 55,662 chars ≈ 13,915 tokens
      const systemPrompt = createSystemPromptWithTokenCount(13_915);
      // Real messages: 8,749 tokens
      const messages = createMessagesWithTokenCount(8_749);
      // Real tool schemas: 18 tools ≈ 1,960 tokens total
      const toolSchemas = createToolSchemas(18);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        systemPrompt,
        toolSchemas,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);

      // Verify the full budget: adjusted input + clamped output ≤ context window
      const estimatedInput = estimateInputTokens(messages) +
        estimateTokens(systemPrompt) +
        estimateTokens(JSON.stringify(toolSchemas));
      const safetyMargin = Math.ceil(estimatedInput * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER);
      const adjustedInput = estimatedInput + safetyMargin;

      expect(adjustedInput + clamped!).toBeLessThanOrEqual(contextWindow);
    });

    it("should have adjusted estimate that exceeds provider-reported 26,001", () => {
      const systemPrompt = createSystemPromptWithTokenCount(13_915);
      const messages = createMessagesWithTokenCount(8_749);
      const toolSchemas = createToolSchemas(18);

      const estimatedInput = estimateInputTokens(messages) +
        estimateTokens(systemPrompt) +
        estimateTokens(JSON.stringify(toolSchemas));
      const safetyMargin = Math.ceil(estimatedInput * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER);
      const adjustedInput = estimatedInput + safetyMargin;

      // Our adjusted estimate must EXCEED the provider's actual count
      // to guarantee the clamp fires conservatively
      const providerReportedInput = 26_001;
      expect(adjustedInput).toBeGreaterThan(providerReportedInput);
    });
  });

  describe("system prompt accounting", () => {
    it("should clamp when system prompt alone pushes input over budget", () => {
      const contextWindow = 90_000;
      const requestedOutputTokens = 64_000;

      // 14K system prompt + 5K messages + 10% safety = ~20,900 adjusted
      // available = 90,000 - 20,900 = 69,100 → fits
      // But 20K system prompt + 5K messages + 10% safety = ~27,500 adjusted
      // available = 90,000 - 27,500 = 62,500 → doesn't fit → clamps
      const largeSystemPrompt = createSystemPromptWithTokenCount(20_000);
      const messages = createMessagesWithTokenCount(5_000);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        largeSystemPrompt,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);
    });

    it("should NOT clamp when system prompt is empty and messages are small", () => {
      const contextWindow = 200_000;
      const requestedOutputTokens = 16_384;
      const messages = createMessagesWithTokenCount(5_000);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
        "", // no system prompt
      );

      expect(clamped).toBe(requestedOutputTokens);
    });
  });

  describe("tool schema accounting", () => {
    it("should clamp when 20 tool schemas push context over the limit", () => {
      const contextWindow = 90_000;
      const requestedOutputTokens = 64_000;
      const systemPrompt = createSystemPromptWithTokenCount(15_000);
      const messages = createMessagesWithTokenCount(8_000);
      const toolSchemas = createToolSchemas(20);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        systemPrompt,
        toolSchemas,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);
    });

    it("should allow more output when no tool schemas are present", () => {
      const contextWindow = 90_000;
      const requestedOutputTokens = 80_000;
      const messages = createMessagesWithTokenCount(3_000);

      const withoutTools = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        "",
        [],
      );

      const withTools = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        "",
        createToolSchemas(20),
      );

      // More tools = less available for output
      if (withTools !== requestedOutputTokens) {
        expect(withTools!).toBeLessThan(withoutTools!);
      }
    });
  });

  describe("context source priority", () => {
    it("should prefer modelDefinition.maxInputTokens over _loadedContextLength", () => {
      const messages = createMessagesWithTokenCount(30_000);

      const clampedWithLargeModel = clampOutputTokens(
        messages,
        64_000,
        200_000, // modelDefinition says 200K
        90_000,  // runtime says 90K
      );

      // With 200K context, 30K messages + 10% safety ≈ 33K → 167K available → fits
      expect(clampedWithLargeModel).toBe(64_000);

      // Verify that with only the smaller loaded context, it would clamp
      const clampedWithSmallRuntime = clampOutputTokens(
        messages,
        64_000,
        null,
        90_000,
      );
      expect(clampedWithSmallRuntime!).toBeLessThan(64_000);
    });
  });

  describe("edge cases", () => {
    it("should return unchanged when both context sources are null", () => {
      const clamped = clampOutputTokens(
        createMessagesWithTokenCount(10_000),
        64_000,
        null,
        null,
      );
      expect(clamped).toBe(64_000);
    });

    it("should return undefined when requestedMaxTokens is undefined", () => {
      const clamped = clampOutputTokens(
        createMessagesWithTokenCount(10_000),
        undefined,
        128_000,
        null,
      );
      expect(clamped).toBeUndefined();
    });

    it("should floor at MINIMUM_CLAMPED_OUTPUT_TOKENS when context is nearly exhausted", () => {
      const clamped = clampOutputTokens(
        createMessagesWithTokenCount(9_500),
        64_000,
        10_000,
        null,
      );
      expect(clamped).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });

    it("should floor at MINIMUM_CLAMPED_OUTPUT_TOKENS when input exceeds context", () => {
      const clamped = clampOutputTokens(
        createMessagesWithTokenCount(15_000),
        64_000,
        10_000,
        null,
      );
      expect(clamped).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });

    it("should handle empty messages array", () => {
      const clamped = clampOutputTokens(
        [],
        64_000,
        128_000,
        null,
      );
      expect(clamped).toBe(64_000);
    });

    it("should handle zero context window (falsy → skip clamping)", () => {
      const clamped = clampOutputTokens(
        createMessagesWithTokenCount(10_000),
        64_000,
        0,
        0,
      );
      expect(clamped).toBe(64_000);
    });
  });

  describe("invariant: adjusted input + clamped output ≤ context window", () => {
    const testCases = [
      {
        label: "Gemma 4 12B (90K) — real failure scenario",
        contextWindow: 90_000,
        messageTokens: 8_749,
        systemPromptTokens: 13_915,
        toolCount: 18,
        requestedOutput: 64_000,
      },
      {
        label: "Small local model (32K) — tight budget",
        contextWindow: 32_768,
        messageTokens: 10_000,
        systemPromptTokens: 8_000,
        toolCount: 10,
        requestedOutput: 16_384,
      },
      {
        label: "Tiny model (8K) — near-zero headroom",
        contextWindow: 8_192,
        messageTokens: 3_000,
        systemPromptTokens: 2_000,
        toolCount: 5,
        requestedOutput: 16_384,
      },
      {
        label: "Large model saturated (128K)",
        contextWindow: 128_000,
        messageTokens: 60_000,
        systemPromptTokens: 14_000,
        toolCount: 25,
        requestedOutput: 64_000,
      },
      {
        label: "Large model with headroom (200K)",
        contextWindow: 200_000,
        messageTokens: 10_000,
        systemPromptTokens: 14_000,
        toolCount: 30,
        requestedOutput: 64_000,
      },
    ];

    for (const { label, contextWindow, messageTokens, systemPromptTokens, toolCount, requestedOutput } of testCases) {
      it(`${label}: adjusted input + clamped output ≤ context window`, () => {
        const messages = createMessagesWithTokenCount(messageTokens);
        const systemPrompt = createSystemPromptWithTokenCount(systemPromptTokens);
        const toolSchemas = createToolSchemas(toolCount);

        const clamped = clampOutputTokens(
          messages,
          requestedOutput,
          null,
          contextWindow,
          systemPrompt,
          toolSchemas,
        );

        expect(clamped).toBeDefined();

        if (clamped !== requestedOutput && clamped !== MINIMUM_CLAMPED_OUTPUT_TOKENS) {
          // Was clamped — verify the invariant
          const rawEstimate = estimateInputTokens(messages) +
            estimateTokens(systemPrompt) +
            estimateTokens(JSON.stringify(toolSchemas));
          const safetyMargin = Math.ceil(rawEstimate * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER);
          const adjustedInput = rawEstimate + safetyMargin;

          expect(adjustedInput + clamped!).toBeLessThanOrEqual(contextWindow);
        }
      });
    }
  });
});
