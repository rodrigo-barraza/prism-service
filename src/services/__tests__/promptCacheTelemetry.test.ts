/**
 * Prompt-cache telemetry units: payload hashing, prefix comparison, the
 * per-conversation "previous request" record, and the /stats/cache math.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  canonicalJson,
  hashChatPrefix,
  hashPromptPrefix,
} from "#src/utils/PromptPrefixHashes";
import PromptCacheTelemetry, {
  comparePrefixes,
  PREFIX_CHANGE,
} from "#src/services/PromptCacheTelemetry";
import { computeCacheStats, type CacheStatsRow } from "#src/services/PromptCacheStats";
import { hashAnthropicPrefix, normalizeAnthropicCacheDiagnostics } from "#src/providers/anthropic";
import {
  normalizeOpenAICacheDiagnostics,
  supportsPromptCacheDiagnostics,
} from "#src/providers/openai";
import { hashGooglePrefix } from "#src/providers/google";

const searchTool = { name: "search_web", description: "Search", input_schema: { type: "object" } };
const readTool = { name: "read_file", description: "Read", input_schema: { type: "object" } };

describe("PromptPrefixHashes", () => {
  it("canonical JSON ignores key order, undefined, and cache_control breakpoints", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
    expect(canonicalJson({ type: "text", text: "x", cache_control: { type: "ephemeral" } })).toBe(
      canonicalJson({ type: "text", text: "x" }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it("hashes system, tools and each message; toolSet ignores order, tools does not", () => {
    const first = hashPromptPrefix({ system: "sys", tools: [searchTool, readTool], messages: [{ role: "user", content: "hi" }] })!;
    const reordered = hashPromptPrefix({ system: "sys", tools: [readTool, searchTool], messages: [{ role: "user", content: "hi" }] })!;
    expect(first.system).toMatch(/^[0-9a-f]{64}$/);
    expect(first.messages).toHaveLength(1);
    expect(reordered.tools).not.toBe(first.tools);
    expect(reordered.toolSet).toBe(first.toolSet);
    expect(hashPromptPrefix({ system: "", tools: [], messages: [] })).toEqual({
      system: null,
      tools: null,
      toolSet: null,
      messages: [],
    });
  });

  it("never throws — a payload it cannot serialize yields null", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(hashPromptPrefix({ messages: [cyclic] })).toBeNull();
  });

  it("chat payloads split their leading system/developer messages off as `system`", () => {
    const hashes = hashChatPrefix(
      [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "user", content: "hi" },
        { role: "system", content: "mid-conversation" },
      ],
      null,
    )!;
    expect(hashes.system).not.toBeNull();
    expect(hashes.messages).toHaveLength(2);
    expect(hashChatPrefix([{ role: "user", content: "hi" }], null)!.system).toBeNull();
  });

  it("Anthropic: a string message hashes like the text block applyCacheBreakpoints makes of it", () => {
    const asString = hashAnthropicPrefix({ messages: [{ role: "user", content: "hi" }] })!;
    const asBlock = hashAnthropicPrefix({
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    })!;
    expect(asBlock.messages).toEqual(asString.messages);
  });

  it("Google: function declarations are flattened into one tool entry each", () => {
    const grouped = hashGooglePrefix([{ role: "user", parts: [{ text: "hi" }] }], {
      systemInstruction: "sys",
      tools: [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }],
    } as any)!;
    const swapped = hashGooglePrefix([{ role: "user", parts: [{ text: "hi" }] }], {
      systemInstruction: "sys",
      tools: [{ functionDeclarations: [{ name: "b" }, { name: "a" }] }],
    } as any)!;
    expect(swapped.tools).not.toBe(grouped.tools);
    expect(swapped.toolSet).toBe(grouped.toolSet);
  });
});

describe("comparePrefixes", () => {
  const base = hashPromptPrefix({ system: "sys", tools: [searchTool, readTool], messages: ["m0", "m1"] })!;

  it("append-only: diverges exactly at the previous message count", () => {
    const next = hashPromptPrefix({ system: "sys", tools: [searchTool, readTool], messages: ["m0", "m1", "m2", "m3"] })!;
    const comparison = comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: next });
    expect(comparison.firstDivergenceIndex).toBe(2);
    expect(comparison.prefixChange).toBe(PREFIX_CHANGE.APPEND_ONLY);
  });

  it("a rewritten message is found at its index", () => {
    const next = hashPromptPrefix({ system: "sys", tools: [searchTool, readTool], messages: ["m0", "stub", "m2"] })!;
    const comparison = comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: next });
    expect(comparison.firstDivergenceIndex).toBe(1);
    expect(comparison.prefixChange).toBe(PREFIX_CHANGE.MESSAGES_CHANGED);
  });

  it("a shorter history (compaction) is a rewrite even when it is a prefix", () => {
    const next = hashPromptPrefix({ system: "sys", tools: [searchTool, readTool], messages: ["m0"] })!;
    const comparison = comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: next });
    expect(comparison.firstDivergenceIndex).toBe(1);
    expect(comparison.prefixChange).toBe(PREFIX_CHANGE.MESSAGES_CHANGED);
  });

  it("attributes in render order: model, then tools (reorder vs change), then system", () => {
    const reordered = hashPromptPrefix({ system: "other", tools: [readTool, searchTool], messages: ["m0", "m1"] })!;
    expect(comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: reordered }).prefixChange).toBe(
      PREFIX_CHANGE.TOOLS_REORDERED,
    );
    const added = hashPromptPrefix({ system: "sys", tools: [searchTool], messages: ["m0", "m1"] })!;
    expect(comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: added }).prefixChange).toBe(
      PREFIX_CHANGE.TOOLS_CHANGED,
    );
    const system = hashPromptPrefix({ system: "changed", tools: [searchTool, readTool], messages: ["m0", "m1"] })!;
    expect(comparePrefixes({ model: "m", prefixHashes: base }, { model: "m", prefixHashes: system }).prefixChange).toBe(
      PREFIX_CHANGE.SYSTEM_CHANGED,
    );
    expect(comparePrefixes({ model: "a", prefixHashes: base }, { model: "b", prefixHashes: base }).prefixChange).toBe(
      PREFIX_CHANGE.MODEL_CHANGED,
    );
  });
});

describe("PromptCacheTelemetry.recordRequest", () => {
  beforeEach(() => PromptCacheTelemetry._clear());

  const telemetry = (messages: string[], providerResponseId?: string) => ({
    type: "requestTelemetry" as const,
    prefixHashes: hashPromptPrefix({ system: "s", tools: [searchTool], messages })!,
    ...(providerResponseId && { providerResponseId }),
  });

  it("chains requests of one conversation and hands back the previous response id per provider", () => {
    const first = PromptCacheTelemetry.recordRequest({
      conversationKey: "conv",
      requestId: "req-1",
      provider: "openai",
      model: "gpt-6-astra",
      telemetry: telemetry(["a"], "resp_1"),
    })!;
    expect(first.firstDivergenceIndex).toBeNull();
    expect(first.cacheTelemetry.prefixChange).toBe(PREFIX_CHANGE.NO_PREVIOUS_REQUEST);
    expect(PromptCacheTelemetry.previousResponseId("conv", "openai")).toBe("resp_1");
    expect(PromptCacheTelemetry.previousResponseId("conv", "anthropic")).toBeNull();
    expect(PromptCacheTelemetry.previousResponseId("other", "openai")).toBeNull();

    const second = PromptCacheTelemetry.recordRequest({
      conversationKey: "conv",
      requestId: "req-2",
      provider: "openai",
      model: "gpt-6-astra",
      telemetry: telemetry(["a", "b", "c"], "resp_2"),
    })!;
    expect(second.firstDivergenceIndex).toBe(1);
    expect(second.cacheTelemetry).toMatchObject({
      comparedRequestId: "req-1",
      previousMessageCount: 1,
      prefixChange: PREFIX_CHANGE.APPEND_ONLY,
      providerResponseId: "resp_2",
    });
  });

  it("records a declared boundary and Anthropic's input_transformations on the row", () => {
    PromptCacheTelemetry.recordRequest({
      conversationKey: "conv",
      requestId: "req-1",
      provider: "anthropic",
      model: "claude-opus-5-5",
      telemetry: telemetry(["a", "b"]),
    });
    const compacted = PromptCacheTelemetry.recordRequest({
      conversationKey: "conv",
      requestId: "req-2",
      provider: "anthropic",
      model: "claude-opus-5-5",
      telemetry: { ...telemetry(["a", "stub", "c"]), inputTransformations: [] },
      declaredBoundary: "micro_compaction",
    })!;
    expect(compacted.cacheTelemetry.prefixChange).toBe(PREFIX_CHANGE.MESSAGES_CHANGED);
    expect(compacted.cacheTelemetry.declaredBoundary).toBe("micro_compaction");
    expect(compacted.cacheTelemetry.inputTransformations).toEqual([]);
  });

  it("returns null (and records nothing) when the adapter reported no hashes", () => {
    expect(
      PromptCacheTelemetry.recordRequest({ conversationKey: "conv", requestId: "r", provider: "p", model: "m", telemetry: undefined }),
    ).toBeNull();
    expect(PromptCacheTelemetry.previousResponseId("conv", "p")).toBeNull();
  });
});

describe("provider diagnostics normalization", () => {
  it("OpenAI: GPT-5.6 and later only", () => {
    expect(supportsPromptCacheDiagnostics("gpt-5.6-luna")).toBe(true);
    expect(supportsPromptCacheDiagnostics("gpt-6-astra")).toBe(true);
    expect(supportsPromptCacheDiagnostics("gpt-5.5")).toBe(false);
    expect(supportsPromptCacheDiagnostics("o3")).toBe(false);
  });

  it("OpenAI: maps type/reason/missed tokens", () => {
    expect(
      normalizeOpenAICacheDiagnostics(
        { type: "cache_miss", reason: "tools_changed", comparison_reusable_tokens: 0, cache_missed_tokens: 5120 },
        "resp_1",
      ),
    ).toMatchObject({ source: "openai", status: "cache_miss", reason: "tools_changed", missedTokens: 5120, comparedResponseId: "resp_1" });
    expect(normalizeOpenAICacheDiagnostics({ type: "comparison_response_not_found" }, "r")?.status).toBe("comparison_not_found");
    expect(normalizeOpenAICacheDiagnostics(undefined, "r")).toBeNull();
  });

  it("Anthropic: a miss reason, a pending comparison, and nothing to compare", () => {
    expect(
      normalizeAnthropicCacheDiagnostics({ cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 900 } }, "msg_1"),
    ).toMatchObject({ source: "anthropic", status: "cache_miss", reason: "messages_changed", missedTokens: 900 });
    expect(normalizeAnthropicCacheDiagnostics({ cache_miss_reason: null }, "msg_1")?.status).toBe("pending");
    // A full hit comes back as `diagnostics: null` (live, claude-sonnet-5)
    expect(normalizeAnthropicCacheDiagnostics(null, "msg_1")).toMatchObject({ status: "no_miss", comparedResponseId: "msg_1" });
    expect(normalizeAnthropicCacheDiagnostics({ cache_miss_reason: { type: "previous_message_not_found" } }, "msg_1")?.status).toBe(
      "comparison_not_found",
    );
    expect(normalizeAnthropicCacheDiagnostics(null, null)).toBeNull();
    expect(normalizeAnthropicCacheDiagnostics(undefined, "msg_1")).toBeNull();
  });
});

describe("computeCacheStats", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 22, 12, 0, seconds)).toISOString();
  const row = (overrides: Partial<CacheStatsRow>): CacheStatsRow => ({
    agentConversationId: "c1",
    createdAt: at(0),
    provider: "google",
    model: "gemini-3.6-flash",
    agenticIteration: 1,
    inputTokens: 1000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedCost: 0.001,
    ...overrides,
  });

  it("cache-read share, zero-cache pairs, first requests and the miss histogram", () => {
    const rows = [
      row({ createdAt: at(0), cacheTelemetry: { prefixChange: "no_previous_request" } }),
      row({ createdAt: at(5), agenticIteration: 2, inputTokens: 1200, cacheReadInputTokens: 900, cacheTelemetry: { prefixChange: "append_only" } }),
      row({ createdAt: at(10), agenticIteration: 3, inputTokens: 1400, cacheReadInputTokens: 0, cacheTelemetry: { prefixChange: "append_only" } }),
      row({
        createdAt: at(15),
        agenticIteration: 4,
        inputTokens: 1600,
        cacheReadInputTokens: 0,
        cacheTelemetry: { prefixChange: "tools_changed", providerDiagnostics: { source: "openai", status: "cache_miss", reason: "tools_changed" } },
      }),
      // Beyond the gap: not a pair
      row({ createdAt: at(15 + 600), agenticIteration: 1, inputTokens: 1600, cacheReadInputTokens: 0 }),
      // Second conversation: its first request hit a cache
      row({ agentConversationId: "c2", createdAt: at(20), cacheReadInputTokens: 800 }),
      // A row older than the telemetry
      row({ agentConversationId: "c2", createdAt: at(25), agenticIteration: 2, cacheReadInputTokens: 0 }),
    ];
    const stats = computeCacheStats(rows, { maxGapSeconds: 300 });
    expect(stats.totals.requests).toBe(7);
    expect(stats.totals.conversations).toBe(2);
    expect(stats.totals.firstRequests).toBe(2);
    expect(stats.totals.firstRequestsWithCacheRead).toBe(1);
    expect(stats.totals.pairs).toBe(4);
    expect(stats.totals.pairsBeyondGap).toBe(1);
    expect(stats.totals.zeroCachePairs).toBe(3);
    expect(stats.totals.zeroCacheShare).toBe(0.75);
    expect(stats.totals.cacheReadShare).toBeCloseTo((900 + 800) / (1000 + 1200 + 1400 + 1600 + 1600 + 1000 + 1000), 4);
    expect(stats.totals.withinTurnCacheReadShare).toBeCloseTo(900 / (1200 + 1400 + 1600 + 1000), 4);
    expect(stats.totals.carry).toEqual({ zero: 3, underHalf: 0, underThreeQuarters: 0, atLeastThreeQuarters: 1 });
    expect(stats.totals.telemetryRows).toBe(4);
    expect(stats.missReasons).toEqual([
      { reason: "append_only", source: "prefix_hashes", count: 1, share: 0.3333 },
      { reason: "tools_changed", source: "provider", count: 1, share: 0.3333 },
      { reason: "no_telemetry", source: "none", count: 1, share: 0.3333 },
    ]);
    expect(stats.byModel).toHaveLength(1);
    expect(stats.byModel[0]).toMatchObject({ provider: "google", model: "gemini-3.6-flash", requests: 7, pairs: 4 });
  });

  it("a zero-cache pair at a declared boundary is attributed to the boundary, not a leak", () => {
    const stats = computeCacheStats([
      row({ createdAt: at(0) }),
      row({
        createdAt: at(5),
        agenticIteration: 2,
        cacheReadInputTokens: 0,
        cacheTelemetry: { prefixChange: "messages_changed", declaredBoundary: "micro_compaction" },
      }),
    ]);
    expect(stats.missReasons).toEqual([
      { reason: "micro_compaction", source: "declared", count: 1, share: 1 },
    ]);
  });

  it("an empty window reports zeros and null shares", () => {
    const stats = computeCacheStats([]);
    expect(stats.totals.requests).toBe(0);
    expect(stats.totals.cacheReadShare).toBeNull();
    expect(stats.missReasons).toEqual([]);
  });
});
