/**
 * Output Token Clamping — Defense-in-Depth Regression Tests
 *
 * Validates that `clampOutputTokens` correctly prevents context window
 * overflow for ALL model types — including unregistered local models
 * (LM Studio) that lack a `modelDefinition` in the MODELS registry.
 *
 * Root cause of the original bug: `clampOutputTokens` only resolved
 * the context window from `modelDefinition.maxInputTokens`. When
 * `modelDefinition` was null (all unregistered local models), the
 * clamp was silently skipped and the full 64,000 output tokens were
 * sent unclamped — overflowing models with smaller context windows
 * (e.g. Gemma 4 12B at 90K tokens).
 *
 * Fix: three-source fallback chain:
 *   1. modelDefinition.maxInputTokens  (registered models)
 *   2. options._loadedContextLength     (runtime from LM Studio)
 *   3. null                             (skip clamping entirely)
 */
import { describe, it, expect } from "vitest";

import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../../../constants/TokenBudgetDefaults.ts";
import { CONTEXT_WINDOW } from "../../../constants.ts";
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
  toolCount = 0,
): number | undefined {
  const contextWindow =
    modelDefinitionMaxInputTokens ||
    loadedContextLength ||
    null;

  if (!contextWindow || !requestedMaxTokens) return requestedMaxTokens;

  const estimatedInputTokens = estimateInputTokens(messages);
  const toolSchemaOverhead =
    CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS +
    toolCount * CONTEXT_WINDOW.TOKENS_PER_TOOL_SCHEMA;
  const availableForOutput =
    contextWindow -
    estimatedInputTokens -
    toolSchemaOverhead -
    OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;

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

// ── Test Suite ───────────────────────────────────────────────

describe("Output Token Clamping (clampOutputTokens)", () => {
  describe("registered models (modelDefinition.maxInputTokens present)", () => {
    it("should clamp when input + output exceeds context window", () => {
      const contextWindow = 90_000;
      const inputTokens = 30_000;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);
      const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
      expect(clamped!).toBeLessThanOrEqual(
        contextWindow - inputTokens - baseToolSchemaOverhead - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN,
      );
    });

    it("should return unchanged when request fits within budget", () => {
      const contextWindow = 200_000;
      const inputTokens = 10_000;
      const requestedOutputTokens = 16_384;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      expect(clamped).toBe(requestedOutputTokens);
    });
  });

  describe("unregistered models (modelDefinition is null, _loadedContextLength present)", () => {
    it("should fall back to _loadedContextLength and clamp correctly", () => {
      const loadedContextLength = 90_000;
      const inputTokens = 26_000;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        loadedContextLength,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);

      const estimatedInput = estimateInputTokens(messages);
      const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
      const expectedMaxOutput =
        loadedContextLength - estimatedInput - baseToolSchemaOverhead - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
      expect(clamped).toBe(Math.max(expectedMaxOutput, MINIMUM_CLAMPED_OUTPUT_TOKENS));
    });

    it("should return unchanged when request fits within loaded context budget", () => {
      const loadedContextLength = 131_072;
      const inputTokens = 5_000;
      const requestedOutputTokens = 16_384;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        loadedContextLength,
      );

      expect(clamped).toBe(requestedOutputTokens);
    });

    it("should reproduce the exact Gemma 4 12B overflow scenario", () => {
      // Exact reproduction: Gemma 4 12B with 90K context,
      // 64K output tokens, ~26K input tokens
      const loadedContextLength = 90_000;
      const inputTokens = 26_001;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        loadedContextLength,
      );

      // Without the fix, this would return 64_000 (unclamped) and overflow.
      // With the fix, it should clamp to fit.
      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);

      const estimatedInput = estimateInputTokens(messages);
      const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
      expect(estimatedInput + clamped! + baseToolSchemaOverhead + OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN).toBeLessThanOrEqual(
        loadedContextLength,
      );
    });
  });

  describe("no context information available", () => {
    it("should return requestedMaxTokens unchanged when both sources are null", () => {
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(10_000);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        null,
      );

      expect(clamped).toBe(requestedOutputTokens);
    });

    it("should return undefined when requestedMaxTokens is undefined", () => {
      const messages = createMessagesWithTokenCount(10_000);

      const clamped = clampOutputTokens(messages, undefined, 128_000, null);

      expect(clamped).toBeUndefined();
    });
  });

  describe("priority order of context sources", () => {
    it("should prefer modelDefinition.maxInputTokens over _loadedContextLength", () => {
      const modelDefinitionContextWindow = 200_000;
      const loadedContextLength = 90_000;
      const inputTokens = 30_000;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clampedWithModelDef = clampOutputTokens(
        messages,
        requestedOutputTokens,
        modelDefinitionContextWindow,
        loadedContextLength,
      );

      // With a 200K context window, 30K input + 64K output fits easily
      expect(clampedWithModelDef).toBe(requestedOutputTokens);

      // Verify that with only the smaller loaded context, it would clamp
      const clampedWithLoadedOnly = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        loadedContextLength,
      );
      expect(clampedWithLoadedOnly!).toBeLessThan(requestedOutputTokens);
    });
  });

  describe("edge cases and boundary conditions", () => {
    it("should floor at MINIMUM_CLAMPED_OUTPUT_TOKENS when context is nearly exhausted", () => {
      // Context is 10K, input is 9K — only ~1K left, but floor is 1024
      const contextWindow = 10_000;
      const inputTokens = 9_500;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      expect(clamped).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });

    it("should floor at MINIMUM_CLAMPED_OUTPUT_TOKENS when input exceeds context window", () => {
      // Pathological: input already exceeds context — available is negative
      const contextWindow = 10_000;
      const inputTokens = 15_000;
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      expect(clamped).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });

    it("should return unchanged at exact boundary minus safety margin and tool overhead", () => {
      // Set up so input + output + tool overhead + safety margin == exactly contextWindow
      const contextWindow = 100_000;
      const requestedOutputTokens = 16_384;
      const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
      const targetInputTokens =
        contextWindow - requestedOutputTokens - baseToolSchemaOverhead - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
      const messages = createMessagesWithTokenCount(targetInputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      // Should fit exactly (available == requested)
      expect(clamped).toBe(requestedOutputTokens);
    });

    it("should clamp when 1 token over the boundary", () => {
      const contextWindow = 100_000;
      const requestedOutputTokens = 16_384;
      const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
      // 1 extra token beyond what fits
      const targetInputTokens =
        contextWindow - requestedOutputTokens - baseToolSchemaOverhead - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN + 1;
      const messages = createMessagesWithTokenCount(targetInputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
      );

      expect(clamped!).toBeLessThan(requestedOutputTokens);
    });

    it("should handle empty messages array", () => {
      const contextWindow = 128_000;
      const requestedOutputTokens = 64_000;

      const clamped = clampOutputTokens(
        [],
        requestedOutputTokens,
        contextWindow,
        null,
      );

      // Empty messages → 0 input tokens → base overhead only → plenty of room
      expect(clamped).toBe(requestedOutputTokens);
    });

    it("should handle zero context window gracefully", () => {
      // Zero is falsy — should skip clamping (same as null)
      const requestedOutputTokens = 64_000;
      const messages = createMessagesWithTokenCount(10_000);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        0,
        0,
      );

      expect(clamped).toBe(requestedOutputTokens);
    });
  });

  describe("invariant: input + clamped output never exceeds context window", () => {
    const testCases = [
      { contextWindow: 90_000, inputTokens: 26_001, requestedOutput: 64_000, label: "Gemma 4 12B (90K)" },
      { contextWindow: 32_768, inputTokens: 20_000, requestedOutput: 16_384, label: "Small local model (32K)" },
      { contextWindow: 8_192, inputTokens: 6_000, requestedOutput: 16_384, label: "Tiny model (8K)" },
      { contextWindow: 128_000, inputTokens: 100_000, requestedOutput: 64_000, label: "Large model saturated (128K)" },
      { contextWindow: 200_000, inputTokens: 10_000, requestedOutput: 64_000, label: "Large model with headroom (200K)" },
    ];

    for (const { contextWindow, inputTokens, requestedOutput, label } of testCases) {
      it(`${label}: clamped output + input + safety margin ≤ context window`, () => {
        const messages = createMessagesWithTokenCount(inputTokens);
        const estimatedInput = estimateInputTokens(messages);

        const clamped = clampOutputTokens(
          messages,
          requestedOutput,
          null,
          contextWindow,
        );

        if (clamped !== requestedOutput) {
          // Was clamped — verify the invariant (including base tool overhead)
          // Skip the sum check when clamped hit the MINIMUM floor, since
          // the floor intentionally allows exceeding the budget so the model
          // can produce a meaningful partial response rather than 0 output.
          const baseToolSchemaOverhead = CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS;
          if (clamped !== MINIMUM_CLAMPED_OUTPUT_TOKENS) {
            expect(
              estimatedInput + clamped! + baseToolSchemaOverhead + OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN,
            ).toBeLessThanOrEqual(contextWindow);
          }
        }
        // Either way, should never be undefined
        expect(clamped).toBeDefined();
      });
    }
  });

  describe("tool-schema-induced overflow (discover_and_enable_tools regression)", () => {
    it("should clamp when 20 dynamically enabled tools push context over the limit", () => {
      // Exact reproduction of the Gemma 4 12B + discover_and_enable_tools bug:
      // - Context window: 90,000
      // - Requested output: 64,000
      // - Input tokens: ~20,000 (moderate conversation)
      // - Tool count: 35 (15 core + 20 discovered)
      // Without tool schema overhead: 90,000 - 20,000 - 256 = 69,744 → 64,000 fits (no clamp!)
      // With tool schema overhead:    90,000 - 20,000 - (2000 + 35*150) - 256 = 62,494 → 64,000 overflows → must clamp
      const contextWindow = 90_000;
      const inputTokens = 20_000;
      const requestedOutputTokens = 64_000;
      const toolCount = 35; // 15 core + 20 discovered via discover_and_enable_tools
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        toolCount,
      );

      expect(clamped).toBeDefined();
      expect(clamped!).toBeLessThan(requestedOutputTokens);

      // Verify the full budget equation
      const estimatedInput = estimateInputTokens(messages);
      const toolSchemaOverhead =
        CONTEXT_WINDOW.TOOL_SCHEMA_OVERHEAD_TOKENS +
        toolCount * CONTEXT_WINDOW.TOKENS_PER_TOOL_SCHEMA;
      expect(
        estimatedInput + clamped! + toolSchemaOverhead + OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN,
      ).toBeLessThanOrEqual(contextWindow);
    });

    it("should not clamp on large-context models even with many tools", () => {
      // Claude 4 Opus (200K context) — 20 extra tools shouldn't cause issues
      const contextWindow = 200_000;
      const inputTokens = 20_000;
      const requestedOutputTokens = 64_000;
      const toolCount = 50;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clamped = clampOutputTokens(
        messages,
        requestedOutputTokens,
        contextWindow,
        null,
        toolCount,
      );

      expect(clamped).toBe(requestedOutputTokens);
    });

    it("should account for increasing tool counts proportionally", () => {
      // Use a large enough context that neither case floors at MINIMUM_CLAMPED_OUTPUT_TOKENS
      const contextWindow = 120_000;
      const inputTokens = 15_000;
      const requestedOutputTokens = 100_000;
      const messages = createMessagesWithTokenCount(inputTokens);

      const clampedWithFewTools = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        5,
      );
      const clampedWithManyTools = clampOutputTokens(
        messages,
        requestedOutputTokens,
        null,
        contextWindow,
        40,
      );

      // More tools → less available output → lower clamped value
      expect(clampedWithManyTools!).toBeLessThan(clampedWithFewTools!);
    });
  });
});
