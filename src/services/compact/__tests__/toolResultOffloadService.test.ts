import { describe, it, expect, beforeEach } from "vitest";
import ToolResultOffloadService, {
  OFFLOAD_STUB_HEADER,
  sliceOffloadedContent,
} from "#src/services/compact/ToolResultOffloadService";
import MicroCompactionService from "#src/services/compact/MicroCompactionService";
import retrieveOffloadedContentTool from "#src/services/tool-definitions/RetrieveOffloadedContentTool";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import type { ChatMessage } from "#src/types/admin";

// ────────────────────────────────────────────────────────────
// ToolResultOffloadService — lossless offload + slice retrieval
// (survey items A2 + A3: Strands ContextOffloader / DeepAgents
//  offload pattern; VISTA recoverable eviction; LCM lossless pointers)
//
// Mongo is unavailable in unit tests (MongoWrapper.getDb → null),
// so these exercise the in-memory stash path — the same path that
// covers the fire-and-forget persistence window in production.
// ────────────────────────────────────────────────────────────

const LONG_CONTENT = Array.from(
  { length: 300 },
  (_, index) => `line ${index + 1}: payload ${index % 7 === 0 ? "MATCH" : "filler"} content`,
).join("\n");

beforeEach(() => {
  ToolResultOffloadService.clearMemoryCache();
});

describe("ToolResultOffloadService.offloadToolResult", () => {
  it("returns a pointer stub with header, id, preview and retrieval hint", () => {
    const stub = ToolResultOffloadService.offloadToolResult(
      { id: "call-abc", name: "read_file", result: LONG_CONTENT },
      { conversationId: "conv-1", project: "test", username: "tester" },
    );

    expect(stub.startsWith(OFFLOAD_STUB_HEADER)).toBe(true);
    expect(stub).toContain("offload_id: call-abc");
    expect(stub).toContain("line 1: payload MATCH content");
    expect(stub).toContain("retrieve_offloaded_content");
    // Stub must be dramatically smaller than the original
    expect(stub.length).toBeLessThan(LONG_CONTENT.length / 10);
  });

  it("generates an id when the tool call has none", () => {
    const stub = ToolResultOffloadService.offloadToolResult({
      name: "execute_shell",
      result: LONG_CONTENT,
    });
    expect(stub).toMatch(/offload_id: [0-9a-f-]{36}/);
  });

  it("stringifies non-string results and preserves them verbatim", async () => {
    const objectResult = { rows: [{ id: 1, name: "widget" }], total: 1 };
    ToolResultOffloadService.offloadToolResult({
      id: "call-json",
      name: "query_datastore",
      result: objectResult,
    });

    const record = await ToolResultOffloadService.getRecord("call-json");
    expect(record).not.toBeNull();
    expect(JSON.parse(record!.content)).toEqual(objectResult);
  });
});

describe("ToolResultOffloadService.retrieve", () => {
  beforeEach(() => {
    ToolResultOffloadService.offloadToolResult({
      id: "call-slice",
      name: "read_web_page",
      result: LONG_CONTENT,
    });
  });

  it("returns a line range with 1-based line numbers", async () => {
    const slice = await ToolResultOffloadService.retrieve("call-slice", {
      startLine: 10,
      endLine: 12,
    });
    expect(slice).not.toBeNull();
    expect(slice!.returnedLines).toBe(3);
    expect(slice!.totalLines).toBe(300);
    expect(slice!.text).toContain("10: line 10:");
    expect(slice!.text).toContain("12: line 12:");
    expect(slice!.text).not.toContain("13: line 13:");
  });

  it("greps by regex with context lines and reports match count", async () => {
    const slice = await ToolResultOffloadService.retrieve("call-slice", {
      pattern: "MATCH",
      contextLines: 1,
    });
    expect(slice).not.toBeNull();
    // Lines 1, 8, 15, ... → ceil(300/7) matches
    expect(slice!.matchCount).toBe(Math.ceil(300 / 7));
    expect(slice!.text).toContain("1: line 1: payload MATCH content");
    // Context line around the first match
    expect(slice!.text).toContain("2: line 2:");
  });

  it("falls back to literal matching on invalid regex", async () => {
    const slice = await ToolResultOffloadService.retrieve("call-slice", {
      pattern: "MATCH(",
    });
    expect(slice).not.toBeNull();
    expect(slice!.matchCount).toBe(0);
  });

  it("defaults to head lines when no options are given", async () => {
    const slice = await ToolResultOffloadService.retrieve("call-slice", {});
    expect(slice).not.toBeNull();
    expect(slice!.returnedLines).toBe(100);
    expect(slice!.text).toContain("1: line 1:");
  });

  it("returns null for an unknown id", async () => {
    const slice = await ToolResultOffloadService.retrieve("nope");
    expect(slice).toBeNull();
  });
});

describe("sliceOffloadedContent truncation", () => {
  it("caps oversized retrievals and flags truncation", () => {
    const bigLine = "x".repeat(1000);
    const content = Array.from({ length: 100 }, () => bigLine).join("\n");
    const slice = sliceOffloadedContent(content, { startLine: 1, endLine: 100 });
    expect(slice.truncated).toBe(true);
    expect(slice.text).toContain("[retrieval truncated");
  });
});

describe("MicroCompactionService offload integration", () => {
  function buildMessages(): ChatMessage[] {
    const oldToolCall = {
      id: "call-old",
      name: TOOL_NAMES.READ_FILE,
      args: { absolutePath: "/tmp/big.txt" },
      result: LONG_CONTENT,
    };
    return [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "did work", toolCalls: [oldToolCall] },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index}`,
      })),
    ] as ChatMessage[];
  }

  it("evicts to a recoverable stub whose original content is retrievable", async () => {
    const result = MicroCompactionService.microcompactMessages(
      buildMessages(),
      4,
      { conversationId: "conv-int", project: "test", username: "tester" },
    );

    expect(result.clearedResultCount).toBe(1);
    expect(result.offloadedResultCount).toBe(1);

    const stub = result.messages[1].toolCalls![0].result as string;
    expect(stub.startsWith(OFFLOAD_STUB_HEADER)).toBe(true);

    // Round-trip: the stub's id recovers the verbatim original
    const record = await ToolResultOffloadService.getRecord("call-old");
    expect(record).not.toBeNull();
    expect(record!.content).toBe(LONG_CONTENT);
    expect(record!.conversationId).toBe("conv-int");
  });

  it("is idempotent — a second pass leaves stubs untouched", () => {
    const firstPass = MicroCompactionService.microcompactMessages(
      buildMessages(),
      4,
    );
    const secondPass = MicroCompactionService.microcompactMessages(
      firstPass.messages,
      4,
    );
    expect(secondPass.clearedResultCount).toBe(0);
    expect(secondPass.messages[1].toolCalls![0].result).toBe(
      firstPass.messages[1].toolCalls![0].result,
    );
  });
});

describe("retrieve_offloaded_content internal tool", () => {
  it("recovers a slice through the tool interface", async () => {
    ToolResultOffloadService.offloadToolResult({
      id: "call-tool",
      name: "search_web",
      result: LONG_CONTENT,
    });

    const response = (await retrieveOffloadedContentTool.execute(
      { offloadId: "call-tool", startLine: 5, endLine: 6 },
      {},
    )) as Record<string, unknown>;

    expect(response.error).toBeUndefined();
    expect(response.toolName).toBe("search_web");
    expect(response.totalLines).toBe(300);
    expect(response.returnedLines).toBe(2);
    expect(response.content).toContain("5: line 5:");
  });

  it("errors cleanly on a missing offloadId argument", async () => {
    const response = (await retrieveOffloadedContentTool.execute(
      {},
      {},
    )) as Record<string, unknown>;
    expect(response.error).toBeTruthy();
  });

  it("errors cleanly on an unknown id", async () => {
    const response = (await retrieveOffloadedContentTool.execute(
      { offloadId: "missing-id" },
      {},
    )) as Record<string, unknown>;
    expect(response.error).toBeTruthy();
    expect(response.offloadId).toBe("missing-id");
  });
});
