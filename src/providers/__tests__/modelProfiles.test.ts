/**
 * ModelProfiles — one table of each model's request surface, applied by the
 * provider registry to every text generation call.
 *
 *   - invariants over the whole catalog (every conversation model has a
 *     profile that agrees with its catalog entry)
 *   - one test per rejected-parameter rule, through getProvider and the
 *     adapter to the SDK request: Claude 4.7+, Gemini 3.6+, GPT-6 Astra,
 *     Kimi K3 — each beside a model of the same provider that keeps sampling
 *   - effort clamping and tool_choice mapping
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const openaiCreate = vi.hoisted(() => vi.fn());
const geminiGenerate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class OpenAIMock {
    responses = { create: openaiCreate };
    constructor(_options: unknown) {}
  }
  return { default: OpenAIMock, toFile: vi.fn() };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerate, generateContentStream: vi.fn() };
    live = { connect: vi.fn() };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  MediaResolution: { LOW: "LOW", HIGH: "HIGH" },
  ServiceTier: { AUTO: "AUTO", STANDARD: "STANDARD" },
}));

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, OPENAI_API_KEY: "test-key", GOOGLE_CLOUD_GEMINI_API_KEY: "test-key" };
});

import { getModelByName, getModelOptions, MODALITY_TYPES } from "#src/config";
import { getProvider } from "#src/providers/index";
import { anthropicCompatibleEndpoint } from "#src/providers/anthropic";
import { setKimiAnthropicClient } from "#src/providers/moonshot-anthropic";
import {
  applyModelProfile,
  declaredBillionParameters,
  effortWithinProfile,
  getModelProfile,
  promptCacheWindow,
} from "#src/providers/ModelProfiles";
import type { ChatMessage } from "#src/types/provider";

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const SAMPLING = { temperature: 0.3, topP: 0.9, topK: 40 };
const hello: ChatMessage[] = [{ role: "user", content: "hello" }];

type CatalogEntry = Record<string, unknown> & { name: string };

function conversationModels(): Array<{ provider: string; model: CatalogEntry }> {
  const options = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT) as unknown as Record<string, CatalogEntry[]>;
  return Object.entries(options).flatMap(([provider, models]) =>
    models
      .filter((model) => (model.outputTypes as string[] | undefined)?.includes(MODALITY_TYPES.TEXT) ?? true)
      .map((model) => ({ provider, model: (getModelByName(model.name) as CatalogEntry) ?? model })),
  );
}

describe("ModelProfiles — invariants over the catalog", () => {
  const models = conversationModels();

  it("covers the conversation catalog", () => {
    expect(models.length).toBeGreaterThan(20);
    for (const provider of ["anthropic", "google", "openai", "moonshot"]) {
      expect(models.some((entry) => entry.provider === provider)).toBe(true);
    }
  });

  it.each(models.map((entry) => [`${entry.provider}/${entry.model.name}`, entry]))(
    "%s: its profile agrees with the catalog",
    (_label, { provider, model }) => {
      const profile = getModelProfile(model.name, provider);
      expect(profile.model).toBe(model.name);

      // The effort vocabulary is the catalog's, ordered weakest → strongest.
      const levels = model.thinkingLevels as string[] | undefined;
      if (levels?.length) {
        expect(profile.efforts).not.toBeNull();
        for (const level of levels.filter((level) => EFFORT_ORDER.includes(level))) {
          expect(profile.efforts).toContain(level);
        }
        const ranks = profile.efforts!.map((effort) => EFFORT_ORDER.indexOf(effort));
        expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
        expect(profile.efforts!.includes("none")).toBe(model.canDisableThinking === true);
      } else {
        expect(profile.efforts).toBeNull();
      }

      // A locked-sampling model rejects temperature at the least.
      if (model.lockedSampling === true) expect(profile.rejectedParameters).toContain("temperature");
      else if (model.adaptiveThinking !== true) expect(profile.rejectedParameters).not.toContain("temperature");

      // Every model takes "auto" and "none"; forced choice only where allowed.
      expect(profile.toolChoice).toEqual(expect.arrayContaining(["auto", "none"]));
      if (model.noForcedToolChoice === true) expect(profile.toolChoice).not.toContain("any");

      expect(profile.caching.length).toBeGreaterThan(0);
      expect(profile.guidedToolArguments).toBeNull();
      expect(profile.budget.name).toBe("standard");
    },
  );

  it.each(models.map((entry) => [`${entry.provider}/${entry.model.name}`, entry]))(
    "%s: applying the profile twice is applying it once, and every effort lands in the vocabulary",
    (_label, { provider, model }) => {
      const profile = getModelProfile(model.name, provider);
      for (const effort of EFFORT_ORDER.slice(1)) {
        const once = applyModelProfile(profile, { ...SAMPLING, reasoningEffort: effort, toolChoice: "any" });
        expect(applyModelProfile(profile, once)).toBe(once);
        if (profile.efforts) expect(profile.efforts).toContain(once!.reasoningEffort);
        for (const parameter of profile.rejectedParameters) expect(once).not.toHaveProperty(parameter);
      }
    },
  );
});

describe("ModelProfiles — effort and tool_choice", () => {
  it("clamps below the floor up, above the ceiling down, and a gap to the next level up", () => {
    const astra = getModelProfile("gpt-6-astra", "openai");
    expect(astra.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortWithinProfile(astra, "minimal")).toBe("low");
    expect(effortWithinProfile(astra, "xhigh")).toBe("xhigh");

    const gapped = { ...astra, efforts: ["low", "high", "max"] };
    expect(effortWithinProfile(gapped, "medium")).toBe("high");
    expect(effortWithinProfile({ ...astra, efforts: ["low", "medium", "high"] }, "max")).toBe("high");
    expect(effortWithinProfile(astra, "turbo")).toBeUndefined();
  });

  it("leaves thinking-off ('none') to the adapter", () => {
    const astra = getModelProfile("gpt-6-astra", "openai");
    const options = { reasoningEffort: "none" };
    expect(applyModelProfile(astra, options)).toBe(options);
  });

  it("maps forced tool choice to auto on a model that rejects it, and keeps it elsewhere", () => {
    const opus = getModelProfile("claude-opus-5-5", "anthropic");
    expect(opus.toolChoice).toEqual(["auto", "none"]);
    expect(applyModelProfile(opus, { toolChoice: "any" })).toEqual({ toolChoice: "auto" });
    expect(applyModelProfile(opus, { toolChoice: "required" })).toEqual({ toolChoice: "auto" });

    const sonnet = getModelProfile("claude-sonnet-4-6", "anthropic");
    const forced = { toolChoice: "any" };
    expect(applyModelProfile(sonnet, forced)).toBe(forced);

    const kimi = getModelProfile("kimi-k3", "moonshot");
    expect(applyModelProfile(kimi, { toolChoice: "tool" })).toEqual({ toolChoice: "auto" });
  });

  it("names each provider's caching mechanism", () => {
    expect(getModelProfile("claude-opus-5-5", "anthropic").caching).toEqual(["cache_breakpoints"]);
    expect(getModelProfile("kimi-k3", "moonshot").caching).toContain("top_level_cache_control");
    expect(getModelProfile("kimi-k2.6", "moonshot").caching).toEqual(["automatic_prefix"]);
    expect(getModelProfile("gpt-6-sol", "openai").caching).toEqual(["automatic_prefix"]);
    expect(getModelProfile("gemini-3.8-flash", "google").caching).toContain("implicit");
  });

  // What a client re-sending a prefix next turn can expect to find warm
  // (Lupos's channel sessions end with it) — per mechanism, CACHE_LIFE_SECONDS.
  it("gives each provider's cache life", () => {
    expect(getModelProfile("claude-sonnet-5", "anthropic").cacheLifeSeconds).toBe(300);
    expect(getModelProfile("gemini-3.8-flash", "google").cacheLifeSeconds).toBe(600);
    expect(getModelProfile("gpt-6-sol", "openai").cacheLifeSeconds).toBe(600);
    expect(getModelProfile("kimi-k3", "moonshot").cacheLifeSeconds).toBe(300);
    expect(getModelProfile("kimi-k2.6", "moonshot").cacheLifeSeconds).toBe(600);
    expect(getModelProfile("google/gemma-4-12b-it", "vllm").cacheLifeSeconds).toBe(3600);
  });

  it("dates the done event's promptCache from the turn's last request start", () => {
    const startedAt = Date.parse("2026-09-25T20:30:57.000Z");
    expect(promptCacheWindow("google", "gemini-3.8-flash", startedAt)).toEqual({
      promptCache: { lifeSeconds: 600, expiresAt: "2026-09-25T20:40:57.000Z" },
    });
    expect(promptCacheWindow("anthropic", "claude-sonnet-5", startedAt).promptCache?.expiresAt).toBe(
      "2026-09-25T20:35:57.000Z",
    );
    expect(promptCacheWindow("google", "gemini-3.8-flash", null)).toEqual({});
  });
});

describe("ModelProfiles — local models", () => {
  it("reads the parameter count from the model name", () => {
    expect(declaredBillionParameters("google/gemma-4-12b-it")).toBe(12);
    expect(declaredBillionParameters("Qwen/Qwen3.8-27B")).toBe(27);
    expect(declaredBillionParameters("mistralai/Mixtral-8x7B-Instruct")).toBe(56);
    expect(declaredBillionParameters("gpt-oss-20b")).toBe(20);
    expect(declaredBillionParameters("my-finetune")).toBeNull();
  });

  it("gives small local models the lightweight preset and the rest the standard one", () => {
    expect(getModelProfile("google/gemma-4-12b-it", "vllm").budget.name).toBe("lightweight");
    expect(getModelProfile("Qwen/Qwen3.8-4B", "llama-cpp-2").budget.name).toBe("lightweight");
    expect(getModelProfile("Qwen/Qwen3.8-27B", "vllm").budget.name).toBe("standard");
    expect(getModelProfile("my-finetune", "vllm").budget.name).toBe("standard");
  });

  it("guides tool arguments only where the runtime and model support it", () => {
    expect(getModelProfile("Qwen/Qwen3.8-27B", "vllm").guidedToolArguments).toBe("vllm_strict");
    expect(getModelProfile("openai/gpt-oss-120b", "vllm-2").guidedToolArguments).toBe("vllm_strict");
    expect(getModelProfile("google/gemma-4-12b-it", "vllm").guidedToolArguments).toBeNull();
    expect(getModelProfile("anything.gguf", "llama-cpp").guidedToolArguments).toBe("server_grammar");
    expect(getModelProfile("Qwen/Qwen3.8-27B", "ollama").guidedToolArguments).toBeNull();
  });
});

// ── One adapter test per rejected-parameter rule ─────────────────

function fakeAnthropicClient() {
  const bodies: Array<Record<string, unknown>> = [];
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  const client = {
    messages: {
      create(body: Record<string, unknown>) {
        bodies.push(body);
        return { withResponse: async () => ({ data: { ...message, model: body.model }, response: new Response(null) }) };
      },
    },
  } as unknown as Anthropic;
  return { client, bodies };
}

function openaiStream() {
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
  ];
  async function* iterate() {
    for (const event of events) yield event;
  }
  return { withResponse: async () => ({ data: iterate(), response: { headers: new Headers() } }) };
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // consume
  }
}

beforeEach(() => {
  openaiCreate.mockReset();
  geminiGenerate.mockReset();
  geminiGenerate.mockResolvedValue({
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
  });
});
afterEach(() => setKimiAnthropicClient(null));

describe("rejected parameters reach no SDK request", () => {
  async function anthropicBody(model: string) {
    const { client, bodies } = fakeAnthropicClient();
    await anthropicCompatibleEndpoint.run({ client: () => client }, () =>
      getProvider("anthropic").generateText(hello, model, { ...SAMPLING, thinkingEnabled: false }),
    );
    return bodies[0];
  }

  it("Claude 4.7+: no temperature / top_p / top_k (Claude Sonnet 4.5 keeps its temperature)", async () => {
    const opus = await anthropicBody("claude-opus-4-7");
    for (const field of ["temperature", "top_p", "top_k"]) expect(opus).not.toHaveProperty(field);
    const sonnet = await anthropicBody("claude-sonnet-4-5-20250929");
    expect(sonnet.temperature).toBe(0.3);
  });

  it("Gemini 3.6+: no temperature / topP / topK (Gemini 3.5 Flash keeps them)", async () => {
    await getProvider("google").generateText(hello, "gemini-3.6-flash", SAMPLING);
    const locked = geminiGenerate.mock.calls.at(-1)![0].config as Record<string, unknown>;
    for (const field of ["temperature", "topP", "topK"]) expect(locked).not.toHaveProperty(field);

    await getProvider("google").generateText(hello, "gemini-3.5-flash", SAMPLING);
    const open = geminiGenerate.mock.calls.at(-1)![0].config as Record<string, unknown>;
    expect(open.temperature).toBe(0.3);
  });

  it("GPT-6 Astra: no temperature / top_p even at the lowest effort", async () => {
    openaiCreate.mockImplementation(() => openaiStream());
    await drain(
      getProvider("openai").generateTextStream!(hello, "gpt-6-astra", { ...SAMPLING, reasoningEffort: "low" }),
    );
    const payload = openaiCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
  });

  it("Kimi K3: no sampling on the Anthropic-compatible endpoint", async () => {
    const { client, bodies } = fakeAnthropicClient();
    setKimiAnthropicClient(client);
    await getProvider("moonshot").generateText(hello, "kimi-k3", SAMPLING);
    for (const field of ["temperature", "top_p", "top_k"]) expect(bodies[0]).not.toHaveProperty(field);
  });

  it("the registry strips them before the adapter sees the options", async () => {
    const google = (await import("#src/providers/google")).default;
    const spy = vi.spyOn(google, "generateText");
    await getProvider("google").generateText(hello, "gemini-3.8-flash", { ...SAMPLING, maxTokens: 64 });
    expect(spy.mock.calls[0][2]).toEqual({ maxTokens: 64 });
    spy.mockRestore();
  });
});
