import { afterEach, describe, it, expect, vi } from "vitest";
import {
  discoverContextLength,
  parseVllmResponse,
  parseLlamaCppResponse,
  parseOllamaResponse,
  parseSglangResponse,
} from "#src/utils/ContextLengthDiscovery";
import type { ProviderOptions } from "#src/types/provider";

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

describe("SGLang context length", () => {
  const sglangModels = {
    object: "list",
    data: [
      { id: "Qwen/Qwen3.6-27B", parent: null, max_model_len: 65536 },
      { id: "sql-lora", parent: "Qwen/Qwen3.6-27B", max_model_len: null },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the base model's window for the base model and its adapters", () => {
    expect(parseSglangResponse(sglangModels, "Qwen/Qwen3.6-27B")).toBe(65536);
    expect(parseSglangResponse(sglangModels, "Qwen/Qwen3.6-27B:sql-lora")).toBe(65536);
    // SGLang does not validate the model name — one base model answers for all
    expect(parseSglangResponse(sglangModels, "default")).toBe(65536);
  });

  it("returns null on a malformed payload", () => {
    expect(parseSglangResponse(null, "m")).toBeNull();
    expect(parseSglangResponse({ data: [{ id: "m" }] }, "m")).toBeNull();
  });

  it("routes an sglang instance to /v1/models with the server's auth header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(sglangModels), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options: ProviderOptions = {};
    await discoverContextLength(
      "sglang-3",
      "http://sglang-box:30000",
      "Qwen/Qwen3.6-27B:sql-lora",
      options,
      { Authorization: "Bearer sk-local" },
    );

    expect(options._loadedContextLength).toBe(65536);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sglang-box:30000/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer sk-local" } }),
    );
  });
});
