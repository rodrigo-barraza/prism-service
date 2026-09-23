/**
 * OpenAI's long-context pricing: a request whose prompt passes 272K tokens
 * bills whole at the model's `…Over272kPerMillion` rates. The mark is made
 * per request (markLongContext, in the OpenAI adapter, per response) so a
 * turn of many short requests that add up past 272K is never billed as long.
 */
import { describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class OpenAIMock {
    responses = { create: createMock };
    constructor(_options: unknown) {}
  }
  return { default: OpenAIMock, toFile: vi.fn() };
});

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, OPENAI_API_KEY: "test-key" };
});

import { getModelByName } from "#src/config";
import openaiProvider from "#src/providers/openai";
import {
  LONG_CONTEXT_THRESHOLD_TOKENS,
  calculateTextCost,
  createUsageAccumulator,
  markLongContext,
  mergeUsage,
  type TextPricing,
} from "#src/utils/CostCalculator";
import type { TokenUsage } from "#src/types/admin";

const pricingOf = (model: string) => (getModelByName(model) as { pricing: TextPricing }).pricing;
const SOL = pricingOf("gpt-6-sol");
const GPT_54 = pricingOf("gpt-5.4");

const long: TokenUsage = {
  inputTokens: 100_000,
  cacheReadInputTokens: 200_000,
  cacheCreationInputTokens: 0,
  outputTokens: 1_000,
};
const short: TokenUsage = { inputTokens: 50_000, cacheReadInputTokens: 100_000, outputTokens: 1_000 };

describe("markLongContext", () => {
  it("marks a request past the threshold, and only on a model priced that way", () => {
    expect(markLongContext(long, SOL).longContext).toEqual({
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 0,
    });
    expect(markLongContext(short, SOL)).toBe(short);
    expect(markLongContext(long, pricingOf("claude-opus-5-5"))).toBe(long);
    const atThreshold = { inputTokens: LONG_CONTEXT_THRESHOLD_TOKENS };
    expect(markLongContext(atThreshold, SOL)).toBe(atThreshold);
  });
});

describe("calculateTextCost — long-context requests", () => {
  it("bills a long request whole at the long-context rates", () => {
    const expected = 0.1 * 4.0 + 0.2 * 0.4 + 0.001 * 15.0;
    expect(calculateTextCost(markLongContext(long, SOL), SOL)).toBeCloseTo(expected, 8);
    // Unmarked, the same counts bill at the base rates.
    expect(calculateTextCost(long, SOL)).toBeCloseTo(0.1 * 2.0 + 0.2 * 0.2 + 0.001 * 10.0, 8);
  });

  it("moves a bucket without its own long-context price with the input price (GPT-5.4 cached input)", () => {
    expect(GPT_54.cachedInputOver272kPerMillion).toBeUndefined();
    const ratio = GPT_54.inputOver272kPerMillion! / GPT_54.inputPerMillion!;
    const expected =
      0.1 * GPT_54.inputOver272kPerMillion! +
      0.2 * GPT_54.cachedInputPerMillion! * ratio +
      0.001 * GPT_54.outputOver272kPerMillion!;
    expect(calculateTextCost(markLongContext(long, GPT_54), GPT_54)).toBeCloseTo(expected, 8);
  });

  it("bills a turn's long and short requests each at their own rates", () => {
    const turn = createUsageAccumulator();
    mergeUsage(turn, markLongContext(long, SOL));
    mergeUsage(turn, markLongContext(short, SOL));
    mergeUsage(turn, markLongContext(short, SOL));
    const expected =
      (0.1 * 4.0 + 0.2 * 0.4 + 0.001 * 15.0) + 2 * (0.05 * 2.0 + 0.1 * 0.2 + 0.001 * 10.0);
    expect(calculateTextCost(turn, SOL)).toBeCloseTo(expected, 8);
  });

  it("never bills short requests as long, however many a turn has", () => {
    const turn = createUsageAccumulator();
    for (let index = 0; index < 4; index++) mergeUsage(turn, markLongContext(short, SOL));
    expect((turn as TokenUsage).longContext).toBeUndefined();
    expect(calculateTextCost(turn, SOL)).toBeCloseTo(4 * (0.05 * 2.0 + 0.1 * 0.2 + 0.001 * 10.0), 8);
  });
});

describe("the OpenAI adapter marks each response", () => {
  it("a 300K-token GPT-6 response streams usage marked long-context", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_long" } },
      { type: "response.output_text.delta", delta: "ok" },
      {
        type: "response.completed",
        response: {
          id: "resp_long",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: {
            input_tokens: 300_000,
            input_tokens_details: { cached_tokens: 200_000 },
            output_tokens: 1_000,
          },
        },
      },
    ];
    createMock.mockImplementation(() => ({
      withResponse: async () => ({
        data: (async function* () {
          for (const event of events) yield event;
        })(),
        response: { headers: new Headers() },
      }),
    }));
    const usages: TokenUsage[] = [];
    for await (const chunk of openaiProvider.generateTextStream!([{ role: "user", content: "hi" }], "gpt-6-sol", {})) {
      if ((chunk as { type?: string }).type === "usage") usages.push((chunk as { usage: TokenUsage }).usage);
    }
    expect(usages.at(-1)?.longContext).toEqual({
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 0,
    });
  });
});
