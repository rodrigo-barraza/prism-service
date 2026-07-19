/**
 * Unit tests for the Google `sanitizeSchemaForGoogle` function.
 *
 * Validates Google-specific schema sanitization: unsupported keyword
 * stripping, const→enum conversion, properties map preservation,
 * and recursive sanitization.
 */
import { describe, it, expect } from "vitest";

import { sanitizeSchemaForGoogle } from "#src/providers/google";

// ── Edge Cases ───────────────────────────────────────────────
describe("sanitizeSchemaForGoogle — edge cases", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeSchemaForGoogle(undefined)).toBeUndefined();
  });

  it("returns null for null input", () => {
    expect(sanitizeSchemaForGoogle(null)).toBeNull();
  });

  it("returns primitives unchanged", () => {
    expect(sanitizeSchemaForGoogle("string")).toBe("string");
    expect(sanitizeSchemaForGoogle(42)).toBe(42);
    expect(sanitizeSchemaForGoogle(true)).toBe(true);
  });

  it("sanitizes arrays recursively", () => {
    const result = sanitizeSchemaForGoogle([
      { type: "string", title: "should be stripped" },
    ]);

    expect(Array.isArray(result)).toBe(true);
    const firstItem = (result as Array<Record<string, unknown>>)[0];
    expect(firstItem.type).toBe("string");
    expect(firstItem).not.toHaveProperty("title");
  });
});

// ── Unsupported Keyword Stripping ────────────────────────────
describe("sanitizeSchemaForGoogle — unsupported keywords", () => {
  it("strips 'title' keyword", () => {
    const result = sanitizeSchemaForGoogle({
      type: "string",
      title: "Name field",
      description: "A name",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("title");
    expect(result.description).toBe("A name");
  });

  it("strips 'default' keyword", () => {
    const result = sanitizeSchemaForGoogle({
      type: "string",
      default: "hello",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("default");
  });

  it("strips '$schema' keyword", () => {
    const result = sanitizeSchemaForGoogle({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("$schema");
  });

  it("preserves supported keywords: type, description, properties, required, enum, items", () => {
    const schema = {
      type: "object",
      description: "A person",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    const result = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;

    expect(result.type).toBe("object");
    expect(result.description).toBe("A person");
    expect(result.properties).toBeDefined();
    expect(result.required).toEqual(["name"]);
  });
});

// ── const → enum Conversion ──────────────────────────────────
describe("sanitizeSchemaForGoogle — const to enum conversion", () => {
  it("converts const to single-value enum", () => {
    const result = sanitizeSchemaForGoogle({
      const: "fixed_value",
    }) as Record<string, unknown>;

    expect(result.enum).toEqual(["fixed_value"]);
    expect(result).not.toHaveProperty("const");
  });

  it("converts numeric const to enum", () => {
    const result = sanitizeSchemaForGoogle({
      const: 42,
    }) as Record<string, unknown>;

    expect(result.enum).toEqual([42]);
  });
});

// ── Properties Map Preservation ──────────────────────────────
describe("sanitizeSchemaForGoogle — properties map field names", () => {
  it("preserves user-defined field names that match unsupported keywords", () => {
    const result = sanitizeSchemaForGoogle({
      type: "object",
      properties: {
        title: { type: "string" },
        default: { type: "number" },
      },
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, unknown>;
    // "title" and "default" are field names here, not schema keywords
    expect(properties.title).toBeDefined();
    expect(properties.default).toBeDefined();
  });
});

// ── Recursive Sanitization ───────────────────────────────────
describe("sanitizeSchemaForGoogle — recursive sanitization", () => {
  it("sanitizes nested object schemas", () => {
    const result = sanitizeSchemaForGoogle({
      type: "object",
      properties: {
        address: {
          type: "object",
          title: "Should be stripped",
          properties: {
            street: { type: "string", title: "Also stripped" },
          },
        },
      },
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, Record<string, unknown>>;
    expect(properties.address).not.toHaveProperty("title");
    const addressProperties = properties.address.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(addressProperties.street).not.toHaveProperty("title");
  });

  it("sanitizes array items schema", () => {
    const result = sanitizeSchemaForGoogle({
      type: "array",
      items: { type: "string", title: "Strip me" },
    }) as Record<string, unknown>;

    const items = result.items as Record<string, unknown>;
    expect(items).not.toHaveProperty("title");
  });
});

describe("sanitizeSchemaForGoogle — object-constraint keywords (Gemini 400 regression)", () => {
  // Gemini rejects propertyNames with 400 INVALID_ARGUMENT ("Unknown name
  // \"propertyNames\" ... Cannot find field") — seen live 2026-07-19 from a
  // dynamically-sourced tool schema.
  it("strips propertyNames and other object-constraint keywords", () => {
    const result = sanitizeSchemaForGoogle({
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      minProperties: 1,
      maxProperties: 10,
      dependentRequired: { a: ["b"] },
      unevaluatedProperties: false,
      properties: {
        value: {
          type: "object",
          propertyNames: { maxLength: 20 },
          description: "keyed map",
        },
      },
    }) as Record<string, unknown>;
    expect(result.propertyNames).toBeUndefined();
    expect(result.minProperties).toBeUndefined();
    expect(result.maxProperties).toBeUndefined();
    expect(result.dependentRequired).toBeUndefined();
    expect(result.unevaluatedProperties).toBeUndefined();
    const value = (result.properties as Record<string, Record<string, unknown>>).value;
    expect(value.propertyNames).toBeUndefined();
    expect(value.description).toBe("keyed map");
  });

  it("keeps user-defined property fields that share unsupported keyword names", () => {
    const result = sanitizeSchemaForGoogle({
      type: "object",
      properties: {
        propertyNames: { type: "string", description: "a field literally named propertyNames" },
        definitions: { type: "number" },
      },
    }) as Record<string, unknown>;
    const properties = result.properties as Record<string, unknown>;
    expect(properties.propertyNames).toBeDefined();
    expect(properties.definitions).toBeDefined();
  });

  it("strips array/content-constraint keywords Gemini rejects", () => {
    const result = sanitizeSchemaForGoogle({
      type: "array",
      prefixItems: [{ type: "string" }],
      additionalItems: false,
      contains: { type: "number" },
      minContains: 1,
      items: { type: "string", contentEncoding: "base64" },
    }) as Record<string, unknown>;
    expect(result.prefixItems).toBeUndefined();
    expect(result.additionalItems).toBeUndefined();
    expect(result.contains).toBeUndefined();
    expect(result.minContains).toBeUndefined();
    expect((result.items as Record<string, unknown>).contentEncoding).toBeUndefined();
    expect((result.items as Record<string, unknown>).type).toBe("string");
  });
});
