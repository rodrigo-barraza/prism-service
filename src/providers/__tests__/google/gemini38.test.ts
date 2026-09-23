/**
 * Gemini 3.8 and the current Gemini request surface (prompt 25 Landing 2).
 *
 *   - catalog: gemini-3.8-flash (GA 2026-09-02) and gemini-3.8-live, verified
 *     against ai.google.dev on 2026-09-22 and live on the API
 *   - sampling: temperature / top_p / top_k are deprecated from Gemini 3.6
 *     Flash and 3.5 Flash-Lite on (accepted and ignored today, a 400 in later
 *     generations) — never sent to those models
 *   - thinking: levels mapped per model; 3.8 Flash has no "minimal" (a 400,
 *     measured) and switches off with thinkingBudget 0 (200, measured)
 *   - thought signatures: replayed on every part that carried one, in the
 *     order the model produced them; text is never moved after the calls;
 *     history from another provider gets Google's documented dummy
 *     signature on its function calls
 */
import { describe, it, expect } from "vitest";

import {
  buildGenerateConfig,
  convertMessages,
  GEMINI_DUMMY_THOUGHT_SIGNATURE,
  type ConversationMessage,
} from "#src/providers/google";
import { getModelByName } from "#src/config";
import type { ProviderOptions } from "#src/types/ProviderTypes";

type CatalogModel = Record<string, unknown> & { name: string };
const model = (name: string) => getModelByName(name) as unknown as CatalogModel;

describe("gemini-3.8 catalog entries", () => {
  it("gemini-3.8-flash: 1,048,576 in / 65,536 out, low|medium|high, introductory prices", () => {
    const flash = model("gemini-3.8-flash");
    expect(flash).toBeTruthy();
    expect(flash.maxInputTokens).toBe(1_048_576);
    expect(flash.maxOutputTokens).toBe(65_536);
    expect(flash.thinkingLevels).toEqual(["low", "medium", "high"]);
    expect(flash.canDisableThinking).toBe(true);
    expect(flash.pricing).toMatchObject({
      inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 3.75,
    });
    // Not the Flash default (the prompt changes no default).
    expect(flash.default).toBeUndefined();
  });

  it("gemini-3.8-live: the Live API model, 131,072 in / 65,536 out, no thinking level", () => {
    const live = model("gemini-3.8-live");
    expect(live).toBeTruthy();
    expect(live.liveAPI).toBe(true);
    expect(live.maxInputTokens).toBe(131_072);
    expect(live.maxOutputTokens).toBe(65_536);
    // "thinking_level configuration is no longer supported" (migration note).
    expect(live.thinkingLevels).toBeUndefined();
  });

  it("marks sampling locked on every Gemini that deprecated it", () => {
    for (const name of [
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
      "gemini-3.8-live",
    ]) {
      expect(model(name).lockedSampling, name).toBe(true);
    }
    for (const name of ["gemini-3.5-flash", "gemini-3.1-flash-lite"]) {
      expect(model(name).lockedSampling, name).toBeUndefined();
    }
  });
});

describe("buildGenerateConfig — Gemini 3.6+ sampling", () => {
  const sampling = { temperature: 0.2, topP: 0.5, topK: 5 } as ProviderOptions;

  it.each(["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"])(
    "%s: no temperature, topP or topK",
    (name) => {
      const config = buildGenerateConfig(sampling, model(name) as never);
      expect(config.temperature).toBeUndefined();
      expect(config.topP).toBeUndefined();
      expect(config.topK).toBeUndefined();
    },
  );

  it("still sends them to models that take them", () => {
    const config = buildGenerateConfig(sampling, model("gemini-3.5-flash") as never);
    expect(config).toMatchObject({ temperature: 0.2, topP: 0.5, topK: 5 });
  });
});

describe("buildGenerateConfig — gemini-3.8-flash thinking", () => {
  const flash = () => model("gemini-3.8-flash") as never;

  it("switches thinking off with thinkingBudget 0 (minimal is a 400)", () => {
    expect(buildGenerateConfig({ thinkingEnabled: false } as ProviderOptions, flash()).thinkingConfig)
      .toEqual({ thinkingBudget: 0 });
  });

  it("forwards low|medium|high and never minimal", () => {
    expect(
      buildGenerateConfig({ thinkingLevel: "high" } as ProviderOptions, flash()).thinkingConfig,
    ).toMatchObject({ thinkingLevel: "high" });
    expect(
      buildGenerateConfig({ thinkingLevel: "minimal" } as ProviderOptions, flash()).thinkingConfig
        ?.thinkingLevel,
    ).toBeUndefined();
  });
});

describe("convertMessages — thought signatures in order", () => {
  it("keeps the model's text BEFORE its function calls (no reordering)", async () => {
    const contents = await convertMessages([
      { role: "user", content: "Paris weather?" },
      {
        role: "assistant",
        content: "Paris is lovely.",
        toolCalls: [{ name: "get_weather", args: { city: "Paris" }, thoughtSignature: "sig-fc" }],
      },
    ]);
    const modelTurn = contents.find((content) => content.role === "model")!;
    expect(modelTurn.parts).toEqual([
      { text: "Paris is lovely." },
      { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "sig-fc" },
    ]);
  });

  it("replays the recorded parts verbatim: text, thought and empty parts with their signatures, in order", async () => {
    const message: ConversationMessage = {
      role: "assistant",
      content: "Rome is old. Done.",
      toolCalls: [
        { name: "get_weather", args: { city: "Rome" }, thoughtSignature: "sig-fc-1" },
        { name: "get_weather", args: { city: "Milan" } },
      ],
      geminiParts: [
        { thought: true, text: "Plan the calls", thoughtSignature: "sig-thought" },
        { text: "Rome is old." },
        { functionCall: 0, thoughtSignature: "sig-fc-1" },
        { functionCall: 1 },
        { text: " Done.", thoughtSignature: "sig-text" },
        { text: "", thoughtSignature: "sig-trailing" },
      ],
    };
    const contents = await convertMessages([{ role: "user", content: "go" }, message]);
    const modelTurn = contents.find((content) => content.role === "model")!;
    expect(modelTurn.parts).toEqual([
      { text: "Plan the calls", thought: true, thoughtSignature: "sig-thought" },
      { text: "Rome is old." },
      { functionCall: { name: "get_weather", args: { city: "Rome" } }, thoughtSignature: "sig-fc-1" },
      { functionCall: { name: "get_weather", args: { city: "Milan" } } },
      { text: " Done.", thoughtSignature: "sig-text" },
      { text: "", thoughtSignature: "sig-trailing" },
    ]);
  });

  it("replays a server-side search call and result with their signatures", async () => {
    const toolCall = { toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["f1"] } };
    const toolResponse = { toolType: "GOOGLE_SEARCH_WEB", response: { search_suggestions: "x" } };
    const contents = await convertMessages([
      { role: "user", content: "F1?" },
      {
        role: "assistant",
        content: "Antonelli won.",
        geminiParts: [
          { toolCall, thoughtSignature: "sig-call" },
          { toolResponse, thoughtSignature: "sig-result" },
          { text: "Antonelli won." },
        ],
      },
    ]);
    expect(contents.find((content) => content.role === "model")!.parts).toEqual([
      { toolCall, thoughtSignature: "sig-call" },
      { toolResponse, thoughtSignature: "sig-result" },
      { text: "Antonelli won." },
    ]);
  });

  it("falls back to the stored content when the harness rewrote the text", async () => {
    const contents = await convertMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "A compacted summary.",
        geminiParts: [{ text: "The original answer.", thoughtSignature: "sig-text" }],
      },
    ]);
    const modelTurn = contents.find((content) => content.role === "model")!;
    expect(modelTurn.parts).toEqual([{ text: "A compacted summary." }]);
  });

  it("gives a Gemini 3 model the documented dummy signature for calls another provider made", async () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "weather in Oslo and Bergen" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "get_weather", args: { city: "Oslo" } },
          { name: "get_weather", args: { city: "Bergen" } },
        ],
      },
      { role: "tool", name: "get_weather", content: "rain" },
      { role: "tool", name: "get_weather", content: "rain" },
    ];
    const gemini3 = await convertMessages(history, { model: "gemini-3.8-flash" });
    const calls = gemini3.find((content) => content.role === "model")!.parts!;
    // Only the first call of the step carries a signature (as Gemini emits them).
    expect(calls[0]).toMatchObject({ thoughtSignature: GEMINI_DUMMY_THOUGHT_SIGNATURE });
    expect(calls[1]).not.toHaveProperty("thoughtSignature");
    expect(GEMINI_DUMMY_THOUGHT_SIGNATURE).toBe("skip_thought_signature_validator");

    // Pre-3 models never validated signatures: left as they were.
    const gemini25 = await convertMessages(history, { model: "gemini-2.5-flash" });
    expect(gemini25.find((content) => content.role === "model")!.parts![0]).not.toHaveProperty(
      "thoughtSignature",
    );
  });

  it("never replaces a real signature with the dummy", async () => {
    const contents = await convertMessages(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "get_weather", args: {}, thoughtSignature: "sig-real" }],
        },
      ],
      { model: "gemini-3.8-flash" },
    );
    expect(contents.find((content) => content.role === "model")!.parts![0]).toMatchObject({
      thoughtSignature: "sig-real",
    });
  });
});
