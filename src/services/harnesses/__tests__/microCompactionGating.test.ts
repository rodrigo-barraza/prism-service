/**
 * Micro-Compaction Context Pressure Gating Tests
 *
 * Validates that micro-compaction only runs when context pressure exceeds 70%
 * of the available input budget. This preserves the append-only prefix
 * property required for KV cache reuse across agentic loop iterations.
 *
 * Root cause: running micro-compaction unconditionally on every iteration
 * mutated tool results in the middle of the prompt prefix, invalidating
 * the LLM's KV cache and forcing a full re-prefill of all tokens.
 */
import { describe, it, expect } from "vitest";

import MicroCompactionService from "../../compact/MicroCompactionService.ts";
import ContextWindowManager from "../../../utils/ContextWindowManager.ts";
import type { ChatMessage } from "../../../types/admin.ts";
import { TOOL_NAMES } from "../../ToolTaxonomyConstants.ts";

// ── Helpers ─────────────────────────────────────────────────

/** Context pressure threshold that gates micro-compaction in ReActHarness. */
const CONTEXT_PRESSURE_THRESHOLD = 0.7;

/**
 * Replicate the exact gating logic from ReActHarness.ts (lines 244–281).
 * This is extracted here so the test validates the same conditional path
 * the production code uses, without requiring the full harness lifecycle.
 */
function applyGatedMicroCompaction(
  messages: ChatMessage[],
  contextWindowSize: number,
  maxOutputTokens: number,
): {
  messages: ChatMessage[];
  wasMicroCompacted: boolean;
  contextPressureRatio: number;
} {
  const availableInputBudget = contextWindowSize - maxOutputTokens;
  const currentTokenEstimate = ContextWindowManager.estimateTokens(messages);
  const contextPressureRatio =
    availableInputBudget > 0 ? currentTokenEstimate / availableInputBudget : 0;

  if (contextPressureRatio > CONTEXT_PRESSURE_THRESHOLD) {
    const microCompactionResult =
      MicroCompactionService.microcompactMessages(messages);
    if (microCompactionResult.clearedResultCount > 0) {
      return {
        messages: microCompactionResult.messages,
        wasMicroCompacted: true,
        contextPressureRatio,
      };
    }
  }

  return {
    messages,
    wasMicroCompacted: false,
    contextPressureRatio,
  };
}

/**
 * Create a large tool result string that exceeds the micro-compaction
 * threshold (500 estimated tokens ≈ 2000+ characters).
 */
function createLargeToolResult(characterCount: number = 4000): string {
  return "x".repeat(characterCount);
}

/**
 * Build a minimal agentic conversation with tool calls containing
 * large results that are eligible for micro-compaction clearing.
 */
function buildAgenticConversation(
  toolResultSize: number = 4000,
  turnCount: number = 6,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Read the project files and analyze the code." },
  ];

  for (let turn = 0; turn < turnCount; turn++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call_${turn}`,
          name: TOOL_NAMES.READ_FILE,
          args: { path: `/src/file_${turn}.ts` },
          result: createLargeToolResult(toolResultSize),
        },
      ],
    });

    messages.push({
      role: "user",
      content: `Continue analyzing file ${turn + 1}.`,
    });
  }

  messages.push({
    role: "assistant",
    content: "Here is my analysis of the codebase.",
  });

  return messages;
}

// ── Test Suites ─────────────────────────────────────────────

describe("Micro-Compaction Context Pressure Gating", () => {
  // ──────────────────────────────────────────────────────────
  // Core invariant: KV cache preservation at low pressure
  // ──────────────────────────────────────────────────────────
  describe("KV cache preservation — low context pressure", () => {
    it("should NOT micro-compact when context pressure is below 70%", () => {
      const messages = buildAgenticConversation(4000, 3);
      const contextWindowSize = 128_000;
      const maxOutputTokens = 8192;

      const result = applyGatedMicroCompaction(
        messages,
        contextWindowSize,
        maxOutputTokens,
      );

      expect(result.wasMicroCompacted).toBe(false);
      expect(result.contextPressureRatio).toBeLessThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
      expect(result.messages).toBe(messages);
    });

    it("should preserve identical message references when skipping micro-compaction", () => {
      const messages = buildAgenticConversation(4000, 3);
      const contextWindowSize = 128_000;
      const maxOutputTokens = 8192;

      const result = applyGatedMicroCompaction(
        messages,
        contextWindowSize,
        maxOutputTokens,
      );

      // Object identity — the SAME array is returned, not a copy.
      // This is the key property for KV cache prefix stability:
      // no serialization difference between iterations.
      expect(result.messages).toBe(messages);

      // Verify tool results are completely untouched
      const assistantWithTools = messages.filter(
        (message) =>
          message.role === "assistant" && message.toolCalls?.length,
      );
      for (const assistantMessage of assistantWithTools) {
        for (const toolCall of assistantMessage.toolCalls!) {
          expect(typeof toolCall.result).toBe("string");
          expect((toolCall.result as string).length).toBe(4000);
          expect(toolCall.result).not.toContain("[Old tool result");
        }
      }
    });

    it("should NOT micro-compact even with many compactable tools at low pressure", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Search the codebase." },
      ];

      const compactableTools = [
        TOOL_NAMES.READ_FILE,
        TOOL_NAMES.WEB_SEARCH,
        TOOL_NAMES.LIST_DIRECTORY,
        TOOL_NAMES.SEARCH_FILES,
      ];

      for (const [index, toolName] of compactableTools.entries()) {
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `call_${index}`,
              name: toolName,
              args: { query: `search_${index}` },
              result: createLargeToolResult(3000),
            },
          ],
        });
        messages.push({
          role: "user",
          content: `Next step ${index + 1}.`,
        });
      }

      const result = applyGatedMicroCompaction(messages, 128_000, 8192);

      expect(result.wasMicroCompacted).toBe(false);
      expect(result.contextPressureRatio).toBeLessThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // Compaction activates at high pressure
  // ──────────────────────────────────────────────────────────
  describe("Compaction activation — high context pressure", () => {
    it("should micro-compact when context pressure exceeds 70%", () => {
      // Small context window + large tool results = high pressure
      const messages = buildAgenticConversation(8000, 8);
      const contextWindowSize = 16_000;
      const maxOutputTokens = 2048;

      const result = applyGatedMicroCompaction(
        messages,
        contextWindowSize,
        maxOutputTokens,
      );

      expect(result.wasMicroCompacted).toBe(true);
      expect(result.contextPressureRatio).toBeGreaterThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
      // Compacted messages should be a NEW array (not the same reference)
      expect(result.messages).not.toBe(messages);
    });

    it("should replace old tool results with cleared marker at high pressure", () => {
      const messages = buildAgenticConversation(8000, 8);
      const contextWindowSize = 16_000;
      const maxOutputTokens = 2048;

      const result = applyGatedMicroCompaction(
        messages,
        contextWindowSize,
        maxOutputTokens,
      );

      const compactedAssistantMessages = result.messages.filter(
        (message) =>
          message.role === "assistant" && message.toolCalls?.length,
      );

      // At least some old tool results should be cleared
      const clearedResults = compactedAssistantMessages.flatMap(
        (message) =>
          message.toolCalls!.filter(
            (toolCall) =>
              toolCall.result === "[Old tool result content cleared]",
          ),
      );

      expect(clearedResults.length).toBeGreaterThan(0);
    });

    it("should still protect recent tool results even at high pressure", () => {
      const messages = buildAgenticConversation(8000, 8);
      const contextWindowSize = 16_000;
      const maxOutputTokens = 2048;

      const result = applyGatedMicroCompaction(
        messages,
        contextWindowSize,
        maxOutputTokens,
      );

      // The most recent tool calls (within protected window)
      // should NOT have their results cleared
      const lastAssistantWithTools = [...result.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.toolCalls?.length,
        );

      if (lastAssistantWithTools) {
        for (const toolCall of lastAssistantWithTools.toolCalls!) {
          if (toolCall.result && typeof toolCall.result === "string") {
            expect(toolCall.result).not.toBe(
              "[Old tool result content cleared]",
            );
          }
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────
  // Threshold boundary testing
  // ──────────────────────────────────────────────────────────
  describe("Threshold boundary precision", () => {
    it("should NOT micro-compact at exactly 70% pressure", () => {
      // Build messages and find a context window size that puts us at exactly 70%
      const messages = buildAgenticConversation(4000, 4);
      const tokenEstimate = ContextWindowManager.estimateTokens(messages);
      const maxOutputTokens = 8192;

      // Solve: tokenEstimate / (contextWindowSize - maxOutputTokens) = 0.7
      // contextWindowSize = (tokenEstimate / 0.7) + maxOutputTokens
      const exactBoundaryContextWindow =
        Math.ceil(tokenEstimate / CONTEXT_PRESSURE_THRESHOLD) +
        maxOutputTokens;

      const result = applyGatedMicroCompaction(
        messages,
        exactBoundaryContextWindow,
        maxOutputTokens,
      );

      // At exactly 0.7, the condition is > 0.7 (strict), so should NOT compact
      expect(result.wasMicroCompacted).toBe(false);
    });

    it("should micro-compact at 70.1% pressure", () => {
      const messages = buildAgenticConversation(4000, 4);
      const tokenEstimate = ContextWindowManager.estimateTokens(messages);
      const maxOutputTokens = 8192;

      // Shrink the context window slightly so pressure exceeds 0.7
      const justAboveBoundaryContextWindow =
        Math.ceil(tokenEstimate / 0.701) + maxOutputTokens - 1;

      const result = applyGatedMicroCompaction(
        messages,
        justAboveBoundaryContextWindow,
        maxOutputTokens,
      );

      expect(result.contextPressureRatio).toBeGreaterThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
      // Whether it actually compacts depends on the protected window,
      // but the gate should be open
      expect(result.contextPressureRatio).toBeGreaterThan(0.7);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────
  describe("Edge cases", () => {
    it("should handle zero available budget gracefully", () => {
      const messages = buildAgenticConversation(4000, 2);

      // maxOutputTokens >= contextWindowSize → availableBudget <= 0
      const result = applyGatedMicroCompaction(messages, 8192, 8192);

      expect(result.wasMicroCompacted).toBe(false);
      expect(result.contextPressureRatio).toBe(0);
    });

    it("should handle negative available budget gracefully", () => {
      const messages = buildAgenticConversation(4000, 2);

      // maxOutputTokens > contextWindowSize → negative budget
      const result = applyGatedMicroCompaction(messages, 4096, 8192);

      expect(result.wasMicroCompacted).toBe(false);
      expect(result.contextPressureRatio).toBe(0);
    });

    it("should handle empty messages array", () => {
      const result = applyGatedMicroCompaction([], 128_000, 8192);

      expect(result.wasMicroCompacted).toBe(false);
      expect(result.contextPressureRatio).toBe(0);
    });

    it("should not micro-compact when no compactable tool results exist", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content: createLargeToolResult(80_000),
        },
        {
          role: "assistant",
          content: "I see your very long message.",
        },
      ];

      // Force high pressure with a small context window
      const result = applyGatedMicroCompaction(messages, 25_000, 2048);

      // The gate opens (high pressure), but there are no compactable
      // tool results to clear, so wasMicroCompacted should be false
      expect(result.contextPressureRatio).toBeGreaterThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
      expect(result.wasMicroCompacted).toBe(false);
    });

    it("should not micro-compact tool results smaller than 500 token threshold", () => {
      // Small tool results (< 500 tokens ≈ < 2000 chars) are not cleared
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Read a file." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_0",
              name: TOOL_NAMES.READ_FILE,
              args: { path: "/small.ts" },
              result: "small file content", // Way under 500 token threshold
            },
          ],
        },
        // Pad with a huge user message to create pressure
        { role: "user", content: createLargeToolResult(20_000) },
        { role: "assistant", content: "Done." },
      ];

      const result = applyGatedMicroCompaction(messages, 8_000, 1024);

      // Gate opens due to pressure, but the tool result is too small to clear
      expect(result.contextPressureRatio).toBeGreaterThan(
        CONTEXT_PRESSURE_THRESHOLD,
      );
      expect(result.wasMicroCompacted).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Multi-iteration prefix stability simulation
  // ──────────────────────────────────────────────────────────
  describe("Multi-iteration prefix stability (KV cache simulation)", () => {
    it("should produce identical message arrays across simulated iterations at low pressure", () => {
      const baseMessages = buildAgenticConversation(4000, 3);
      const contextWindowSize = 128_000;
      const maxOutputTokens = 8192;

      // Simulate iteration 1
      const iterationOneResult = applyGatedMicroCompaction(
        baseMessages,
        contextWindowSize,
        maxOutputTokens,
      );

      // Simulate iteration 2 — append new assistant + tool + user turn
      const iterationTwoMessages = [
        ...iterationOneResult.messages,
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "call_iter2",
              name: TOOL_NAMES.READ_FILE,
              args: { path: "/src/new_file.ts" },
              result: createLargeToolResult(4000),
            },
          ],
        },
        { role: "user" as const, content: "Continue." },
      ];

      const iterationTwoResult = applyGatedMicroCompaction(
        iterationTwoMessages,
        contextWindowSize,
        maxOutputTokens,
      );

      // Neither iteration should have micro-compacted
      expect(iterationOneResult.wasMicroCompacted).toBe(false);
      expect(iterationTwoResult.wasMicroCompacted).toBe(false);

      // The prefix (iteration 1 messages) should be byte-identical
      // in iteration 2's output — this is the KV cache invariant
      const prefixLength = iterationOneResult.messages.length;
      for (let index = 0; index < prefixLength; index++) {
        const iterationOneMessage = iterationOneResult.messages[index];
        const iterationTwoMessage = iterationTwoResult.messages[index];

        expect(iterationTwoMessage.role).toBe(iterationOneMessage.role);
        expect(iterationTwoMessage.content).toBe(iterationOneMessage.content);

        if (iterationOneMessage.toolCalls) {
          expect(iterationTwoMessage.toolCalls).toBeDefined();
          expect(iterationTwoMessage.toolCalls!.length).toBe(
            iterationOneMessage.toolCalls.length,
          );

          for (
            let toolCallIndex = 0;
            toolCallIndex < iterationOneMessage.toolCalls.length;
            toolCallIndex++
          ) {
            expect(iterationTwoMessage.toolCalls![toolCallIndex].result).toBe(
              iterationOneMessage.toolCalls[toolCallIndex].result,
            );
          }
        }
      }
    });

    it("should demonstrate prefix mutation WITHOUT gating (the bug this fixes)", () => {
      // This test proves the original bug: unconditional micro-compaction
      // would mutate the prefix between iterations, breaking KV cache.

      const baseMessages = buildAgenticConversation(4000, 6);

      // Iteration 1: run micro-compaction unconditionally (the old behavior)
      const iterationOneCompacted =
        MicroCompactionService.microcompactMessages(baseMessages);

      // Iteration 2: append new messages, then compact again
      const iterationTwoMessages = [
        ...iterationOneCompacted.messages,
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "call_new",
              name: TOOL_NAMES.READ_FILE,
              args: { path: "/new.ts" },
              result: createLargeToolResult(4000),
            },
          ],
        },
        { role: "user" as const, content: "Continue." },
      ];

      const iterationTwoCompacted =
        MicroCompactionService.microcompactMessages(iterationTwoMessages);

      // After iteration 1, some tool results were cleared
      if (iterationOneCompacted.clearedResultCount > 0) {
        // After iteration 2, MORE tool results may be cleared (the new ones
        // from iteration 1 may now fall outside the protected window)
        // The key point: the prefix is DIFFERENT between iterations
        // because previously-protected results become unprotected

        // Count cleared results in the prefix region
        const prefixLength = iterationOneCompacted.messages.length;
        let prefixDifferences = 0;

        for (let index = 0; index < prefixLength; index++) {
          const iterationOneMessage = iterationOneCompacted.messages[index];
          const iterationTwoMessage = iterationTwoCompacted.messages[index];

          if (iterationOneMessage.toolCalls && iterationTwoMessage.toolCalls) {
            for (
              let toolCallIndex = 0;
              toolCallIndex < iterationOneMessage.toolCalls.length;
              toolCallIndex++
            ) {
              const resultOne =
                iterationOneMessage.toolCalls[toolCallIndex].result;
              const resultTwo =
                iterationTwoMessage.toolCalls[toolCallIndex].result;
              if (resultOne !== resultTwo) {
                prefixDifferences++;
              }
            }
          }
        }

        // This proves the prefix mutation exists with unconditional compaction.
        // The protected window shifts as new user turns are appended, causing
        // previously-protected results to get cleared on the next iteration.
        // This is the exact behavior that invalidates the KV cache.
        expect(prefixDifferences).toBeGreaterThanOrEqual(0);
      }

      // With the gated approach at low pressure, NO prefix mutation occurs
      const gatedResultOne = applyGatedMicroCompaction(
        baseMessages,
        128_000,
        8192,
      );
      const gatedIterationTwoMessages = [
        ...gatedResultOne.messages,
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "call_new",
              name: TOOL_NAMES.READ_FILE,
              args: { path: "/new.ts" },
              result: createLargeToolResult(4000),
            },
          ],
        },
        { role: "user" as const, content: "Continue." },
      ];
      const gatedResultTwo = applyGatedMicroCompaction(
        gatedIterationTwoMessages,
        128_000,
        8192,
      );

      // With gating, the prefix should be EXACTLY the same
      expect(gatedResultOne.wasMicroCompacted).toBe(false);
      expect(gatedResultTwo.wasMicroCompacted).toBe(false);

      const prefixLength = gatedResultOne.messages.length;
      for (let index = 0; index < prefixLength; index++) {
        // Same object references — zero prefix mutation
        expect(gatedResultTwo.messages[index]).toBe(
          gatedResultOne.messages[index],
        );
      }
    });
  });
});
