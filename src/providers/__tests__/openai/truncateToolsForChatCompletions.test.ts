/**
 * Unit tests for the OpenAI `truncateToolsForChatCompletions` function.
 *
 * Validates the 128-tool limit enforcement and priority tool preservation.
 */
import { describe, it, expect } from "vitest";

import { truncateToolsForChatCompletions } from "../../openai.ts";

// ── Helpers ──────────────────────────────────────────────────
function makeTool(name: string) {
  return {
    type: "function" as const,
    function: { name, description: `Tool: ${name}`, parameters: {} },
  };
}

function makeTools(count: number, prefix = "tool") {
  return Array.from({ length: count }, (_, index) =>
    makeTool(`${prefix}_${index}`),
  );
}

// ── Under Limit ──────────────────────────────────────────────
describe("truncateToolsForChatCompletions — under limit", () => {
  it("returns tools unchanged when count is under 128", () => {
    const tools = makeTools(50);
    const result = truncateToolsForChatCompletions(tools);

    expect(result).toHaveLength(50);
    expect(result).toBe(tools); // same reference, no copy
  });

  it("returns tools unchanged when count is exactly 128", () => {
    const tools = makeTools(128);
    const result = truncateToolsForChatCompletions(tools);

    expect(result).toHaveLength(128);
    expect(result).toBe(tools);
  });
});

// ── Over Limit ───────────────────────────────────────────────
describe("truncateToolsForChatCompletions — over limit", () => {
  it("truncates to 128 when count exceeds limit", () => {
    const tools = makeTools(200);
    const result = truncateToolsForChatCompletions(tools);

    expect(result).toHaveLength(128);
  });

  it("preserves priority tools at the front of the array", () => {
    const regularTools = makeTools(200, "regular");
    const priorityTools = [
      makeTool("discover_and_enable_tools"),
      makeTool("search_tools"),
      makeTool("enable_tools"),
    ];
    // Insert priority tools at various positions in the array
    const allTools = [
      ...regularTools.slice(0, 50),
      priorityTools[0],
      ...regularTools.slice(50, 100),
      priorityTools[1],
      ...regularTools.slice(100, 150),
      priorityTools[2],
      ...regularTools.slice(150),
    ];

    const result = truncateToolsForChatCompletions(allTools);

    expect(result).toHaveLength(128);
    // Priority tools should be at the front
    expect(result[0].function?.name).toBe("discover_and_enable_tools");
    expect(result[1].function?.name).toBe("search_tools");
    expect(result[2].function?.name).toBe("enable_tools");
    // Remaining 125 slots filled by regular tools
    expect(result.slice(3).every((tool) => tool.function?.name?.startsWith("regular"))).toBe(true);
  });

  it("handles case where all priority tools are present with exactly 128 remaining slots", () => {
    const priorityTools = [
      makeTool("discover_and_enable_tools"),
      makeTool("search_tools"),
      makeTool("enable_tools"),
    ];
    const regularTools = makeTools(130, "regular");
    const allTools = [...priorityTools, ...regularTools];

    const result = truncateToolsForChatCompletions(allTools);

    expect(result).toHaveLength(128);
    // 3 priority + 125 regular = 128
    expect(result[0].function?.name).toBe("discover_and_enable_tools");
  });

  it("handles case with no priority tools present", () => {
    const tools = makeTools(200, "generic");
    const result = truncateToolsForChatCompletions(tools);

    expect(result).toHaveLength(128);
    // All 128 should be generic tools
    expect(result.every((tool) => tool.function?.name?.startsWith("generic"))).toBe(true);
  });

  it("handles only priority tools and a few regular ones", () => {
    const tools = [
      makeTool("discover_and_enable_tools"),
      ...makeTools(130, "normal"),
    ];

    const result = truncateToolsForChatCompletions(tools);

    expect(result).toHaveLength(128);
    expect(result[0].function?.name).toBe("discover_and_enable_tools");
  });
});

// ── Empty Input ──────────────────────────────────────────────
describe("truncateToolsForChatCompletions — empty input", () => {
  it("returns empty array unchanged", () => {
    const result = truncateToolsForChatCompletions([]);
    expect(result).toHaveLength(0);
  });
});
