/**
 * Prompt 09, Landing 1 (d): tool results cut for the model must stay
 * recoverable and byte-stable.
 *
 * truncateToolResult runs on every model call (expandMessagesForFunctionCall).
 * It used to head-cut an oversized result with no way back; the overflow now
 * goes through ToolResultOffloadService and the model sees a preview, an
 * offload_id and the retrieve_offloaded_content hint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  expandMessagesForFunctionCall,
  truncateToolResult,
} from "#src/utils/FunctionCallingUtilities";
import ToolResultOffloadService from "#src/services/compact/ToolResultOffloadService";
import retrieveOffloadedContent from "#src/services/tool-definitions/RetrieveOffloadedContentTool";
import type { ChatMessage } from "#src/types/admin";

const MODEL_LIMIT = 8_000;

function bigObject() {
  // ~20K characters of compact JSON
  return {
    summary: { total: 400, source: "fixture" },
    rows: Array.from({ length: 400 }, (_, index) => ({ id: index, text: `row-${index}-${"x".repeat(30)}` })),
  };
}

function toolMessageFor(toolName: string, result: unknown) {
  const messages = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: toolName, args: {}, result }],
    },
  ] as unknown as ChatMessage[];
  const expanded = expandMessagesForFunctionCall(messages) as Array<{ role: string; content: string }>;
  const toolMessage = expanded.find((message) => message.role === "tool");
  expect(toolMessage).toBeDefined();
  return toolMessage!.content;
}

function offloadIdIn(content: string): string {
  const match = /offload_id: (\S+)/.exec(content);
  expect(match, `no offload_id pointer in:\n${content.slice(0, 400)}`).not.toBeNull();
  return match![1];
}

describe("oversized tool results are offloaded, not silently cut", () => {
  beforeEach(() => ToolResultOffloadService.clearMemoryCache());

  it("a 20K-char object: the model sees a preview + offload_id + hint, and retrieval returns the original", async () => {
    const original = bigObject();
    expect(JSON.stringify(original).length).toBeGreaterThan(18_000);

    const content = toolMessageFor("query_database", original);

    expect(content.length).toBeLessThanOrEqual(MODEL_LIMIT + 1_000);
    expect(content).toContain("retrieve_offloaded_content");
    expect(content, "the preview shows the head of the result").toContain('"summary"');
    const offloadId = offloadIdIn(content);

    const record = await ToolResultOffloadService.getRecord(offloadId);
    expect(record, "the full value must be stored under the id the model was shown").not.toBeNull();
    expect(JSON.parse(record!.content)).toEqual(original);

    const slice = (await retrieveOffloadedContent.execute({ offloadId, pattern: "row-399-" }, {} as never)) as {
      content: string;
    };
    expect(slice.content).toContain("row-399-");
  });

  it("the same input produces the same bytes on every model call (prefix stability)", () => {
    const first = toolMessageFor("query_database", bigObject());
    ToolResultOffloadService.clearMemoryCache();
    const second = toolMessageFor("query_database", bigObject());
    expect(second).toBe(first);
  });

  it("a long string result is clamped the same way", async () => {
    const original = Array.from({ length: 2_000 }, (_, index) => `line ${index}: ${"y".repeat(20)}`).join("\n");

    const content = toolMessageFor("read_logs", original);

    expect(content.length).toBeLessThanOrEqual(MODEL_LIMIT + 1_000);
    expect(content).toContain("line 0:");
    const record = await ToolResultOffloadService.getRecord(offloadIdIn(content));
    expect(record!.content).toBe(original);
  });

  it("an array capped at 10 items keeps a pointer to the rest", async () => {
    const original = Array.from({ length: 25 }, (_, index) => ({ id: index }));

    const capped = truncateToolResult(original, MODEL_LIMIT, "list_things") as Array<Record<string, unknown>>;

    expect(capped).toHaveLength(11);
    const marker = capped[10];
    expect(marker._truncated).toBe("Showing 10 of 25");
    expect(typeof marker.offload_id).toBe("string");
    expect(String(marker.retrieve)).toContain("retrieve_offloaded_content");
    const record = await ToolResultOffloadService.getRecord(marker.offload_id as string);
    expect(JSON.parse(record!.content)).toEqual(original);
  });

  it("a known array key capped at 10 items keeps a pointer to the rest", async () => {
    const original = {
      events: Array.from({ length: 20 }, (_, index) => ({ name: `event-${index}` })),
      otherField: "preserved",
    };

    const capped = truncateToolResult(original, MODEL_LIMIT, "list_events") as Record<string, unknown>;

    expect(capped.events).toHaveLength(10);
    expect(capped._eventsTruncated).toBe("Showing 10 of 20");
    expect(capped.otherField).toBe("preserved");
    const pointer = capped._offload as Record<string, unknown>;
    const record = await ToolResultOffloadService.getRecord(pointer.offload_id as string);
    expect(JSON.parse(record!.content)).toEqual(original);
  });

  it("results within the limit are passed through untouched", () => {
    const small = { ok: true, items: [1, 2, 3] };
    expect(truncateToolResult(small)).toEqual(small);
    expect(truncateToolResult("short text")).toBe("short text");
  });
});
