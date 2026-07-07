import { describe, it, expect } from "vitest";
import { PostPromptSchema, PatchPromptSchema } from "#src/types/schemas";

describe("Prompts Schema Validation Adversarial Tests", () => {
  describe("PostPromptSchema", () => {
    it("should validate a valid prompt payload with optional color", () => {
      const validPayload = {
        title: "Test Title",
        content: "Test Content",
        tags: ["coding", "test"],
        color: "oklch(0.61 0.16 245)",
      };

      const parseResult = PostPromptSchema.safeParse(validPayload);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.color).toBe("oklch(0.61 0.16 245)");
      }
    });

    it("should accept valid payload without color", () => {
      const validPayload = {
        title: "Test Title",
        content: "Test Content",
        tags: ["coding"],
      };

      const parseResult = PostPromptSchema.safeParse(validPayload);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.color).toBeUndefined();
      }
    });

    it("should reject color that is too long", () => {
      const invalidPayload = {
        title: "Test Title",
        content: "Test Content",
        color: "a".repeat(101),
      };

      const parseResult = PostPromptSchema.safeParse(invalidPayload);
      expect(parseResult.success).toBe(false);
    });

    it("should reject payload missing title", () => {
      const invalidPayload = {
        content: "Test Content",
      };

      const parseResult = PostPromptSchema.safeParse(invalidPayload);
      expect(parseResult.success).toBe(false);
    });
  });

  describe("PatchPromptSchema", () => {
    it("should validate partial updates including color", () => {
      const patchPayload = {
        color: "oklch(0.57 0.20 20)",
      };

      const parseResult = PatchPromptSchema.safeParse(patchPayload);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.color).toBe("oklch(0.57 0.20 20)");
      }
    });

    it("should reject color that is too long in patch", () => {
      const patchPayload = {
        color: "a".repeat(101),
      };

      const parseResult = PatchPromptSchema.safeParse(patchPayload);
      expect(parseResult.success).toBe(false);
    });
  });
});
