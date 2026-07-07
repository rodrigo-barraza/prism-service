/**
 * Unit tests for the Anthropic `extractResponseContent` function.
 *
 * Validates text extraction, thinking block parsing, tool_use extraction,
 * citation collection, and edge cases like empty/null content blocks.
 */
import { describe, it, expect } from "vitest";

import {
  extractResponseContent,
  type AnthropicBlock,
} from "../../anthropic.ts";

// ── Text Extraction ──────────────────────────────────────────
describe("extractResponseContent — text extraction", () => {
  it("extracts text from a single text block", () => {
    const result = extractResponseContent([
      { type: "text", text: "Hello world" },
    ]);

    expect(result.text).toBe("Hello world");
  });

  it("concatenates text from multiple text blocks", () => {
    const result = extractResponseContent([
      { type: "text", text: "First part" },
      { type: "text", text: " second part" },
    ]);

    expect(result.text).toBe("First part second part");
  });

  it("handles text blocks with empty or undefined text", () => {
    const result = extractResponseContent([
      { type: "text", text: "" },
      { type: "text" },
    ]);

    expect(result.text).toBe("");
  });

  it("returns empty string for empty content blocks array", () => {
    const result = extractResponseContent([]);
    expect(result.text).toBe("");
  });

  it("returns empty string for null/undefined content blocks", () => {
    const result = extractResponseContent(
      null as unknown as AnthropicBlock[],
    );
    expect(result.text).toBe("");
  });
});

// ── Thinking Block Extraction ────────────────────────────────
describe("extractResponseContent — thinking blocks", () => {
  it("extracts thinking content and signature", () => {
    const result = extractResponseContent([
      {
        type: "thinking",
        thinking: "Let me consider this carefully...",
        signature: "sig_abc123",
      },
      { type: "text", text: "My answer" },
    ]);

    expect(result.thinking).toBe("Let me consider this carefully...");
    expect(result.thinkingSignature).toBe("sig_abc123");
    expect(result.text).toBe("My answer");
  });

  it("returns null thinking when no thinking block exists", () => {
    const result = extractResponseContent([
      { type: "text", text: "Simple response" },
    ]);

    expect(result.thinking).toBeNull();
    expect(result.thinkingSignature).toBeNull();
  });

  it("handles thinking block without signature", () => {
    const result = extractResponseContent([
      { type: "thinking", thinking: "Some thought" },
    ]);

    expect(result.thinking).toBe("Some thought");
    expect(result.thinkingSignature).toBeNull();
  });
});

// ── Tool Use Extraction ──────────────────────────────────────
describe("extractResponseContent — tool use", () => {
  it("extracts tool_use blocks as toolCalls", () => {
    const result = extractResponseContent([
      {
        type: "tool_use",
        id: "toolu_123",
        name: "get_weather",
        input: { city: "London" },
      },
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "toolu_123",
      name: "get_weather",
      args: { city: "London" },
    });
  });

  it("extracts multiple tool_use blocks", () => {
    const result = extractResponseContent([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "search",
        input: { query: "cats" },
      },
      { type: "text", text: "Let me also check..." },
      {
        type: "tool_use",
        id: "toolu_2",
        name: "fetch",
        input: { url: "https://example.com" },
      },
    ]);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.text).toBe("Let me also check...");
  });

  it("defaults to empty object for tool_use without input", () => {
    const result = extractResponseContent([
      { type: "tool_use", id: "toolu_no_input", name: "list_files" },
    ]);

    expect(result.toolCalls[0].args).toEqual({});
  });
});

// ── Citation Extraction ──────────────────────────────────────
describe("extractResponseContent — citations", () => {
  it("extracts web search citations from text blocks", () => {
    const result = extractResponseContent([
      {
        type: "text",
        text: "According to sources...",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Example",
            cited_text: "relevant quote",
          },
        ],
      },
    ]);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      url: "https://example.com",
      title: "Example",
      citedText: "relevant quote",
    });
  });

  it("ignores non web_search_result_location citation types", () => {
    const result = extractResponseContent([
      {
        type: "text",
        text: "Citation test",
        citations: [{ type: "other_citation_type", url: "https://ignored.com" }],
      },
    ]);

    expect(result.citations).toHaveLength(0);
  });

  it("returns empty citations array when no citations exist", () => {
    const result = extractResponseContent([
      { type: "text", text: "No citations" },
    ]);

    expect(result.citations).toHaveLength(0);
  });
});

// ── Server Tool Results (Skip) ───────────────────────────────
describe("extractResponseContent — server tool blocks", () => {
  it("skips server_tool_use and tool_result blocks without error", () => {
    const result = extractResponseContent([
      { type: "server_tool_use" } as AnthropicBlock,
      { type: "web_search_tool_result" } as AnthropicBlock,
      { type: "text", text: "After server tools" },
    ]);

    expect(result.text).toBe("After server tools");
    expect(result.toolCalls).toHaveLength(0);
  });
});
