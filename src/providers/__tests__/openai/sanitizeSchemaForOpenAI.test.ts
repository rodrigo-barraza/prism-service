/**
 * Unit tests for the OpenAI `sanitizeSchemaForOpenAI` function.
 *
 * Validates JSON Schema sanitization for OpenAI strict mode:
 * forbidden keyword stripping, object enforcement, nullable conversion,
 * and recursive sanitization.
 */
import { describe, it, expect } from "vitest";

import { sanitizeSchemaForOpenAI } from "../../openai.ts";

// ── Primitive / Edge Cases ───────────────────────────────────
describe("sanitizeSchemaForOpenAI — edge cases", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeSchemaForOpenAI(undefined)).toBeUndefined();
  });

  it("returns null for null input", () => {
    expect(sanitizeSchemaForOpenAI(null)).toBeNull();
  });

  it("returns primitives unchanged", () => {
    expect(sanitizeSchemaForOpenAI("string")).toBe("string");
    expect(sanitizeSchemaForOpenAI(42)).toBe(42);
    expect(sanitizeSchemaForOpenAI(true)).toBe(true);
  });

  it("sanitizes arrays recursively", () => {
    const result = sanitizeSchemaForOpenAI([
      { type: "string", pattern: "^test$" },
    ]);

    expect(Array.isArray(result)).toBe(true);
    const firstItem = (result as Array<Record<string, unknown>>)[0];
    expect(firstItem.type).toBe("string");
    expect(firstItem).not.toHaveProperty("pattern");
  });
});

// ── Forbidden Keyword Stripping ──────────────────────────────
describe("sanitizeSchemaForOpenAI — forbidden keywords", () => {
  it("strips 'pattern' keyword", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "string",
      pattern: "^[a-z]+$",
      description: "lowercase only",
    });

    expect(result).toMatchObject({ type: "string", description: "lowercase only" });
    expect(result).not.toHaveProperty("pattern");
  });

  it("strips 'minimum' and 'maximum' keywords", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "number",
      minimum: 0,
      maximum: 100,
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("minimum");
    expect(result).not.toHaveProperty("maximum");
  });

  it("strips 'default' keyword", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "string",
      default: "hello",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("default");
  });

  it("strips 'examples' keyword", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "string",
      examples: ["foo", "bar"],
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("examples");
  });

  it("preserves allowed keywords: type, description, enum, const, items, $ref, $defs", () => {
    const schema = {
      type: "string",
      description: "A color",
      enum: ["red", "green", "blue"],
    };
    const result = sanitizeSchemaForOpenAI(schema) as Record<string, unknown>;

    expect(result.type).toBe("string");
    expect(result.description).toBe("A color");
    expect(result.enum).toEqual(["red", "green", "blue"]);
  });
});

// ── Object Type Enforcement ──────────────────────────────────
describe("sanitizeSchemaForOpenAI — object type enforcement", () => {
  it("adds additionalProperties: false to object types", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    }) as Record<string, unknown>;

    expect(result.additionalProperties).toBe(false);
  });

  it("adds empty properties and required when missing on object type", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
    }) as Record<string, unknown>;

    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
    expect(result.additionalProperties).toBe(false);
  });

  it("makes non-required properties nullable via anyOf", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        required_field: { type: "string" },
        optional_field: { type: "number" },
      },
      required: ["required_field"],
    }) as Record<string, unknown>;

    // Both fields should now be required
    expect(result.required).toContain("required_field");
    expect(result.required).toContain("optional_field");

    // optional_field should be converted to anyOf with null
    const properties = result.properties as Record<string, Record<string, unknown>>;
    expect(properties.optional_field.anyOf).toBeDefined();
    const anyOfBranches = properties.optional_field.anyOf as Array<{ type: string }>;
    expect(anyOfBranches.some((branch) => branch.type === "null")).toBe(true);
    expect(anyOfBranches.some((branch) => branch.type === "number")).toBe(true);
  });

  it("preserves originally required properties without nullable wrapping", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        name: { type: "string", description: "The name" },
      },
      required: ["name"],
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, Record<string, unknown>>;
    // Already required — should NOT be wrapped in anyOf
    expect(properties.name.type).toBe("string");
    expect(properties.name.anyOf).toBeUndefined();
  });
});

// ── Array Type Conversion ────────────────────────────────────
describe("sanitizeSchemaForOpenAI — array type values", () => {
  it("converts array type values to anyOf format", () => {
    const result = sanitizeSchemaForOpenAI({
      type: ["string", "number"],
    }) as Record<string, unknown>;

    expect(result.anyOf).toBeDefined();
    const anyOfBranches = result.anyOf as Array<{ type: string }>;
    expect(anyOfBranches).toHaveLength(2);
    expect(anyOfBranches[0].type).toBe("string");
    expect(anyOfBranches[1].type).toBe("number");
  });

  it("converts nullable array type including null", () => {
    const result = sanitizeSchemaForOpenAI({
      type: ["string", "null"],
    }) as Record<string, unknown>;

    expect(result.anyOf).toBeDefined();
    const anyOfBranches = result.anyOf as Array<{ type: string }>;
    expect(anyOfBranches.some((branch) => branch.type === "string")).toBe(true);
    expect(anyOfBranches.some((branch) => branch.type === "null")).toBe(true);
  });
});

// ── Recursive Sanitization ───────────────────────────────────
describe("sanitizeSchemaForOpenAI — recursive sanitization", () => {
  it("sanitizes nested object schemas recursively", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string", pattern: "^[A-Z]" },
          },
          required: ["street"],
        },
      },
      required: ["address"],
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, Record<string, unknown>>;
    const addressProperties = properties.address.properties as Record<
      string,
      Record<string, unknown>
    >;
    // pattern should be stripped from the nested schema
    expect(addressProperties.street).not.toHaveProperty("pattern");
    // nested object should have additionalProperties: false
    expect(properties.address.additionalProperties).toBe(false);
  });

  it("sanitizes items in array schemas", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
      required: ["tags"],
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, Record<string, unknown>>;
    const tagItems = properties.tags.items as Record<string, unknown>;
    expect(tagItems).not.toHaveProperty("minLength");
  });

  it("preserves user-defined field names inside properties maps", () => {
    const result = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        pattern: { type: "string" },
        minimum: { type: "number" },
      },
      required: ["pattern", "minimum"],
    }) as Record<string, unknown>;

    // "pattern" and "minimum" are field names, NOT schema keywords here
    const properties = result.properties as Record<string, unknown>;
    expect(properties.pattern).toBeDefined();
    expect(properties.minimum).toBeDefined();
  });
});
