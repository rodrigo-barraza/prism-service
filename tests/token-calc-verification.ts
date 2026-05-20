#!/usr/bin/env node
// ─── Token Calculation Verification Test ────────────────────
// Sends real agentic requests to Prism → LM Studio (Qwen3.6 35B),
// captures all SSE events, and verifies:
// 1. Backend-reported outputTokens on chunk/thinking events
// 2. usage_update events between iterations
// 3. getSessionTokenStats with _intermediateUsage priority
// 4. Worker token accumulation
//
// Usage:
//   node tests/token-calc-verification.js

const PRISM_SERVICE_URL = "http://localhost:7777";
const PROJECT = "prism-client-dev"; // matches prism-client's PROJECT_NAME for local dev
const PROVIDER = "lm-studio";
const MODEL = "qwen3.6-35b-a3b";

// ── Import the functions we're testing ────────────────────────
// Mirror of prism-client/src/utils/utilities.js logic

function getTotalInputTokens(usage: any) {
  if (!usage) return 0;
  return (
    (usage.inputTokens || 0) +
    (usage.cacheReadInputTokens || 0) +
    (usage.cacheCreationInputTokens || 0)
  );
}

function getSessionTokenStats(messages: any[]) {
  let input = 0;
  let output = 0;
  let requests = 0;
  let liveStreamingTokens = 0;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    // Finalized (done event)
    if (m.usage) {
      requests += m.usage.requests || 1;
      input += getTotalInputTokens(m.usage);
      output += m.usage.outputTokens || 0;
    }
    // Intermediate authoritative usage (usage_update event)
    if (!m.usage && m._intermediateUsage) {
      requests += m._intermediateUsage.requests || 1;
      input += getTotalInputTokens(m._intermediateUsage);
      output += m._intermediateUsage.outputTokens || 0;
      liveStreamingTokens = m._intermediateUsage.outputTokens || 0;
    }
    // Per-chunk streaming estimate (backend outputTokens on each chunk)
    else if (!m.usage && m._streamingOutputTokens > 0) {
      output += m._streamingOutputTokens;
      liveStreamingTokens = m._streamingOutputTokens;
    }
    // Worker generation progress
    if (m._workerGenerationProgress) {
      for (const wp of Object.values(m._workerGenerationProgress) as any[]) {
        if (wp.outputTokens > 0) output += wp.outputTokens;
      }
    }
    // Completed worker tokens
    if (m._workerTokens) {
      input += m._workerTokens.input || 0;
      output += m._workerTokens.output || 0;
      requests += m._workerTokens.requests || 0;
    }
  }
  return {
    totalTokens: { input, output, total: input + output },
    requestCount: requests,
    liveStreamingTokens,
  };
}

// ── Helpers ──────────────────────────────────────────────────

const SEP = "═".repeat(70);
const THIN = "─".repeat(70);
let totalPassed = 0;
let totalFailed = 0;

function log(icon: string, msg: string) { console.log(`  ${icon}  ${msg}`); }
function logSection(title: string) { console.log(`\n${THIN}\n  ${title}\n${THIN}`); }
function passFail(label: string, actual: any, expected: any) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✅" : "❌"}  ${label}: ${actual} ${ok ? "==" : "!="} ${expected}${ok ? "" : " ← MISMATCH"}`);
  if (ok) totalPassed++; else totalFailed++;
  return ok;
}

// ── SSE Stream Consumer ─────────────────────────────────────

async function streamAgentRequest(prompt: string, options: any = {}) {
  const sessionId = options.sessionId || `token-test-${Date.now()}`;
  const payload = {
    provider: PROVIDER,
    model: MODEL,
    messages: [
      { role: "system", content: "" },
      { role: "user", content: prompt },
    ],
    functionCallingEnabled: true,
    enabledTools: options.enabledTools || ["read_file", "write_file", "list_dir", "run_command"],
    maxTokens: options.maxTokens || 2048,
    temperature: options.temperature ?? 0.7,
    thinkingEnabled: true,
    project: PROJECT,
    agentSessionId: sessionId,
    conversationMeta: { title: options.title || "Token Verification Test" },
    agent: options.agent || "CODING",
    autoApprove: true,
    planFirst: false,
    maxIterations: options.maxIterations || 5,
    ...(options.maxWorkerIterations != null && { maxWorkerIterations: options.maxWorkerIterations }),
  };

  const res = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-project": PROJECT },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const events = [];
  let chunkCount = 0;
  let thinkingChunkCount = 0;
  const toolExecutions = [];
  let doneEvent = null;
  const statusEvents = [];
  const usageUpdateEvents = [];
  const workerStatusEvents = [];
  const workerCompleteEvents = [];
  const workerProgressEvents = [];

  // Track outputTokens from each chunk/thinking SSE event
  let lastChunkOutputTokens = 0;
  let lastThinkingOutputTokens = 0;
  let maxOutputTokensFromChunks = 0;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6);
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        events.push(data);

        switch (data.type) {
          case "chunk":
            chunkCount++;
            if (data.outputTokens != null) {
              lastChunkOutputTokens = data.outputTokens;
              if (data.outputTokens > maxOutputTokensFromChunks) {
                maxOutputTokensFromChunks = data.outputTokens;
              }
            }
            break;
          case "thinking":
            thinkingChunkCount++;
            if (data.outputTokens != null) {
              lastThinkingOutputTokens = data.outputTokens;
              if (data.outputTokens > maxOutputTokensFromChunks) {
                maxOutputTokensFromChunks = data.outputTokens;
              }
            }
            break;
          case "tool_execution":
            toolExecutions.push(data);
            break;
          case "usage_update":
            usageUpdateEvents.push(data);
            break;
          case "worker_status":
            workerStatusEvents.push(data);
            if (data.message === "complete") workerCompleteEvents.push(data);
            if (data.message === "generation_progress") workerProgressEvents.push(data);
            break;
          case "error":
            console.error(`  ❌  SSE error: ${data.message || JSON.stringify(data)}`);
            break;
          case "status":
            statusEvents.push(data);
            break;
          case "done":
            doneEvent = data;
            break;
        }
      } catch { /* skip malformed */ }
    }
  }

  return {
    events, chunkCount, thinkingChunkCount, toolExecutions,
    doneEvent, statusEvents, usageUpdateEvents,
    workerStatusEvents, workerCompleteEvents, workerProgressEvents,
    lastChunkOutputTokens, lastThinkingOutputTokens, maxOutputTokensFromChunks,
    sessionId,
  };
}

// ── Test: Single-Agent Flow ─────────────────────────────────

async function testSingleAgentFlow() {
  logSection("PART A: SINGLE-AGENT AGENTIC FLOW");

  log("📤", `Prompt: "List the contents of the current directory, then summarize in one sentence."`);
  log("⏳", "Streaming SSE response...\n");

  const result = await streamAgentRequest(
    "List the contents of the current directory. Then tell me what files you see, in a short sentence.",
    { maxIterations: 3, title: "Single Agent Token Test" },
  );

  const { chunkCount, thinkingChunkCount, doneEvent, usageUpdateEvents, maxOutputTokensFromChunks } = result;

  logSection("A1. SSE Event Summary");
  log("📊", `Total SSE events: ${result.events.length}`);
  log("💬", `Text chunks: ${chunkCount}`);
  log("🧠", `Thinking chunks: ${thinkingChunkCount}`);
  log("🔧", `Tool executions: ${result.toolExecutions.length}`);
  log("📡", `Status events: ${result.statusEvents.length}`);
  log("📦", `usage_update events: ${usageUpdateEvents.length}`);
  log(doneEvent ? "✅" : "❌", `Done event: ${doneEvent ? "received" : "MISSING"}`);

  if (!doneEvent) { console.error("\n❌ No done event — aborting."); return; }

  const providerUsage = doneEvent.usage;

  logSection("A2. Provider-Reported Usage");
  log("📥", `inputTokens:   ${providerUsage.inputTokens}`);
  log("📤", `outputTokens:  ${providerUsage.outputTokens}`);
  log("🔄", `requests:      ${providerUsage.requests}`);
  log("⚡", `tokensPerSec:  ${doneEvent.tokensPerSec || "N/A"}`);

  // ── A3: Backend outputTokens on SSE events ──
  logSection("A3. Backend outputTokens on chunk/thinking SSE events");
  log("📊", `Max outputTokens from chunks: ${maxOutputTokensFromChunks}`);
  log("📊", `Total chunks (text + thinking): ${chunkCount + thinkingChunkCount}`);
  passFail("max outputTokens matches total chunk count", maxOutputTokensFromChunks, chunkCount + thinkingChunkCount);

  // ── A4: usage_update events ──
  logSection("A4. usage_update events between iterations");
  const iterCount = providerUsage.requests || 1;
  log("📊", `Expected usage_updates: ${iterCount} (one per iteration)`);
  log("📊", `Received usage_updates: ${usageUpdateEvents.length}`);
  passFail("usage_update count = iteration count", usageUpdateEvents.length, iterCount);

  // Each usage_update should have monotonically increasing token counts
  if (usageUpdateEvents.length >= 2) {
    let monotonic = true;
    for (let i = 1; i < usageUpdateEvents.length; i++) {
      if (usageUpdateEvents[i].usage.outputTokens < usageUpdateEvents[i - 1].usage.outputTokens) {
        monotonic = false;
        break;
      }
    }
    passFail("usage_update outputTokens are monotonically increasing", monotonic, true);
  }

  // Last usage_update should be ≤ done event (done may include exhaustion summary tokens)
  if (usageUpdateEvents.length > 0) {
    const lastUpdate = usageUpdateEvents[usageUpdateEvents.length - 1];
    const leInput = lastUpdate.usage.inputTokens <= providerUsage.inputTokens;
    const leOutput = lastUpdate.usage.outputTokens <= providerUsage.outputTokens;
    passFail("last usage_update.inputTokens ≤ done.inputTokens", leInput, true);
    passFail("last usage_update.outputTokens ≤ done.outputTokens", leOutput, true);
    log("📊", `  usage_update: in=${lastUpdate.usage.inputTokens}, out=${lastUpdate.usage.outputTokens}`);
    log("📊", `  done:         in=${providerUsage.inputTokens}, out=${providerUsage.outputTokens}`);
  }

  // ── A5: getTotalInputTokens ──
  logSection("A5. getTotalInputTokens()");
  passFail("provider usage", getTotalInputTokens(providerUsage),
    (providerUsage.inputTokens || 0) + (providerUsage.cacheReadInputTokens || 0) + (providerUsage.cacheCreationInputTokens || 0));
  passFail("null safety", getTotalInputTokens(null), 0);
  passFail("input + cache", getTotalInputTokens({ inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 25 }), 175);

  // ── A6: getSessionTokenStats — Finalized ──
  logSection("A6. getSessionTokenStats() — Finalized");
  const userMsg = { role: "user", content: "test" };
  const finalizedMsg = { role: "assistant", content: "text", usage: providerUsage };
  const stats = getSessionTokenStats([userMsg, finalizedMsg]);
  passFail("input tokens", stats.totalTokens.input, getTotalInputTokens(providerUsage));
  passFail("output tokens", stats.totalTokens.output, providerUsage.outputTokens || 0);
  passFail("liveStreamingTokens = 0 (finalized)", stats.liveStreamingTokens, 0);

  // ── A7: getSessionTokenStats — with _intermediateUsage ──
  logSection("A7. getSessionTokenStats() — _intermediateUsage (backend authoritative)");
  if (usageUpdateEvents.length > 0) {
    const lastUpdate = usageUpdateEvents[usageUpdateEvents.length - 1];
    const intermediateMsg = {
      role: "assistant", content: "",
      _intermediateUsage: lastUpdate.usage,
      _streamingOutputTokens: maxOutputTokensFromChunks,
    };
    const iStats = getSessionTokenStats([userMsg, intermediateMsg]);
    passFail("input = intermediateUsage input", iStats.totalTokens.input, getTotalInputTokens(lastUpdate.usage));
    passFail("output = intermediateUsage output (not chunk count)",
      iStats.totalTokens.output, lastUpdate.usage.outputTokens || 0);
    passFail("requests = intermediateUsage requests", iStats.requestCount, lastUpdate.usage.requests || 1);
    passFail("liveStreamingTokens = intermediateUsage output",
      iStats.liveStreamingTokens, lastUpdate.usage.outputTokens || 0);
  }

  // ── A8: Mutual exclusion ──
  logSection("A8. Mutual Exclusion (streaming → finalized)");
  const transitionMsg = { role: "assistant", content: "", usage: providerUsage, _intermediateUsage: { inputTokens: 9999, outputTokens: 9999 }, _streamingOutputTokens: 9999 };
  const tStats = getSessionTokenStats([userMsg, transitionMsg]);
  passFail("usage overrides intermediateUsage and streaming", tStats.totalTokens.output, providerUsage.outputTokens || 0);
  passFail("liveStreamingTokens = 0", tStats.liveStreamingTokens, 0);

  // ── A9: Heuristic accuracy ──
  logSection("A9. Backend Token Count vs Provider Usage");
  const allChunks = chunkCount + thinkingChunkCount;
  const accuracy = providerUsage.outputTokens > 0
    ? ((allChunks / providerUsage.outputTokens) * 100).toFixed(1) : "N/A";
  log("📊", `Provider output tokens: ${providerUsage.outputTokens}`);
  log("📊", `Backend chunk count (outputTokens): ${maxOutputTokensFromChunks}`);
  log("📊", `Chunk-to-token ratio: ${accuracy}%`);
  log("💡", `Missing tokens ≈ ${(providerUsage.outputTokens || 0) - allChunks} (stop/EOS tokens per iteration)`);
}

// ── Test: Coordinator + Worker Flow ─────────────────────────

async function testCoordinatorFlow() {
  logSection("PART B: COORDINATOR + WORKER AGENTIC FLOW");

  const prompt = `You MUST delegate this work by calling team_create with exactly 2 workers:
- Worker 1: "List files in /tmp and report what you find"
- Worker 2: "Run 'echo hello world' and report the output"
Do NOT do the work yourself. Use team_create immediately.`;

  log("📤", `Prompt: delegate to 2 workers`);
  log("⏳", "Streaming coordinator + worker SSE response...\n");

  const result = await streamAgentRequest(prompt, {
    maxIterations: 10,
    maxWorkerIterations: 3,
    title: "Coordinator Token Test",
    enabledTools: ["read_file", "write_file", "list_dir", "run_command", "team_create", "send_message", "stop_agent"],
  });

  const { chunkCount, thinkingChunkCount, doneEvent, usageUpdateEvents, workerCompleteEvents, workerProgressEvents: _workerProgressEvents, workerStatusEvents, maxOutputTokensFromChunks } = result;

  logSection("B1. SSE Event Summary");
  log("📊", `Total SSE events: ${result.events.length}`);
  log("💬", `Text chunks: ${chunkCount}`);
  log("🧠", `Thinking chunks: ${thinkingChunkCount}`);
  log("🔧", `Tool executions: ${result.toolExecutions.length}`);
  log("📦", `usage_update events: ${usageUpdateEvents.length}`);
  log("👷", `Worker status events: ${workerStatusEvents.length}`);
  log("👷", `  ↳ complete: ${workerCompleteEvents.length}`);
  log(doneEvent ? "✅" : "❌", `Done event: ${doneEvent ? "received" : "MISSING"}`);

  if (!doneEvent) { console.error("\n❌ No done event — aborting."); return; }

  const providerUsage = doneEvent.usage;

  logSection("B2. Provider-Reported Usage (coordinator)");
  log("📥", `inputTokens:   ${providerUsage.inputTokens}`);
  log("📤", `outputTokens:  ${providerUsage.outputTokens}`);
  log("🔄", `requests:      ${providerUsage.requests}`);

  // ── B3: Worker accumulation ──
  logSection("B3. Worker Token Accumulation");
  const workerTokens = { input: 0, output: 0, requests: 0 };
  for (const ev of workerCompleteEvents) {
    if (ev.usage) {
      workerTokens.input += ev.usage.inputTokens || 0;
      workerTokens.output += ev.usage.outputTokens || 0;
      workerTokens.requests += ev.usage.requests || 1;
      log("📦", `Worker ${ev.workerId}: in=${ev.usage.inputTokens}, out=${ev.usage.outputTokens}`);
    }
  }
  log("📊", `Total worker tokens: in=${workerTokens.input}, out=${workerTokens.output}, reqs=${workerTokens.requests}`);

  // ── B4: Finalized with workers ──
  logSection("B4. getSessionTokenStats() — Finalized with Workers");
  const userMsg = { role: "user", content: "" };
  const coordMsg = { role: "assistant", content: "", usage: providerUsage, _workerTokens: workerTokens };
  const stats = getSessionTokenStats([userMsg, coordMsg]);
  const expectedIn = getTotalInputTokens(providerUsage) + workerTokens.input;
  const expectedOut = (providerUsage.outputTokens || 0) + workerTokens.output;
  passFail("input = coord + workers", stats.totalTokens.input, expectedIn);
  passFail("output = coord + workers", stats.totalTokens.output, expectedOut);
  passFail("total = in + out", stats.totalTokens.total, expectedIn + expectedOut);

  // ── B5: usage_update events ──
  logSection("B5. usage_update events");
  log("📊", `Coordinator iterations: ${providerUsage.requests}`);
  log("📊", `usage_update events: ${usageUpdateEvents.length}`);
  passFail("usage_update count = iteration count", usageUpdateEvents.length, providerUsage.requests || 1);

  // ── B6: Backend outputTokens on chunks ──
  logSection("B6. Backend outputTokens on SSE events");
  log("📊", `Max outputTokens from coordinator chunks: ${maxOutputTokensFromChunks}`);
  passFail("outputTokens = total coord chunks", maxOutputTokensFromChunks, chunkCount + thinkingChunkCount);
}

// ── Test: Pure Unit Tests ───────────────────────────────────

function testPureUnitTests() {
  logSection("PART C: PURE UNIT TESTS");

  // C1: _intermediateUsage priority over streaming
  logSection("C1. _intermediateUsage priority over _streamingOutputTokens");
  const iMsg = {
    role: "assistant", content: "",
    _intermediateUsage: { inputTokens: 500, outputTokens: 200, requests: 2 },
    _streamingOutputTokens: 150, // should be ignored — intermediate is authoritative
  };
  const iStats = getSessionTokenStats([{ role: "user", content: "" }, iMsg]);
  passFail("output uses intermediateUsage (200), not streaming (150)", iStats.totalTokens.output, 200);
  passFail("input from intermediateUsage", iStats.totalTokens.input, 500);
  passFail("requests from intermediateUsage", iStats.requestCount, 2);

  // C2: usage (done) overrides everything
  logSection("C2. Final usage overrides _intermediateUsage and _streamingOutputTokens");
  const fMsg = {
    role: "assistant", content: "",
    usage: { inputTokens: 1000, outputTokens: 400, requests: 3 },
    _intermediateUsage: { inputTokens: 500, outputTokens: 200, requests: 2 },
    _streamingOutputTokens: 150,
  };
  const fStats = getSessionTokenStats([{ role: "user", content: "" }, fMsg]);
  passFail("output from final usage (400)", fStats.totalTokens.output, 400);
  passFail("input from final usage (1000)", fStats.totalTokens.input, 1000);
  passFail("liveStreamingTokens = 0 (finalized)", fStats.liveStreamingTokens, 0);

  // C3: Multi-request session
  logSection("C3. Multi-Request Session");
  const multi = [
    { role: "user", content: "" },
    { role: "assistant", content: "", usage: { inputTokens: 5000, outputTokens: 200 } },
    { role: "assistant", content: "", usage: { inputTokens: 6000, outputTokens: 300 } },
    { role: "assistant", content: "", usage: { inputTokens: 7000, outputTokens: 150 } },
  ];
  const mStats = getSessionTokenStats(multi);
  passFail("input = 5000+6000+7000", mStats.totalTokens.input, 18000);
  passFail("output = 200+300+150", mStats.totalTokens.output, 650);
  passFail("requests = 3", mStats.requestCount, 3);

  // C4: Worker accumulation
  logSection("C4. Worker Token Accumulation");
  const wMsg = {
    role: "assistant", content: "",
    usage: { inputTokens: 1000, outputTokens: 200 },
    _workerTokens: { input: 5000, output: 800, requests: 3 },
  };
  const wStats = getSessionTokenStats([{ role: "user", content: "" }, wMsg]);
  passFail("input = coord(1000) + workers(5000)", wStats.totalTokens.input, 6000);
  passFail("output = coord(200) + workers(800)", wStats.totalTokens.output, 1000);
  passFail("requests = coord(1) + workers(3)", wStats.requestCount, 4);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(SEP);
  console.log("  🧪 TOKEN CALCULATION VERIFICATION TEST (Backend-Authoritative)");
  console.log(`  Provider: ${PROVIDER} | Model: ${MODEL}`);
  console.log(SEP);

  await testSingleAgentFlow();
  await testCoordinatorFlow();
  testPureUnitTests();

  console.log(`\n${SEP}`);
  if (totalFailed === 0) {
    console.log(`  ✅ ALL ${totalPassed} ASSERTIONS PASSED`);
  } else {
    console.log(`  ❌ ${totalFailed} FAILED / ${totalPassed + totalFailed} TOTAL`);
  }
  console.log(SEP);

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
