import { describe, it, expect } from "vitest";
import { getProvider, listProviders } from "../src/providers/index.ts";
import { PROVIDERS, TYPES } from "../src/constants.ts";
import { convertToolsToGoogle } from "../src/providers/google.ts";
import {
  normalizeResponsesUsage,
  prepareResponsesInput,
} from "../src/providers/openai.ts";

describe("Provider Helpers and Adapters Suite", () => {
  // ── 1. Provider Registry Tests ──────────────────────────────────────
  describe("Provider Registry", () => {
    it("should list all registered static providers", () => {
      const providerList = listProviders();
      expect(providerList).toContain(PROVIDERS.OPENAI);
      expect(providerList).toContain(PROVIDERS.GOOGLE);
      expect(providerList).toContain(PROVIDERS.ANTHROPIC);
      expect(providerList).toContain(PROVIDERS.ELEVENLABS);
    });

    it("should retrieve a provider by name with tracking wrapped proxy", () => {
      const providerInstance = getProvider(PROVIDERS.GOOGLE);
      expect(providerInstance).toBeDefined();
      expect(typeof providerInstance.generateText).toBe("function");
    });

    it("should throw descriptive error for unknown providers", () => {
      expect(() => getProvider("unknown-provider")).toThrowError(
        /Unknown provider "unknown-provider"/
      );
    });
  });

  // ── 2. Google Provider Helper Tests ─────────────────────────────────
  describe("Google Provider Helpers", () => {
    it("should convert generic tools schema to Google tool declarations and sanitize schemas", () => {
      const inputTools = [
        {
          name: "fetch_data",
          description: "Fetch web data",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target URL" },
              constValue: { type: "string", const: "fixed-value" },
              unsupportedProperty: { type: "string", examples: ["example"] },
            },
            required: ["url"],
          },
        },
      ];

      const googleDeclarations = convertToolsToGoogle(inputTools);

      expect(googleDeclarations).not.toBeNull();
      expect(googleDeclarations).toHaveLength(1);
      const declaration = googleDeclarations![0].functionDeclarations[0];
      expect(declaration.name).toBe("fetch_data");
      expect(declaration.description).toBe("Fetch web data");

      const parameters = declaration.parameters as any;
      expect(parameters.type).toBe("object");
      expect(parameters.properties.url).toEqual({
        type: "string",
        description: "Target URL",
      });

      // const converted to enum
      expect(parameters.properties.constValue).toEqual({
        type: "string",
        enum: ["fixed-value"],
      });

      // examples property stripped
      expect(parameters.properties.unsupportedProperty).toEqual({
        type: "string",
      });
    });

    it("should return null when tools are empty or undefined", () => {
      expect(convertToolsToGoogle(null)).toBeNull();
      expect(convertToolsToGoogle([])).toBeNull();
    });
  });

  // ── 3. OpenAI Provider Helper Tests ─────────────────────────────────
  describe("OpenAI Provider Helpers", () => {
    describe("normalizeResponsesUsage", () => {
      it("should extract usage statistics and subtract cached tokens from input", () => {
        const usage = normalizeResponsesUsage({
          input_tokens: 150,
          output_tokens: 80,
          input_tokens_details: { cached_tokens: 50 },
          output_tokens_details: { reasoning_tokens: 30 },
        });

        expect(usage.inputTokens).toBe(100); // 150 - 50 = 100
        expect(usage.outputTokens).toBe(80);
        expect(usage.cacheReadInputTokens).toBe(50);
        expect(usage.reasoningOutputTokens).toBe(30);
      });

      it("should handle empty or null usage gracefully", () => {
        const usage = normalizeResponsesUsage(null);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
      });
    });

    describe("prepareResponsesInput", () => {
      it("should convert system message to developer message", () => {
        const messages = [
          { role: "system", content: "System prompt instructions" },
          { role: "user", content: "Hello" },
        ];

        const prepared = prepareResponsesInput(messages);
        expect(prepared).toHaveLength(2);
        expect((prepared[0] as any).role).toBe("developer");
        expect((prepared[0] as any).content).toBe("System prompt instructions");
        expect((prepared[1] as any).role).toBe("user");
        expect((prepared[1] as any).content).toBe("Hello");
      });

      it("should correctly compile tool call assistant responses and reasoning items", () => {
        const messages = [
          {
            role: "assistant",
            content: "I will call the get_weather tool.",
            toolCalls: [
              {
                id: "call-1",
                name: "get_weather",
                args: { city: "San Francisco" },
                reasoningItem: {
                  id: "reason-1",
                  summary: [{ type: TYPES.TEXT, text: "Reasoning about weather tool call." }],
                },
              },
            ],
          },
        ];

        const prepared = prepareResponsesInput(messages);
        // Should compile into assistant message, reasoning item, and function call item
        expect(prepared).toHaveLength(3);
        expect(prepared[0]).toEqual({
          role: "assistant",
          content: "I will call the get_weather tool.",
        });
        expect((prepared[1] as any).type).toBe("reasoning");
        expect((prepared[1] as any).id).toBe("reason-1");
        expect((prepared[2] as any).type).toBe("function_call");
        expect((prepared[2] as any).name).toBe("get_weather");
      });

      it("should convert tool result messages to function_call_output items", () => {
        const messages = [
          {
            role: "tool",
            tool_call_id: "call-1",
            content: "Sunny, 72 degrees",
          },
        ];

        const prepared = prepareResponsesInput(messages);
        expect(prepared).toHaveLength(1);
        expect((prepared[0] as any).type).toBe("function_call_output");
        expect((prepared[0] as any).call_id).toBe("call-1");
        expect((prepared[0] as any).output).toBe("Sunny, 72 degrees");
      });
    });
  });
});
