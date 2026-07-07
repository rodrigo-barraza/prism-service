/**
 * Unit tests for the Anthropic `buildTools` function.
 *
 * Validates server tool construction (web_search, web_fetch, code_execution),
 * custom function tool formatting, mixed tool scenarios, and empty-tools edge case.
 */
import { describe, it, expect } from "vitest";

import { buildTools } from "#src/providers/anthropic";
import type { ProviderOptions } from "#src/types/ProviderTypes";

// ── Server Tools ─────────────────────────────────────────────
describe("buildTools — server tools", () => {
  it("includes web_search tool when webSearch is enabled", () => {
    const result = buildTools({ webSearch: true } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "web_search_20260209",
          name: "web_search",
        }),
      ]),
    );
  });

  it("includes web_fetch tool when webFetch is enabled", () => {
    const result = buildTools({ webFetch: true } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "web_fetch_20250910",
          name: "web_fetch",
        }),
      ]),
    );
  });

  it("includes code_execution tool when codeExecution is enabled", () => {
    const result = buildTools({ codeExecution: true } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "code_execution_20250825",
          name: "code_execution",
        }),
      ]),
    );
  });

  it("combines multiple server tools", () => {
    const result = buildTools({
      webSearch: true,
      webFetch: true,
      codeExecution: true,
    } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
  });
});

// ── Custom Function Tools ────────────────────────────────────
describe("buildTools — custom function tools", () => {
  it("formats custom tools with name, description, and input_schema", () => {
    const result = buildTools({
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ],
    } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      name: "get_weather",
      description: "Get current weather",
      input_schema: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          city: expect.objectContaining({ type: "string" }),
        }),
      }),
    });
  });

  it("uses empty description and default schema when not provided", () => {
    const result = buildTools({
      tools: [{ name: "minimal_tool" }],
    } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result![0]).toMatchObject({
      name: "minimal_tool",
      description: "",
      input_schema: { type: "object", properties: {} },
    });
  });
});

// ── Mixed Server + Custom Tools ──────────────────────────────
describe("buildTools — mixed tools", () => {
  it("combines server and custom tools in a single array", () => {
    const result = buildTools({
      webSearch: true,
      tools: [
        {
          name: "custom_tool",
          description: "A custom tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as ProviderOptions);

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    // Server tool first, custom tool second
    expect(result![0]).toHaveProperty("type", "web_search_20260209");
    expect(result![1]).toHaveProperty("name", "custom_tool");
  });
});

// ── No Tools ─────────────────────────────────────────────────
describe("buildTools — empty/no tools", () => {
  it("returns undefined when no tools are configured", () => {
    const result = buildTools({} as ProviderOptions);
    expect(result).toBeUndefined();
  });

  it("returns undefined when tools array is empty", () => {
    const result = buildTools({ tools: [] } as ProviderOptions);
    expect(result).toBeUndefined();
  });
});
