import { describe, it, expect } from "vitest";
import {
  parseVllmResponse,
  parseLlamaCppResponse,
  parseOllamaResponse,
} from "#src/utils/ContextLengthDiscovery";

describe("ContextLengthDiscovery Parsers", () => {
  describe("parseVllmResponse", () => {
    it("returns context length on exact model match", () => {
      const payload = {
        data: [
          { id: "mistral-7b", max_model_len: 8192 },
          { id: "llama-3-8b", max_model_len: 131072 },
        ],
      };
      expect(parseVllmResponse(payload, "llama-3-8b")).toBe(131072);
    });

    it("returns context length on substring model match", () => {
      const payload = {
        data: [{ id: "casperhansen/llama-3-70b-instruct-awq", max_model_len: 131072 }],
      };
      expect(parseVllmResponse(payload, "llama-3-70b")).toBe(131072);
    });

    it("returns context length of the only entry when no match found", () => {
      const payload = {
        data: [{ id: "some-obscure-model", max_model_len: 4096 }],
      };
      expect(parseVllmResponse(payload, "random-query")).toBe(4096);
    });

    it("returns null on malformed payload", () => {
      expect(parseVllmResponse({}, "model")).toBeNull();
      expect(parseVllmResponse({ data: "not-an-array" }, "model")).toBeNull();
      expect(parseVllmResponse({ data: [] }, "model")).toBeNull();
    });
  });

  describe("parseLlamaCppResponse", () => {
    it("parses top-level n_ctx", () => {
      const payload = { n_ctx: 32768 };
      expect(parseLlamaCppResponse(payload)).toBe(32768);
    });

    it("parses nested default_params.n_ctx", () => {
      const payload = { default_params: { n_ctx: 16384 } };
      expect(parseLlamaCppResponse(payload)).toBe(16384);
    });

    it("returns null when n_ctx is missing", () => {
      expect(parseLlamaCppResponse({})).toBeNull();
      expect(parseLlamaCppResponse({ other: 123 })).toBeNull();
    });
  });

  describe("parseOllamaResponse", () => {
    it("parses context_length from model_info", () => {
      const payload = {
        model_info: {
          "llama.context_length": 131072,
          "llama.embedding_length": 4096,
        },
      };
      expect(parseOllamaResponse(payload, "llama3")).toBe(131072);
    });

    it("parses num_ctx from parameters string", () => {
      const payload = {
        parameters: "stop                           \"<|end_of_text|>\"\nstop                           \"<|eot_id|>\"\nnum_ctx                        32768\nnum_predict                    4096",
      };
      expect(parseOllamaResponse(payload, "llama3")).toBe(32768);
    });

    it("prefers model_info over parameters", () => {
      const payload = {
        model_info: { "context_length": 131072 },
        parameters: "num_ctx 32768",
      };
      expect(parseOllamaResponse(payload, "llama3")).toBe(131072);
    });

    it("returns null when no context info found", () => {
      expect(parseOllamaResponse({}, "llama3")).toBeNull();
      expect(parseOllamaResponse({ model_info: {} }, "llama3")).toBeNull();
    });
  });
});
