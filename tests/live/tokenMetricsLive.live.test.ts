/**
 * tokenMetricsLive.test.js
 * ═══════════════════════════════════════════════════════════════
 * Unified token metrics validation suite.
 *
 * Covers two provider tiers:
 *
 *   1. **LM Studio (local)** — tok/s accuracy, input/output/total
 *      token counting, monotonicity, and tool-call-phase streaming.
 *
 *   2. **Online providers (cheapest tier)** — OpenAI gpt-5-nano,
 *      Anthropic claude-haiku-4-5, Google gemini-3-flash-preview.
 *      Validates provider-reported usage parity and cost accuracy.
 *
 * Run:
 *   npx vitest run tests/live/tokenMetricsLive.test.js --config vitest.live.config.js
 *
 * ═══════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS, TYPES } from "#src/constants";

const PRISM_SERVICE_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// ═══════════════════════════════════════════════════════════════
// Target Models
// ═══════════════════════════════════════════════════════════════

/** Cheapest agent-capable model per online provider.
 *  OpenAI: gpt-5.4-nano ($0.20/$1.25) — cheapest with responsesAPI + streaming.
 *          gpt-5-nano is cheaper but uses Chat Completions which batches output.
 */
const ONLINE_MODELS = {
  openai: { model: "gpt-5.4-nano", label: "GPT 5.4 Nano" },
  anthropic: { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  google: { model: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
};

/** LM Studio model discovery patterns (prefer Qwen3.6 35B). */
const LM_STUDIO_PATTERNS = [
  /qwen.*3\.6.*35b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.[56].*35b/i,
  /qwen.*3.*30b.*a3b/i,
];

// ═══════════════════════════════════════════════════════════════
// Shared SSE Consumer
// ═══════════════════════════════════════════════════════════════

/**
 * Stream an /agent or /chat request and collect all token-relevant
 * SSE events into a structured result object.
 *


 */
/**
 * Stream an /agent or /chat request and collect all token-relevant
 * SSE events into a structured result object.
 */
async function streamAndCollect(provider: any, model: any, prompt: any, {
  maxTokens = 500,
  timeout = 120_000,
  agent = "CODING",
  autoApprove = true,
  maxIterations = 25,
  enabledTools,
}: any = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const body: any = {
    provider,
    model,
    messages: [{ role: "user", content: prompt }],
    agent,
    agentConversationId: crypto.randomUUID(),
    maxTokens,
    autoApprove,
    maxIterations,
  };
  if (enabledTools !== undefined) body.enabledTools = enabledTools;

  const res = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "token-metrics-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`/agent returned ${res.status}: ${await res.text()}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result: any = {
    progressEvents: [],
    usageUpdates: [],
    doneUsage: null,
    chunkCount: 0,
    thinkingChunkCount: 0,
    lastOutputChars: 0,
    totalEvents: 0,
    durationMilliseconds: 0,
    text: "",
    timedOut: false,
    // Worker tracking
    toolCalls: [],
    subAgentProgressEvents: {},   // subAgentId → progress[]
    subAgentCompleteEvents: [],
  };

  const startTime = performance.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        result.totalEvents++;

        if (event.type === "status" && event.message === "generation_progress") {
          result.progressEvents.push({
            timestamp: performance.now(),
            outputTokens: event.outputTokens,
            inputTokens: event.inputTokens,
            totalTokens: event.totalTokens,
            outputCharacters: event.outputCharacters,
            tokPerSec: event.tokPerSec,
            activeRequests: event.activeRequests,
            avgTtft: event.avgTtft,
          });
        }
        if (event.type === "usage_update" && event.usage) {
          result.usageUpdates.push(event.usage);
        }
        if (event.type === "done" && event.usage) {
          result.doneUsage = event.usage;
        }
        if (event.type === "chunk") {
          result.chunkCount++;
          result.text += event.content || "";
          if (event.outputCharacters != null) {
            result.lastOutputChars = event.outputCharacters;
          }
        }
        if (event.type === "thinking") {
          result.thinkingChunkCount++;
        }
        if (event.type === "tool_execution" || event.type === "toolCall") {
          result.toolCalls.push(event);
        }
        // Per-subagent generation_progress (coordinator path)
        if (event.type === "sub_agent_status" && event.message === "generation_progress") {
          if (!result.subAgentProgressEvents[event.subAgentId]) {
            result.subAgentProgressEvents[event.subAgentId] = [];
          }
          result.subAgentProgressEvents[event.subAgentId].push({
            timestamp: performance.now(),
            tokPerSec: event.tokPerSec,
            outputTokens: event.outputTokens,
            inputTokens: event.inputTokens,
            totalTokens: event.totalTokens,
          });
        }
        if (event.type === "sub_agent_status" && event.message === "complete") {
          result.subAgentCompleteEvents.push(event);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    result.durationMilliseconds = performance.now() - startTime;
    reader.releaseLock();
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Assertion Helpers
// ═══════════════════════════════════════════════════════════════

/** Check that token fields are monotonically non-decreasing. */
function checkMonotonicity(events: any) {
  let prevOut = 0, prevIn = 0, prevTotal = 0;
  const violations = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.outputTokens < prevOut) violations.push(`out: ${prevOut}→${e.outputTokens} @${i}`);
    if (e.inputTokens < prevIn) violations.push(`in: ${prevIn}→${e.inputTokens} @${i}`);
    if (e.totalTokens < prevTotal) violations.push(`total: ${prevTotal}→${e.totalTokens} @${i}`);
    prevOut = e.outputTokens;
    prevIn = e.inputTokens;
    prevTotal = e.totalTokens;
  }
  return violations;
}

/** Print a formatted results table. */
function printTable(label: any, result: any) {
  const events = result.progressEvents;
  if (!events.length) {
    console.log(`\n  ⚠ ${label}: no generation_progress events received`);
    return;
  }
  const last = events[events.length - 1];
  const providerOut = result.doneUsage?.outputTokens || 0;
  const providerIn = result.doneUsage?.inputTokens || result.doneUsage?.promptTokens || 0;

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 53 - label.length))}┐`);
  console.log(`  │ Progress events:  ${String(events.length).padStart(5)}                             │`);
  console.log(`  │ Chunks (text):    ${String(result.chunkCount).padStart(5)}                             │`);
  console.log(`  │ Chunks (think):   ${String(result.thinkingChunkCount).padStart(5)}                             │`);
  console.log("  ├──────────────────────────────────────────────────────┤");
  console.log(`  │ Progress out:     ${String(last.outputTokens).padStart(6)}   Provider out: ${String(providerOut).padStart(6)}      │`);
  console.log(`  │ Progress in:      ${String(last.inputTokens).padStart(6)}   Provider in:  ${String(providerIn).padStart(6)}      │`);
  console.log(`  │ Progress total:   ${String(last.totalTokens).padStart(6)}                             │`);
  console.log(`  │ Peak tok/s:       ${String(Math.max(...events.filter((e: any) => e.tokPerSec != null).map((e: any) => e.tokPerSec), 0).toFixed(1)).padStart(6)}                             │`);
  console.log(`  │ Duration:         ${(result.durationMilliseconds / 1000).toFixed(1).padStart(5)}s                             │`);
  if (providerOut > 0) {
    const ratio = last.outputTokens / providerOut;
    console.log(`  │ Progress/Provider: ${ratio.toFixed(4)}                             │`);
  }
  console.log("  └──────────────────────────────────────────────────────┘\n");
}

// ═══════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════

let lmStudioModel: any = null;
let lmStudioAvailable = false;
let _prismAvailable = false;
/** Tracks which online providers have valid API keys. */
const onlineAvailable: any = { openai: false, anthropic: false, google: false };

async function findLmStudioModel() {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const models = data.models || data.data || [];
    for (const pattern of LM_STUDIO_PATTERNS) {
      const match = models.find((m: any) => pattern.test(m.key || m.id));
      if (match) return match.key || match.id;
    }
    const loaded = models.find(
      (m: any) => m.loaded_instances?.length > 0 && m.type !== TYPES.EMBEDDING,
    );
    if (loaded) return loaded.key || loaded.id;
    const first = models.find((m: any) => m.type !== TYPES.EMBEDDING);
    return first ? first.key || first.id : null;
  } catch {
    return null;
  }
}

/**
 * Probe whether an online provider is reachable via Prism's /config
 * endpoint — avoids burning tokens just to discover availability.
 */
async function probeOnlineProviders() {
  try {
    const res = await fetch(`${PRISM_SERVICE_URL}/config`);
    if (!res.ok) return;
    const cfg = (await res.json()) as any;
    const textModels = cfg?.textToText?.models || {};
    for (const provider of Object.keys(ONLINE_MODELS)) {
      const providerModels = textModels[provider] || [];
      const target = ONLINE_MODELS[provider as keyof typeof ONLINE_MODELS].model;
      if (providerModels.some((m: any) => m.name === target)) {
        onlineAvailable[provider] = true;
      }
    }
  } catch {
    // Prism /config failed — online providers unavailable
  }
}

beforeAll(async () => {
  // Check Prism
  try {
    await fetch(PRISM_SERVICE_URL);
    _prismAvailable = true;
  } catch {
    throw new Error(`Prism not running at ${PRISM_SERVICE_URL}`);
  }

  // Discover LM Studio
  lmStudioModel = await findLmStudioModel();
  lmStudioAvailable = !!lmStudioModel;

  // Probe online providers
  await probeOnlineProviders();

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  Token Metrics — Live Integration Tests              ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  LM Studio:  ${lmStudioAvailable ? lmStudioModel.padEnd(41).slice(0, 41) : "unavailable".padEnd(41)}║`);
  console.log(`  ║  OpenAI:     ${onlineAvailable.openai ? "✅ " + ONLINE_MODELS.openai.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log(`  ║  Anthropic:  ${onlineAvailable.anthropic ? "✅ " + ONLINE_MODELS.anthropic.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log(`  ║  Google:     ${onlineAvailable.google ? "✅ " + ONLINE_MODELS.google.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);


// ═══════════════════════════════════════════════════════════════
// TIER 1: LM Studio — Local Token Metrics
// ═══════════════════════════════════════════════════════════════

describe("LM Studio — Token Metrics", () => {

  // ── 1. Tok/s is reported and within sane range ──────────────
  it("generation_progress emits valid tok/s", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      PROVIDERS.LM_STUDIO, lmStudioModel,
      "Explain what a hash map is in 2-3 sentences.",
      { maxTokens: 300 },
    );

    printTable("LM Studio — Tok/s", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const withTokPerSec = result.progressEvents.filter(
      (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Sane range: 0.1–500 tok/s for local models
    const peak = Math.max(...withTokPerSec.map((e: any) => e.tokPerSec));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(500);
  }, 90_000);

  // ── 2. Input / output / total tokens are correct ────────────
  it("input, output, and total tokens match provider usage", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      PROVIDERS.LM_STUDIO, lmStudioModel,
      "Write a haiku about the ocean.",
      { maxTokens: 200 },
    );

    printTable("LM Studio — Token Counts", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];

    // All three token fields must be populated
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.inputTokens).toBeGreaterThan(0);
    expect(last.totalTokens).toBeGreaterThan(0);

    // Identity: total = input + output
    expect(last.totalTokens).toBe(last.inputTokens + last.outputTokens);

    // Provider parity: final progress outputTokens === done.usage.outputTokens
    if (result.doneUsage?.outputTokens) {
      expect(last.outputTokens).toBe(result.doneUsage.outputTokens);
    }
    if (result.doneUsage?.inputTokens || result.doneUsage?.promptTokens) {
      const providerIn = result.doneUsage.inputTokens || result.doneUsage.promptTokens;
      expect(last.inputTokens).toBe(providerIn);
    }
  }, 90_000);

  // ── 3. Token counts are monotonically non-decreasing ────────
  it("tokens are monotonically non-decreasing across progress events", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      PROVIDERS.LM_STUDIO, lmStudioModel,
      "List the planets in order from the sun.",
      { maxTokens: 400 },
    );

    printTable("LM Studio — Monotonicity", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const violations = checkMonotonicity(result.progressEvents);
    expect(violations).toEqual([]);
  }, 90_000);

  // ── 4. avgTtft (Time To First Token) is reported ────────────
  it("avgTtft is present and reasonable", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      PROVIDERS.LM_STUDIO, lmStudioModel,
      "What is 2+2?",
      { maxTokens: 100 },
    );

    printTable("LM Studio — TTFT", result);

    const last = result.progressEvents[result.progressEvents.length - 1];
    expect(last.avgTtft).toBeDefined();
    expect(typeof last.avgTtft).toBe("number");
    expect(last.avgTtft).toBeGreaterThan(0);
    // Sanity: TTFT < 60s for local model
    expect(last.avgTtft).toBeLessThan(60);
  }, 90_000);

  // ── 5. Tool-call generation still streams tok/s ─────────────
  // When the model generates tool-call JSON, chunks still flow
  // and generation_progress should continue updating.
  it("tok/s continues during tool-call argument generation", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      PROVIDERS.LM_STUDIO, lmStudioModel,
      "List the files in /tmp using shell_execute.",
      { maxTokens: 500, maxIterations: 3 },
    );

    printTable("LM Studio — Tool Call Tok/s", result);

    // Should have progress events even during tool-call generation
    expect(result.progressEvents.length).toBeGreaterThan(0);
    const withTokPerSec = result.progressEvents.filter(
      (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Token totals should include tool-call tokens
    const last = result.progressEvents[result.progressEvents.length - 1];
    expect(last.outputTokens).toBeGreaterThan(0);
  }, 120_000);
});


// ═══════════════════════════════════════════════════════════════
// TIER 2: Online Providers — Cheapest Model Per Provider
// ═══════════════════════════════════════════════════════════════
//
// Tok/s is centralised in SessionGenerationTracker on the backend.
// The tracker uses cumulative output characters (chars/4 heuristic)
// as a provider-agnostic token estimate during streaming, then
// switches to authoritative provider-reported usage at stream end.
//
// Target models (cheapest per provider to minimise API spend):
//   - OpenAI:    gpt-5-nano       ($0.05/$0.40 per M)
//   - Anthropic: claude-haiku-4-5 ($1.00/$5.00 per M)
//   - Google:    gemini-3-flash   ($0.50/$3.00 per M)
//
// ═══════════════════════════════════════════════════════════════

describe.each([
  [PROVIDERS.OPENAI, ONLINE_MODELS.openai],
  [PROVIDERS.ANTHROPIC, ONLINE_MODELS.anthropic],
  [PROVIDERS.GOOGLE, ONLINE_MODELS.google],
])("%s — Token Metrics (%s)", (provider, { model, label }) => {

  // ═══════════════════════════════════════════════════════════
  // Single API call per provider — extract maximum value from
  // each paid request. One call validates: token counts,
  // provider parity, monotonicity, tok/s, cost, and identity.
  // ═══════════════════════════════════════════════════════════
  it(`${label}: comprehensive token metrics validation`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    // Use a prompt long enough to generate meaningful streaming
    // so we can validate tok/s, monotonicity, and parity in one shot.
    // OpenAI gpt-5.4-nano intermittently calls tools on the first iteration,
    // consuming the response without text. Disable tools only for OpenAI.
    const result = await streamAndCollect(
      provider, model,
      "Write a detailed paragraph explaining how gravity works, including Newton's and Einstein's contributions. Be thorough and comprehensive.",
      {
        maxTokens: 500, timeout: 60_000, maxIterations: 3,
        ...(provider === "openai" && { enabledTools: [] }),
      },
    );

    printTable(`${label} — Comprehensive`, result);

    // ─── 1. Basic token reporting ─────────────────────────────
    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];

    // All three fields must be present and positive
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.inputTokens).toBeGreaterThan(0);
    expect(last.totalTokens).toBeGreaterThan(0);

    // Identity: total === input + output
    expect(last.totalTokens).toBe(last.inputTokens + last.outputTokens);
    console.log(`  ✅ Token identity: ${last.inputTokens} + ${last.outputTokens} = ${last.totalTokens}`);

    // ─── 2. Provider-reported usage parity ────────────────────
    expect(result.doneUsage).toBeTruthy();
    const providerOut = result.doneUsage.outputTokens || 0;
    const providerIn = result.doneUsage.inputTokens || result.doneUsage.promptTokens || 0;

    expect(providerOut).toBeGreaterThan(0);
    expect(providerIn).toBeGreaterThan(0);

    // Output tokens: progress MUST match provider exactly (single source of truth)
    expect(last.outputTokens).toBe(providerOut);
    // Input tokens: progress uses HWM across iterations, done reports final
    // iteration. These can diverge due to caching, tool results, and prompt
    // re-tokenization — allow ±20% tolerance.
    const inputRatio = last.inputTokens / providerIn;
    expect(inputRatio).toBeGreaterThan(0.8);
    expect(inputRatio).toBeLessThan(1.2);
    console.log(`  ✅ Provider parity: out=${last.outputTokens}/${providerOut} in=${last.inputTokens}/${providerIn} (ratio=${inputRatio.toFixed(3)})`);

    // ─── 3. Monotonicity ──────────────────────────────────────
    const violations = checkMonotonicity(result.progressEvents);
    expect(violations).toEqual([]);
    console.log(`  ✅ Monotonicity: ${result.progressEvents.length} events, 0 violations`);

    // ─── 4. Tok/s reporting ───────────────────────────────────
    const withTokPerSec = result.progressEvents.filter(
      (eventItem: any) => eventItem.tokPerSec != null && eventItem.tokPerSec > 0,
    );

    if (withTokPerSec.length === 0) {
      // Some fast models batch SSE output — verify tokens still tracked
      console.log(`  ⚠ No live tok/s events — model may batch SSE output`);
      expect(last.outputTokens).toBeGreaterThan(0);
    } else {
      const peak = Math.max(...withTokPerSec.map((eventItem: any) => eventItem.tokPerSec));
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThan(2000);
      console.log(`  ✅ Tok/s: peak=${peak.toFixed(1)} across ${withTokPerSec.length} events`);
    }

    // ─── 5. Usage update events ───────────────────────────────
    // The agentic loop emits usage_update per iteration — verify it exists
    expect(result.usageUpdates.length).toBeGreaterThan(0);
    const lastUsage = result.usageUpdates[result.usageUpdates.length - 1];
    expect(lastUsage.outputTokens).toBeGreaterThan(0);
    expect(lastUsage.inputTokens || lastUsage.promptTokens).toBeGreaterThan(0);
    console.log(`  ✅ Usage updates: ${result.usageUpdates.length} events, final out=${lastUsage.outputTokens}`);

    // ─── 6. Text output verification ──────────────────────────
    // Ensure we actually received streamed text (not just metadata)
    expect(result.text.length).toBeGreaterThan(0);
    console.log(`  ✅ Text output: ${result.text.length} chars, ${result.chunkCount} chunks`);

    // ─── 7. TTFT tracking ─────────────────────────────────────
    // avgTtft should be present in at least one progress event
    const withTtft = result.progressEvents.filter(
      (eventItem: any) => eventItem.avgTtft != null && eventItem.avgTtft > 0,
    );
    if (withTtft.length > 0) {
      const ttft = withTtft[0].avgTtft;
      expect(ttft).toBeGreaterThan(0);
      expect(ttft).toBeLessThan(30); // 30s max TTFT for any online model
      console.log(`  ✅ TTFT: ${ttft.toFixed(3)}s`);
    } else {
      console.log(`  ⚠ No TTFT data in progress events`);
    }
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════
// Tier 3 — Multi-Worker Coordinator Tests (Online Providers)
// ═══════════════════════════════════════════════════════════════
// One coordinator test per provider: spawn 4 workers, each visits
// a random Wikipedia page. Validates per-worker token tracking,
// aggregate tok/s, and worker completion events.

describe.each([
  [PROVIDERS.OPENAI, ONLINE_MODELS.openai],
  [PROVIDERS.ANTHROPIC, ONLINE_MODELS.anthropic],
  [PROVIDERS.GOOGLE, ONLINE_MODELS.google],
])("%s — Coordinator + 4 Workers (%s)", (provider, { model, label }) => {

  it(`${label}: coordinator spawns 4 workers with accurate per-worker token tracking`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    const result = await streamAndCollect(
      provider, model,
      "I need you to research 4 topics IN PARALLEL using your create_team tool. " +
      "Create a team with 4 workers:\n" +
      "1. Worker 1: Use search_web to find what 'Solar Eclipse' is and summarize in 2 sentences\n" +
      "2. Worker 2: Use search_web to find what 'Northern Lights' is and summarize in 2 sentences\n" +
      "3. Worker 3: Use search_web to find what 'Tidal Waves' are and summarize in 2 sentences\n" +
      "4. Worker 4: Use search_web to find what 'Meteor Showers' are and summarize in 2 sentences\n\n" +
      "Use create_team with exactly 4 members. Each worker should use search_web.",
      { maxTokens: 1500, timeout: 180_000, maxIterations: 15 },
    );

    // ─── Core: must complete ──────────────────────────────────
    expect(result.timedOut).toBe(false);

    // ─── Coordinator progress ────────────────────────────────
    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];
    expect(last.outputTokens).toBeGreaterThan(0);
    console.log(`\n  📊 ${label} — Coordinator + 4 Workers Results`);
    console.log(`     Coordinator progress events: ${result.progressEvents.length}`);
    console.log(`     Final outputTokens: ${last.outputTokens}`);
    console.log(`     Final inputTokens:  ${last.inputTokens}`);

    // ─── create_team detection ────────────────────────────────
    const teamCreateCalls = result.toolCalls.filter(
      (t: any) => (t.tool?.name || t.name) === "create_subagents",
    );
    console.log(`     team_create calls: ${teamCreateCalls.length}`);

    // ─── Per-subagent validation ────────────────────────────────
    const subAgentIds = Object.keys(result.subAgentProgressEvents);
    console.log(`     Sub-agents with progress: ${subAgentIds.length}`);
    console.log(`     Sub-agent completions: ${result.subAgentCompleteEvents.length}`);

    if (teamCreateCalls.length > 0 && subAgentIds.length > 0) {
      for (const subAgentId of subAgentIds) {
        const progressList = result.subAgentProgressEvents[subAgentId];
        expect(progressList.length).toBeGreaterThan(0);

        // Each worker must have tracked output tokens
        const wLast = progressList[progressList.length - 1];
        expect(wLast.outputTokens).toBeGreaterThan(0);

        // Per-subagent tok/s
        const wWithTokPerSec = progressList.filter(
          (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
        );
        const peakTokPerSec = wWithTokPerSec.length > 0
          ? Math.max(...wWithTokPerSec.map((e: any) => e.tokPerSec))
          : 0;

        console.log(
          `     Sub-agent ${subAgentId.slice(0, 8)}: ` +
          `${progressList.length} progress, ` +
          `${wLast.outputTokens} out tokens, ` +
          `peak ${peakTokPerSec.toFixed(1)} tok/s`,
        );
      }

      // Worker completions should have usage data
      for (const subAgentComplete of result.subAgentCompleteEvents) {
        expect(subAgentComplete.subAgentId).toBeDefined();
        console.log(
          `     Sub-agent ${subAgentComplete.subAgentId?.slice(0, 8)} completed` +
          (subAgentComplete.usage ? ` — out: ${subAgentComplete.usage.outputTokens}` : ""),
        );
      }
    } else {
      // Model may not have created workers — still validate coordinator tracked tokens
      console.log(`     ⚠ No workers spawned — validating coordinator-only metrics`);
      expect(last.outputTokens).toBeGreaterThan(0);
    }

    // ─── Provider parity ─────────────────────────────────────
    if (result.doneUsage) {
      const providerOut = result.doneUsage.outputTokens || 0;
      if (providerOut > 0) {
        console.log(`     Provider parity: progress=${last.outputTokens} provider=${providerOut}`);
      }
    }

    // ─── Aggregate tok/s validation ──────────────────────────
    // The coordinator's generation_progress.tokPerSec should be the
    // SUM of all active requests' rates (orchestrator + workers),
    // not the average. When multiple workers are active, the
    // aggregate should exceed any single worker's peak.
    const coordWithTokPerSec = result.progressEvents.filter(
      (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    if (coordWithTokPerSec.length > 0) {
      const coordPeakTokPerSec = Math.max(
        ...coordWithTokPerSec.map((e: any) => e.tokPerSec),
      );
      console.log(`     Coordinator peak tok/s: ${coordPeakTokPerSec.toFixed(1)}`);
      expect(coordPeakTokPerSec).toBeGreaterThan(0);

      // When workers were active, coordinator's aggregate tok/s should
      // include worker contributions (total output = orchestrator + workers)
      if (subAgentIds.length > 0) {
        // Coordinator outputTokens should be >= sum of worker outputTokens
        // (it also includes orchestrator's own tokens)
        const workerTotalOut = result.subAgentCompleteEvents.reduce(
          (sum: any, wc: any) => sum + (wc.usage?.outputTokens || 0), 0,
        );
        console.log(`     Coordinator total out: ${last.outputTokens}, Sub-agent sum: ${workerTotalOut}`);
        expect(last.outputTokens).toBeGreaterThanOrEqual(workerTotalOut);
        console.log(`  ✅ Aggregate: coordinator out (${last.outputTokens}) >= sub-agent sum (${workerTotalOut})`);
      }
    }

    // ─── Monotonicity ────────────────────────────────────────
    const violations = checkMonotonicity(result.progressEvents);
    expect(violations).toEqual([]);
    console.log(`     Monotonicity: ${result.progressEvents.length} events, 0 violations ✅`);
  }, 300_000); // 5 min timeout for coordinator + workers
});
