/**
 * Unit tests for the Anthropic `buildUsage` function.
 *
 * Validates token usage field extraction, cache token handling,
 * and null/undefined fallback behavior.
 */
import { describe, it, expect } from "vitest";

import { buildUsage } from "../../anthropic.ts";

describe("buildUsage", () => {
  it("maps all standard usage fields correctly", () => {
    const result = buildUsage({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    });

    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 25,
    });
  });

  it("defaults null fields to zero", () => {
    const result = buildUsage({
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });

    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("defaults undefined fields to zero", () => {
    const result = buildUsage({
      input_tokens: 500,
      output_tokens: 300,
      // cache fields undefined
    });

    expect(result).toEqual({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("handles null usage input", () => {
    const result = buildUsage(null);

    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("handles undefined usage input", () => {
    const result = buildUsage(undefined);

    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("preserves zero values without coercing to defaults", () => {
    const result = buildUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});
