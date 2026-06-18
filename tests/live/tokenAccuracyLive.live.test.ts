/**
 * tokenAccuracyLive.test.js
 *
 * Comprehensive provider-level token accuracy test suite.
 * Verifies that:
 *   1. generation_progress events report real token counts from the provider
 *   2. Token counts are monotonically non-decreasing (never bounce)
 *   3. Final generation_progress.outputTokens matches the done event's usage.outputTokens
 *   4. chunk/thinking events carry outputCharacters (real) instead of fake outputTokens
 *   5. Worker tokens are aggregated into the coordinator's totals
 *
 * Provider: LM Studio (any loaded model, prefers Qwen3.6 35B A3B UD)
 * Endpoint: /agent
 *
 * Run:  npx vitest run tests/live/tokenAccuracyLive.test.js --config vitest.live.config.js
 */
import { describe, it, expect, beforeAll } from "vitest";

const PRISM_SERVICE_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

const TARGET_MODEL_PATTERNS = [
  /qwen.*3\.6.*35b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.[56].*35b/i,
  /qwen.*3.*30b.*a3b/i,
];

let targetModel = null;

async function findTargetModel() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
  if (!res.ok) throw new Error("LM Studio not responding");
  const data = await res.json();
  const models = data.models || data.data || [];
  for (const pattern of TARGET_MODEL_PATTERNS) {
    const match = models.find((m) => pattern.test(m.key || m.id));
    if (match) return match.key || match.id;
  }
  const loaded = models.find(
    (m) => m.loaded_instances?.length > 0 && m.type !== "embedding",
  );
  if (loaded) return loaded.key || loaded.id;
  const first = models.find((m) => m.type !== "embedding");
  return first ? first.key || first.id : null;
}

// ═══════════════════════════════════════════════════════════════
// SSE Stream Consumer
// ═══════════════════════════════════════════════════════════════

/**
 * Stream an /agent request and collect all relevant SSE events.
 * Returns structured results for assertions.
 */
async function streamAndCollect(prompt, { maxTokens = 500, timeout = 120000, canSpawnWorkers = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "token-accuracy-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify({
      provider: "lm-studio",
      model: targetModel,
      messages: [{ role: "user", content: prompt }],
      agent: "CODING",
      agentSessionId: crypto.randomUUID(),
      maxTokens,
      autoApprove: true,
      canSpawnWorkers,
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`/agent returned ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = {
    // All generation_progress events (main-level)
    progressEvents: [],
    // 1-second interval samples
    samples: [],
    // Per-subagent generation_progress events
    subAgentProgressEvents: {},
    // usage_update (per-iteration)
    usageUpdates: [],
    // done event usage
    doneUsage: null,
    // sub-agent completion events
    subAgentCompletions: [],
    // raw event count
    totalEvents: 0,
    // ── Real data from chunk/thinking events ──────────────────
    lastChunkOutputChars: 0,        // last outputCharacters from a chunk event
    lastThinkingOutputChars: 0,     // last outputCharacters from a thinking event
    chunkCount: 0,                  // total chunk events
    thinkingChunkCount: 0,          // total thinking events
    // Verify NO fake outputTokens on chunks
    chunkHadOutputTokens: false,    // true if any chunk had outputTokens field
  };

  let lastSampleTime = performance.now();

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

        // Main-level generation_progress
        if (event.type === "status" && event.message === "generation_progress") {
          const snap = {
            timestamp: performance.now(),
            outputTokens: event.outputTokens,
            inputTokens: event.inputTokens,
            totalTokens: event.totalTokens,
            outputCharacters: event.outputCharacters,
            tokPerSec: event.tokPerSec,
            activeRequests: event.activeRequests,
            avgTtft: event.avgTtft,
          };
          result.progressEvents.push(snap);
          if (performance.now() - lastSampleTime >= 1000) {
            result.samples.push(snap);
            lastSampleTime = performance.now();
          }
        }

        // Per-subagent progress
        if (event.type === "sub_agent_status" && event.message === "generation_progress") {
          if (!result.subAgentProgressEvents[event.subAgentId]) {
            result.subAgentProgressEvents[event.subAgentId] = [];
          }
          result.subAgentProgressEvents[event.subAgentId].push({
            outputTokens: event.outputTokens,
            totalOutputTokens: event.totalOutputTokens || event.outputTokens,
            tokPerSec: event.tokPerSec,
          });
        }

        // Sub-agent completions
        if (event.type === "sub_agent_status" && event.message === "complete") {
          result.subAgentCompletions.push(event);
        }

        // usage_update
        if (event.type === "usage_update" && event.usage) {
          result.usageUpdates.push(event.usage);
        }

        // done
        if (event.type === "done" && event.usage) {
          result.doneUsage = event.usage;
        }

        // ── Track per-chunk REAL data (outputCharacters) ─────────
        if (event.type === "chunk") {
          if (event.outputCharacters != null) {
            result.lastChunkOutputChars = event.outputCharacters;
          }
          if (event.outputTokens != null) {
            result.chunkHadOutputTokens = true;
          }
          result.chunkCount++;
        }
        if (event.type === "thinking") {
          if (event.outputCharacters != null) {
            result.lastThinkingOutputChars = event.outputCharacters;
          }
          if (event.outputTokens != null) {
            result.chunkHadOutputTokens = true;
          }
          result.thinkingChunkCount++;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  // Always include last event as a sample
  if (result.progressEvents.length > 0) {
    const last = result.progressEvents[result.progressEvents.length - 1];
    if (!result.samples.length || result.samples[result.samples.length - 1] !== last) {
      result.samples.push(last);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Assertion Helpers
// ═══════════════════════════════════════════════════════════════

/** Check that token fields are monotonically non-decreasing. */
function checkMonotonicity(events) {
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
function printSampleTable(label, result) {
  const events = result.progressEvents;
  const first = events[0];
  const last = events[events.length - 1];
  const providerOut = result.doneUsage?.outputTokens || 0;
  const providerIn = result.doneUsage?.inputTokens || result.doneUsage?.promptTokens || 0;
  const subAgentIds = Object.keys(result.subAgentProgressEvents);
  const lastOutputChars = Math.max(result.lastChunkOutputChars, result.lastThinkingOutputChars);

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 53 - label.length))}┐`);
  console.log(`  │ Progress events: ${String(events.length).padStart(5)}   Sub-agents: ${String(subAgentIds.length).padStart(2)}              │`);
  console.log("  ├──────────────────────────────────────────────────────┤");
  for (const s of result.samples) {
    const t = ((s.timestamp - first.timestamp) / 1000).toFixed(1);
    console.log(`  │ t=${t.padStart(5)}s  out=${String(s.outputTokens).padStart(5)}  in=${String(s.inputTokens).padStart(6)}  chars=${String(s.outputCharacters || 0).padStart(6)} │`);
  }
  console.log("  ├──────────────────────────────────────────────────────┤");
  console.log(`  │ Provider out:  ${String(providerOut).padStart(5)}   Progress out: ${String(last.outputTokens).padStart(5)}        │`);
  console.log(`  │ Provider in:   ${String(providerIn).padStart(5)}   Progress in:  ${String(last.inputTokens).padStart(5)}        │`);
  console.log(`  │ Output chars:  ${String(lastOutputChars).padStart(5)}   Chunks: ${String(result.chunkCount).padStart(4)} text, ${String(result.thinkingChunkCount).padStart(4)} think │`);
  console.log(`  │ Fake tokens on chunks: ${result.chunkHadOutputTokens ? "YES ⚠️" : "NO ✅"}                       │`);
  if (providerOut > 0) {
    const progressRatio = last.outputTokens / providerOut;
    console.log(`  │ Progress/Provider ratio: ${progressRatio.toFixed(4)}                       │`);
  }
  if (subAgentIds.length > 0) {
    for (const subAgentId of subAgentIds) {
      const progressList = result.subAgentProgressEvents[subAgentId];
      const lastProgress = progressList[progressList.length - 1];
      console.log(`  │ Sub-agent ${subAgentId.slice(0, 8)}: ${String(progressList.length).padStart(3)} events, ${String(lastProgress?.totalOutputTokens || 0).padStart(5)} tokens │`);
    }
  }
  console.log("  └──────────────────────────────────────────────────────┘\n");
}


// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

beforeAll(async () => {
  try { await fetch(PRISM_SERVICE_URL); } catch {
    throw new Error(`Prism not running at ${PRISM_SERVICE_URL}`);
  }
  try { await fetch(LM_STUDIO_URL); } catch {
    throw new Error(`LM Studio not running at ${LM_STUDIO_URL}`);
  }
  targetModel = await findTargetModel();
  if (!targetModel) throw new Error("No suitable model found in LM Studio");

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  Token Accuracy — Real Data Only                     ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  Provider: LM Studio                                 ║`);
  console.log(`  ║  Model:    ${targetModel.padEnd(44).slice(0, 44)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15000);


describe("LM Studio — Token Accuracy (Real Data Only)", () => {

  // ── Test 1: No fake token data on chunk events ──────────────
  // chunk/thinking events must carry outputCharacters (real),
  // NOT outputTokens (was fake SSE event count).
  it("chunk events carry outputCharacters, NOT outputTokens", async () => {
    const result = await streamAndCollect(
      "Explain what a binary search tree is in 2-3 sentences.",
    );

    printSampleTable("No Fake Token Data", result);

    // Must have received chunks
    expect(result.chunkCount + result.thinkingChunkCount).toBeGreaterThan(0);

    // No fake outputTokens on any chunk event
    expect(result.chunkHadOutputTokens).toBe(false);

    // outputCharacters must be present and growing
    const lastChars = Math.max(result.lastChunkOutputChars, result.lastThinkingOutputChars);
    expect(lastChars).toBeGreaterThan(0);
  }, 65000);

  // ── Test 2: generation_progress carries real provider tokens ─
  // After stream end, generation_progress.outputTokens must match
  // the provider's authoritative usage exactly (ratio 1.0).
  it("generation_progress.outputTokens matches provider usage exactly", async () => {
    const result = await streamAndCollect(
      "Write a short paragraph about the history of the internet.",
      { maxTokens: 800 },
    );

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];
    const providerOut = result.doneUsage?.outputTokens || 0;

    printSampleTable("Provider Parity", result);

    // Provider must have reported usage
    expect(providerOut).toBeGreaterThan(0);

    // The last generation_progress.outputTokens must match the provider exactly
    // (both come from the same source: provider-reported usage fed to the tracker)
    expect(last.outputTokens).toBe(providerOut);
  }, 65000);

  // ── Test 3: generation_progress includes outputCharacters ───
  // The generation_progress event must carry real outputCharacters
  // that grows during streaming (this is the ONLY real-time metric).
  it("generation_progress carries growing outputCharacters", async () => {
    const result = await streamAndCollect(
      "List 5 famous inventors and their inventions.",
    );

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const first = result.progressEvents[0];
    const last = result.progressEvents[result.progressEvents.length - 1];

    printSampleTable("Output Characters Growth", result);

    // outputCharacters must be present and growing
    expect(last.outputCharacters).toBeGreaterThan(0);
    if (result.progressEvents.length > 2) {
      expect(last.outputCharacters).toBeGreaterThan(first.outputCharacters || 0);
    }
  }, 65000);

  // ── Test 4: Monotonicity across iterations ──────────────────
  // Token counts must never decrease between generation_progress events,
  // even across multi-iteration tool-calling boundaries.
  it("generation_progress tokens are monotonically non-decreasing", async () => {
    const result = await streamAndCollect(
      "What is 2+2? Use a tool to verify if available, otherwise just answer.",
    );

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const violations = checkMonotonicity(result.progressEvents);
    const last = result.progressEvents[result.progressEvents.length - 1];

    printSampleTable("Monotonicity", result);

    expect(violations).toEqual([]);
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.inputTokens).toBeGreaterThan(0);
    expect(last.totalTokens).toBeGreaterThan(0);
  }, 65000);

  // ── Test 5: Coordinator + workers aggregate tokens ──────────
  // When workers stream, the main generation_progress events must
  // include worker tokens in the aggregate totals.
  it("coordinator+workers: worker tokens appear in aggregate generation_progress", async () => {
    const result = await streamAndCollect(
      "Create a team of 2 workers: one to write a haiku about the moon, " +
      "and another to write a haiku about the sun. Each worker should just respond with their haiku.",
      { maxTokens: 500, timeout: 120000, canSpawnWorkers: true },
    );

    const subAgentIds = Object.keys(result.subAgentProgressEvents);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const violations = checkMonotonicity(result.progressEvents);
    const last = result.progressEvents[result.progressEvents.length - 1];

    printSampleTable("Coordinator + Workers", result);

    expect(violations).toEqual([]);
    expect(last.outputTokens).toBeGreaterThan(0);

    if (subAgentIds.length > 0) {
      for (const subAgentId of subAgentIds) {
        expect(result.subAgentProgressEvents[subAgentId].length).toBeGreaterThan(0);
      }
      const totalWorkerTokens = subAgentIds.reduce((sum, subAgentId) => {
        const progressList = result.subAgentProgressEvents[subAgentId];
        const lastProgress = progressList[progressList.length - 1];
        return sum + (lastProgress?.totalOutputTokens || 0);
      }, 0);

      console.log(`  📊 Aggregate: ${last.outputTokens}, Sub-agents sum: ${totalWorkerTokens}`);
      expect(last.outputTokens).toBeGreaterThanOrEqual(totalWorkerTokens);
    } else {
      console.log("  ⚠ No workers spawned — model did not call create_team");
    }
  }, 125000);
});
