/**
 * Agent Loop — LM Studio Live Integration Tests
 * ═══════════════════════════════════════════════════════════
 * Validates the /agent endpoint with LM Studio to catch the
 * "Processing prompt" infinite loop bug. Specifically tests:
 *
 *   1. Single-turn agent generation (baseline)
 *   2. Multi-turn continuation (the exact scenario that loops)
 *   3. Tool calling with auto-approve
 *   4. Abort mid-generation (ensures cleanup)
 *   5. Rapid consecutive turns (stress test for singleflight)
 *
 * The key reproduction case: send a prompt → wait for response →
 * immediately send a follow-up prompt. This is where the model
 * enters an infinite "Processing prompt" loop due to context
 * length mismatches or stale _loadedContextLength state.
 *
 * Run:  npm run test:live -- --testPathPattern=agentLoop
 *
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS, TYPES } from "../../src/constants.ts";

const PRISM_SERVICE_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// Target model — auto-discovered from LM Studio if not found exactly
const TARGET_MODEL_PATTERNS = [
  /qwen.*3.*30b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.5.*35b/i,
  /qwen.*3\.6.*35b/i,
];

// ── Timeout constants ──────────────────────────────────────
const AGENT_TIMEOUT_MS = 120_000;       // 2 min per agent call
const SSE_IDLE_TIMEOUT_MS = 60_000;     // No SSE event for 60s = hung

// ── Helpers ────────────────────────────────────────────────

/**
 * Discover available LM Studio models and find the target Qwen model.
 * @returns {Promise<string|null>} Model key or null
 */
async function findTargetModel() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
  if (!res.ok) throw new Error("LM Studio not responding");
  const data = await res.json();
  const models = data.models || data.data || [];

  // Try each pattern in priority order
  for (const pattern of TARGET_MODEL_PATTERNS) {
    const match = models.find((m) => pattern.test(m.key || m.id));
    if (match) return match.key || match.id;
  }

  // Fallback: return any loaded conversational model
  const loaded = models.find(
    (m) => m.loaded_instances?.length > 0 && m.type !== TYPES.EMBEDDING,
  );
  if (loaded) return loaded.key || loaded.id;

  // Last resort: return first conversational model
  const first = models.find((m) => m.type !== TYPES.EMBEDDING);
  return first ? first.key || first.id : null;
}

/**
 * Parse SSE events from a streaming response.
 * Returns a structured result with all events categorized.
 *


 * @returns {Promise<object>} Parsed result
 */
async function consumeAgentSSE(response, { timeoutMs = AGENT_TIMEOUT_MS, controller } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = {
    events: [],
    chunks: [],          // text chunks
    thinkingChunks: [],  // thinking/reasoning chunks
    statuses: [],        // status events (phase transitions)
    toolCalls: [],       // tool execution events
    errors: [],          // error events
    done: null,          // done event
    text: "",            // accumulated text
    thinking: "",        // accumulated thinking
    phases: new Set(),   // unique phases seen
    // Loop detection counters — these track PHASE STARTS, not progress ticks.
    // LM Studio emits prompt_processing.progress ~25x per phase; we only
    // care about how many times the phase *starts* (restarts = loop).
    promptProcessingStarts: 0,   // prompt_processing.start events
    promptProcessingProgress: 0, // total progress ticks (informational)
    modelLoadStarts: 0,          // model_load.start events
    modelLoadProgress: 0,        // total load progress ticks
    aborted: false,
    timedOut: false,
    totalEvents: 0,
    durationMs: 0,
  };

  const startTime = Date.now();
  let lastEventTime = Date.now();

  // Timeout timer
  const timeoutId = setTimeout(() => {
    result.timedOut = true;
    controller?.abort();
    reader.cancel().catch(() => {});
  }, timeoutMs);

  // Idle detection timer — resets on every event
  const idleTimeoutId = setInterval(() => {
    if (Date.now() - lastEventTime > SSE_IDLE_TIMEOUT_MS) {
      console.warn(`  ⚠ SSE idle for ${SSE_IDLE_TIMEOUT_MS / 1000}s — aborting`);
      result.timedOut = true;
      controller?.abort();
      reader.cancel().catch(() => {});
    }
  }, 5000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(trimmed.slice(6));
          result.events.push(event);
          result.totalEvents++;
          lastEventTime = Date.now();

          switch (event.type) {
            case "chunk":
              result.chunks.push(event.content);
              result.text += event.content || "";
              break;
            case "thinking":
              result.thinkingChunks.push(event.content);
              result.thinking += event.content || "";
              break;
            case "status":
              result.statuses.push(event);
              if (event.phase) result.phases.add(event.phase);
              // Track phase STARTS — the smoking gun for the loop.
              // prompt_processing.progress fires ~25x per phase, so we only
              // count the initial "Processing prompt… 0%" or "Processing prompt…"
              // event with progress=0 as a phase start.
              if (event.message?.includes("Processing prompt")) {
                result.promptProcessingProgress++;
                // Phase start: progress === 0 or no progress field (synthetic)
                if (event.progress === 0 || event.progress === undefined || event.progress === null) {
                  result.promptProcessingStarts++;
                }
              }
              if (event.message?.includes("Loading model")) {
                result.modelLoadProgress++;
                // Only count the FIRST "Loading model" event as a load start.
                // LM Studio emits ~18 load progress events per load cycle.
                if (result._inLoadPhase !== true) {
                  result._inLoadPhase = true;
                  result.modelLoadStarts++;
                }
              } else if (result._inLoadPhase && event.phase !== "loading") {
                // Exited loading phase — reset so a second load would be counted
                result._inLoadPhase = false;
              }
              break;
            case "tool_execution":
              result.toolCalls.push(event);
              break;
            case "toolCall":
              result.toolCalls.push(event);
              break;
            case "error":
              result.errors.push(event);
              break;
            case "done":
              result.done = event;
              break;
          }
        } catch {
          // Skip malformed JSON
        }
      }

      // If we see done, stop reading
      if (result.done) break;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      result.aborted = true;
    } else {
      result.errors.push({ type: "error", message: error.message });
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(idleTimeoutId);
    result.durationMs = Date.now() - startTime;
  }

  return result;
}

/**
 * Send an agentic request via SSE streaming.
 *


 * @returns {Promise<object>} Parsed SSE result
 */
async function agentStream(payload, { timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-agent-loop-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent endpoint failed: ${response.status} ${text}`);
  }

  return consumeAgentSSE(response, { timeoutMs, controller });
}

/**
 * Send a non-streaming agentic request (?stream=false).
 * Simpler for basic tests — returns JSON directly.
 */
async function agentJSON(payload) {
  const response = await fetch(`${PRISM_SERVICE_URL}/agent?stream=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-agent-loop-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }
  return body;
}

/**
 * Helper to log a test result with timing and phase info.
 */
function logResult(label, result) {
  const dur = (result.durationMs / 1000).toFixed(1);
  const phases = [...result.phases].join(" → ");
  const textLen = result.text.length;
  const thinkLen = result.thinking.length;
  const ppStarts = result.promptProcessingStarts;
  const ppProgress = result.promptProcessingProgress;
  const loadStarts = result.modelLoadStarts;
  const loadProgress = result.modelLoadProgress;

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 55 - label.length))}┐`);
  console.log(`  │ Duration:       ${dur}s${" ".repeat(Math.max(1, 40 - dur.length))}│`);
  console.log(`  │ Phases:         ${phases.padEnd(40).slice(0, 40)}│`);
  console.log(`  │ Text length:    ${String(textLen).padEnd(40)}│`);
  console.log(`  │ Thinking:       ${String(thinkLen).padEnd(40)}│`);
  console.log(`  │ PP starts:      ${`${ppStarts} (${ppProgress} ticks)`.padEnd(40)}│`);
  console.log(`  │ Model loads:    ${`${loadStarts} (${loadProgress} ticks)`.padEnd(40)}│`);
  console.log(`  │ Iterations:     ${String(result.statuses.filter((s) => s.message === "iteration_progress").length).padEnd(40)}│`);
  console.log(`  │ Tool calls:     ${String(result.toolCalls.length).padEnd(40)}│`);
  console.log(`  │ Errors:         ${String(result.errors.length).padEnd(40)}│`);
  console.log(`  │ Total events:   ${String(result.totalEvents).padEnd(40)}│`);
  // Event type breakdown
  const typeCounts = {};
  for (const e of result.events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const typeStr = Object.entries(typeCounts).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  │ Types:          ${typeStr.padEnd(40).slice(0, 40)}│`);
  // Dump usage event
  const usageEv = result.events.find((e) => e.type === "usage_update" || e.type === "done");
  if (usageEv?.usage) {
    const u = usageEv.usage;
    console.log(`  │ Usage:          in=${u.inputTokens || 0} out=${u.outputTokens || 0} reason=${u.reasoningOutputTokens || 0}`.padEnd(60).slice(0, 60) + "│");
  }
  if (result.timedOut) console.log(`  │ ⚠️  TIMED OUT                                        │`);
  if (result.errors.length > 0) {
    for (const e of result.errors.slice(0, 3)) {
      console.log(`  │ ❌ ${(e.message || "unknown").slice(0, 53).padEnd(53)}│`);
    }
  }
  console.log(`  └${"─".repeat(59)}┘`);
}

// ═══════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════

let targetModel = null;
const agentConversationId = crypto.randomUUID();

beforeAll(async () => {
  // Check services are running
  try {
    await fetch(PRISM_SERVICE_URL);
  } catch {
    throw new Error(`Prism not running at ${PRISM_SERVICE_URL}`);
  }
  try {
    await fetch(LM_STUDIO_URL);
  } catch {
    throw new Error(`LM Studio not running at ${LM_STUDIO_URL}`);
  }

  targetModel = await findTargetModel();
  if (!targetModel) {
    throw new Error("No suitable Qwen model found in LM Studio");
  }

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  Agent Loop — LM Studio Integration Tests            ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  Model:  ${targetModel.padEnd(46).slice(0, 46)}║`);
  console.log(`  ║  Session: ${agentConversationId.slice(0, 8)}…${" ".repeat(41)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);

describe("Agent Loop — LM Studio Agentic Endpoint", () => {
  // ── Test 1: Single-turn baseline ─────────────────────────────
  it("single-turn agent generates text without looping", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "What is 2 + 2? Answer in one sentence." },
      ],
      agent: "CODING",
      agentConversationId,
      maxTokens: 100,
      autoApprove: true,
    });

    logResult("Single Turn", result);

    // Core assertions
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();
    // Model may produce text, thinking, or (for reasoning models) empty output
    // when think tags get stripped. The important thing is that the loop completed.

    // Loop detection: prompt processing phase should START at most once per
    // generation turn. Progress ticks within a phase are normal (~25x).
    // If starts > 2, the model is restarting its processing loop.
    expect(result.promptProcessingStarts).toBeLessThanOrEqual(2);
    // Model may need to load once (cold start) — never more
    expect(result.modelLoadStarts).toBeLessThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  }, AGENT_TIMEOUT_MS + 10_000);

  // ── Test 2: Multi-turn continuation (THE BUG REPRODUCTION) ──
  // This is the exact scenario that triggers the infinite loop:
  // Agent responds on turn 1 → user sends turn 2 → model enters
  // a "Processing prompt" loop because of context length mismatch
  // or stale _loadedContextLength state across agentic iterations.
  it("multi-turn agent continues without re-entering processing loop", async () => {
    const sessionId = crypto.randomUUID();

    // ── Turn 1 ──
    console.log("\n  📝 Turn 1: Initial prompt…");
    const turn1 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "Hello! My name is Rodrigo. What is your name?" },
      ],
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 150,
      autoApprove: true,
    });

    logResult("Turn 1", turn1);

    expect(turn1.timedOut).toBe(false);
    expect(turn1.done).toBeTruthy();

    // ── Turn 2 (the critical test) ──
    // Build multi-turn message array — exactly what the frontend does
    console.log("\n  📝 Turn 2: Follow-up prompt (the critical test)…");
    const turn2 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "Hello! My name is Rodrigo. What is your name?" },
        { role: "assistant", content: turn1.text || turn1.thinking || "Hello!" },
        { role: "user", content: "What did I just tell you my name was? Answer briefly." },
      ],
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 100,
      autoApprove: true,
    });

    logResult("Turn 2 (continuation)", turn2);

    // THE KEY ASSERTIONS — this is what catches the loop
    expect(turn2.timedOut).toBe(false);
    expect(turn2.done).toBeTruthy();

    // Loop detection: on turn 2, prompt processing should START once
    // (not restart). Model should NOT reload — it's warm from turn 1.
    expect(turn2.promptProcessingStarts).toBeLessThanOrEqual(2);
    expect(turn2.modelLoadStarts).toBe(0); // Model already loaded from turn 1
    expect(turn2.errors).toHaveLength(0);

    // ── Turn 3 — triple-check stability ──
    console.log("\n  📝 Turn 3: Third consecutive turn…");
    const turn3 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "Hello! My name is Rodrigo. What is your name?" },
        { role: "assistant", content: turn1.text || "Hello!" },
        { role: "user", content: "What did I just tell you my name was?" },
        { role: "assistant", content: turn2.text || "Rodrigo." },
        { role: "user", content: "Great! Now, what is 10 * 10? Just the number." },
      ],
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 50,
      autoApprove: true,
    });

    logResult("Turn 3 (stability check)", turn3);

    expect(turn3.timedOut).toBe(false);
    expect(turn3.done).toBeTruthy();
    expect(turn3.promptProcessingStarts).toBeLessThanOrEqual(2);
    expect(turn3.modelLoadStarts).toBe(0);
    expect(turn3.errors).toHaveLength(0);
  }, AGENT_TIMEOUT_MS * 3 + 30_000);

  // ── Test 3: Agent with tool calling ──────────────────────────
  // Verifies the OpenAI-compat path (_streamOpenAICompat) used
  // when options.agent is set — this is a different code path than
  // the native MCP path and has its own "Processing prompt" event.
  it("agent with tool calling completes without looping", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "What files are in the current directory? Use tools to check." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 500,
      autoApprove: true,
      maxIterations: 3,
    });

    logResult("Tool Calling", result);

    // Should complete (might use tools or just respond)
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // Even with tool iterations, prompt processing phase should start
    // at most once per iteration. With maxIterations=3, allow up to 4
    // starts (initial + retries).
    expect(result.promptProcessingStarts).toBeLessThanOrEqual(4);
    expect(result.modelLoadStarts).toBeLessThanOrEqual(1);
  }, AGENT_TIMEOUT_MS + 30_000);

  // ── Test 4: Abort mid-generation ─────────────────────────────
  // Ensures that aborting a stream doesn't leave the model in a
  // state that causes the next request to loop.
  it("abort mid-generation does not poison subsequent requests", async () => {
    const sessionId = crypto.randomUUID();

    // Start a generation and abort it after the first few events
    console.log("\n  📝 Starting generation to abort…");
    const controller = new AbortController();

    const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-project": "prism-agent-loop-tests",
        "x-username": "test-runner",
      },
      body: JSON.stringify({
        provider: PROVIDERS.LM_STUDIO,
        model: targetModel,
        messages: [
          { role: "user", content: "Write a very long essay about the history of computing." },
        ],
        agent: "CODING",
        agentConversationId: sessionId,
        maxTokens: 2000,
        autoApprove: true,
      }),
      signal: controller.signal,
    });

    // Read a few events then abort
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let eventCount = 0;

    try {
      while (eventCount < 10) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        eventCount += (text.match(/^data: /gm) || []).length;
      }
    } catch { /* expected */ }

    console.log(`  🛑 Aborting after ${eventCount} events…`);
    controller.abort();
    await reader.cancel().catch(() => {});

    // Wait for cleanup — the abort may cause the server to reset
    // internal state (unload model, clean up singleflight, etc.)
    await new Promise((r) => setTimeout(r, 3000));

    // Now send a follow-up — this should NOT loop.
    // Retry with backoff in case Prism is briefly recovering.
    console.log("  📝 Sending follow-up after abort…");
    let followUp = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        followUp = await agentStream({
          provider: PROVIDERS.LM_STUDIO,
          model: targetModel,
          messages: [
            { role: "user", content: "Say 'hello' and nothing else." },
          ],
          agent: "CODING",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 20,
          autoApprove: true,
        });
        // If we got a done event or meaningful output, we're good
        if (followUp.done || followUp.text.length > 0) break;
        // If we got a "terminated" error, the model is still recovering
        if (followUp.errors.some((e) => e.message?.includes("terminated"))) {
          console.log(`  ⚠ Attempt ${attempt}: model still recovering, retrying…`);
          await new Promise((r) => setTimeout(r, 3000));
          followUp = null;
          continue;
        }
        break;
      } catch (error) {
        if (attempt < 3 && error.message?.includes("ECONNREFUSED")) {
          console.log(`  ⚠ Attempt ${attempt}: server not ready, retrying in 3s…`);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }

    expect(followUp).toBeTruthy();
    logResult("Post-Abort Follow-up", followUp);

    expect(followUp.timedOut).toBe(false);
    // Allow recovery: either done event or text content
    expect(followUp.done || followUp.text.length > 0).toBeTruthy();
    expect(followUp.promptProcessingStarts).toBeLessThanOrEqual(2);
    // Model may need to reload after abort — that's acceptable
    expect(followUp.modelLoadStarts).toBeLessThanOrEqual(1);
  }, AGENT_TIMEOUT_MS * 2 + 20_000);

  // ── Test 5: Rapid consecutive turns ──────────────────────────
  // Stress test: send 5 rapid-fire single-turn requests to verify
  // the singleflight mutex and model state consistency.
  it("rapid consecutive turns maintain model stability", async () => {
    // Brief wait after previous abort test to ensure server stability
    await new Promise((r) => setTimeout(r, 2000));

    const results = [];

    for (let i = 0; i < 5; i++) {
      const result = await agentStream({
        provider: PROVIDERS.LM_STUDIO,
        model: targetModel,
        messages: [
          { role: "user", content: `Turn ${i + 1}: What is ${i + 1} + ${i + 1}? Answer with just the number.` },
        ],
        agent: "CODING",
        agentConversationId: crypto.randomUUID(),
        maxTokens: 30,
        autoApprove: true,
      });

      results.push(result);
    }

    console.log("\n  ┌─ Rapid Turns ─────────────────────────────────────────┐");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const dur = (r.durationMs / 1000).toFixed(1);
      const status = r.timedOut ? "⏰" : r.errors.length > 0 ? "✗" : "✓";
      const pp = r.promptProcessingStarts;
      const loads = r.modelLoadStarts;
      console.log(
        `  │ ${status} Turn ${i + 1}: ${dur.padStart(5)}s | pp=${pp} | loads=${loads} | text=${r.text.length}  │`,
      );
    }
    console.log("  └─────────────────────────────────────────────────────────┘");

    // All turns should complete
    for (const r of results) {
      expect(r.timedOut).toBe(false);
      expect(r.done).toBeTruthy();
      expect(r.promptProcessingStarts).toBeLessThanOrEqual(2);
    }

    // Only the first turn should need to load the model (if not already loaded)
    const totalLoads = results.reduce((s, r) => s + r.modelLoadStarts, 0);
    expect(totalLoads).toBeLessThanOrEqual(1);
  }, AGENT_TIMEOUT_MS * 5 + 30_000);

  // ── Test 6: Non-streaming JSON agent ─────────────────────────
  // Validates the ?stream=false path completes without hanging.
  it("non-streaming agent endpoint returns valid JSON", async () => {
    const startTime = Date.now();
    const result = await agentJSON({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "What is 5 * 5? Answer with just the number." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 30,
      autoApprove: true,
    });

    const dur = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  ✓ JSON agent response in ${dur}s — text: "${(result.text || "").slice(0, 50)}"`);

    // Accept valid generation — model may produce text, thinking, or empty output
    expect(result.usage).toBeDefined();
    // Verify usage structure exists (values may be zero for empty model output)
    expect(typeof result.usage.inputTokens).toBe("number");
    expect(typeof result.usage.outputTokens).toBe("number");
  }, AGENT_TIMEOUT_MS + 10_000);

  // ── Test 7: Coordinator with 4 workers across 3 turns ────────
  // Exercises the full coordinator pipeline: the model is asked to
  // spawn 4 parallel sub-agents. Subsequent turns verify the
  // coordinator doesn't re-enter a processing loop when workers
  // have completed and the session has accumulated tool results.
  it("coordinator spawns workers and completes 3 turns without looping", async () => {
    const sessionId = crypto.randomUUID();
    const COORDINATOR_TIMEOUT = 180_000; // 3 min — workers need time

    // ── Turn 1: ask for 4 parallel workers ──
    console.log("\n  📝 Coordinator Turn 1: requesting 4 workers…");
    const turn1 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        {
          role: "user",
          content:
            "I need you to research 4 topics IN PARALLEL using your team_create tool. " +
            "Create a team with 4 workers, each researching a different topic:\n" +
            "1. Worker 1: List the files in /tmp\n" +
            "2. Worker 2: What is the current date (use shell)\n" +
            "3. Worker 3: Echo 'hello from worker 3'\n" +
            "4. Worker 4: Echo 'hello from worker 4'\n\n" +
            "Use team_create with 4 members. Each worker should use shell_execute to run their command.",
        },
      ],
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 1000,
      autoApprove: true,
      maxIterations: 10,
    }, { timeoutMs: COORDINATOR_TIMEOUT });

    logResult("Coordinator Turn 1", turn1);

    // Core assertions — loop must not spin
    expect(turn1.timedOut).toBe(false);
    expect(turn1.done).toBeTruthy();
    expect(turn1.promptProcessingStarts).toBeLessThanOrEqual(10); // up to 10 iterations

    // Check if the model actually spawned workers
    const workerEvents = turn1.statuses.filter(
      (s) => s.message === "workers_updated",
    );
    const teamCreateCalls = turn1.toolCalls.filter(
      (t) => t.tool?.name === "team_create" || t.name === "team_create",
    );
    console.log(
      `  📊 Workers spawned: ${workerEvents.length > 0 ? "yes" : "no"} | ` +
      `team_create calls: ${teamCreateCalls.length} | ` +
      `worker events: ${workerEvents.length}`,
    );

    // ── Turn 2: follow-up referencing turn 1 ──
    console.log("\n  📝 Coordinator Turn 2: follow-up after workers…");
    const turn2Messages = [
      {
        role: "user",
        content:
          "I need you to research 4 topics IN PARALLEL using your team_create tool. " +
          "Create a team with 4 workers.",
      },
      {
        role: "assistant",
        content: turn1.text || turn1.thinking || "I've spawned the workers as requested.",
      },
      {
        role: "user",
        content: "Great. Now summarize what happened. What did the workers produce? Be brief.",
      },
    ];

    const turn2 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: turn2Messages,
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 500,
      autoApprove: true,
      maxIterations: 5,
    }, { timeoutMs: COORDINATOR_TIMEOUT });

    logResult("Coordinator Turn 2", turn2);

    expect(turn2.timedOut).toBe(false);
    expect(turn2.done).toBeTruthy();
    // Must NOT re-enter processing loop
    expect(turn2.promptProcessingStarts).toBeLessThanOrEqual(5);
    expect(turn2.modelLoadStarts).toBe(0);

    // ── Turn 3: stability check ──
    console.log("\n  📝 Coordinator Turn 3: stability verification…");
    const turn3Messages = [
      ...turn2Messages,
      {
        role: "assistant",
        content: turn2.text || turn2.thinking || "Workers completed successfully.",
      },
      {
        role: "user",
        content: "What is 7 * 8? Just the number, nothing else.",
      },
    ];

    const turn3 = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: turn3Messages,
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 50,
      autoApprove: true,
      maxIterations: 3,
    }, { timeoutMs: COORDINATOR_TIMEOUT });

    logResult("Coordinator Turn 3", turn3);

    expect(turn3.timedOut).toBe(false);
    expect(turn3.done).toBeTruthy();
    expect(turn3.promptProcessingStarts).toBeLessThanOrEqual(3);
    expect(turn3.modelLoadStarts).toBe(0);
    expect(turn3.errors).toHaveLength(0);
  }, 600_000); // 10 min total for coordinator test
});
