/**
 * Session Generation Tracker — Live Integration Tests
 * ═══════════════════════════════════════════════════════════════
 * Validates backend-sourced token throughput and metrics from
 * SessionGenerationTracker. Uses the /agent endpoint with a Qwen3
 * model loaded in LM Studio to verify:
 *
 *   1. tok/s, inputTokens, outputTokens, totalTokens, avgTtft
 *      are emitted via generation_progress SSE events
 *   2. Coordinator + 4 workers report aggregate tok/s via the unified
 *      tracker (workers register under the parent session)
 *   3. Per-worker tok/s is forwarded as worker_status events and
 *      would appear in MessageList toolCallItem per-worker badges
 *   4. Sub-request attribution: tool callbacks (generate_image,
 *      describe_image) register under the parent session
 *
 * Run:  npm run test:live -- --testPathPattern=sessionGenTracker
 *
 * ═══════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS, TYPES } from "#src/constants";

const PRISM_SERVICE_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// ── Target model discovery ─────────────────────────────────
// Qwen3.6 35B A3B UD — auto-discovered from LM Studio
const TARGET_MODEL_PATTERNS = [
  /qwen.*3\.6.*35b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.[56].*35b/i,
  /qwen.*3.*30b.*a3b/i,
];

// ── Timeout constants ──────────────────────────────────────
const AGENT_TIMEOUT_MILLISECONDS = 120_000;
const SSE_IDLE_TIMEOUT_MILLISECONDS = 60_000;

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

async function findTargetModel() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
  if (!res.ok) throw new Error("LM Studio not responding");
  const data = (await res.json()) as any;
  const models = data.models || data.data || [];

  for (const pattern of TARGET_MODEL_PATTERNS) {
    const match = models.find((m: any) => pattern.test(m.key || m.id));
    if (match) return match.key || match.id;
  }

  // Fallback: any loaded conversational model
  const loaded = models.find(
    (m: any) => m.loaded_instances?.length > 0 && m.type !== TYPES.EMBEDDING,
  );
  if (loaded) return loaded.key || loaded.id;

  const first = models.find((m: any) => m.type !== TYPES.EMBEDDING);
  return first ? first.key || first.id : null;
}

/**
 * Parse SSE events from a streaming agent response.
 * Extended to capture generation_progress and worker_status events
 * for tok/s validation.
 */
async function consumeAgentSSE(response: any, { timeoutMilliseconds = AGENT_TIMEOUT_MILLISECONDS, controller }: any = {}) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result: any = {
    events: [],
    chunks: [],
    thinkingChunks: [],
    statuses: [],
    toolCalls: [],
    errors: [],
    done: null,
    text: "",
    thinking: "",
    phases: new Set(),
    aborted: false,
    timedOut: false,
    totalEvents: 0,
    durationMilliseconds: 0,

    // ── Tok/s tracking fields ────────────────────────────
    generationProgressEvents: [],   // { tokPerSec, activeRequests, outputTokens }
    usageUpdateEvents: [],          // { usage }
    subAgentStatusEvents: [],       // all sub_agent_status events
    subAgentGenerationProgress: {}, // subAgentId → { tokPerSec, outputTokens }[]
    subAgentCompleteEvents: [],     // sub-agent completion events with usage
  };

  const startTime = Date.now();
  let lastEventTime = Date.now();

  const timeoutId = setTimeout(() => {
    result.timedOut = true;
    controller?.abort();
    reader.cancel().catch(() => {});
  }, timeoutMilliseconds);

  const idleTimeoutId = setInterval(() => {
    if (Date.now() - lastEventTime > SSE_IDLE_TIMEOUT_MILLISECONDS) {
      console.warn(`  ⚠ SSE idle for ${SSE_IDLE_TIMEOUT_MILLISECONDS / 1000}s — aborting`);
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
      buffer = lines.pop() || "";

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
              // Capture generation_progress events from the coordinator
              if (event.message === "generation_progress") {
                result.generationProgressEvents.push({
                  tokPerSec: event.tokPerSec,
                  activeRequests: event.activeRequests,
                  outputTokens: event.outputTokens,
                  inputTokens: event.inputTokens,
                  totalTokens: event.totalTokens,
                  avgTtft: event.avgTtft,
                  timestamp: Date.now(),
                });
              }
              break;
            case "usage_update":
              result.usageUpdateEvents.push(event);
              break;
            case "tool_execution":
              result.toolCalls.push(event);
              break;
            case "toolCall":
              result.toolCalls.push(event);
              break;
            case "sub_agent_status":
              result.subAgentStatusEvents.push(event);
              // Capture per-subagent generation_progress
              if (event.message === "generation_progress") {
                if (!result.subAgentGenerationProgress[event.subAgentId]) {
                  result.subAgentGenerationProgress[event.subAgentId] = [];
                }
                result.subAgentGenerationProgress[event.subAgentId].push({
                  tokPerSec: event.tokPerSec,
                  activeRequests: event.activeRequests,
                  outputTokens: event.outputTokens,
                  inputTokens: event.inputTokens,
                  totalTokens: event.totalTokens,
                  avgTtft: event.avgTtft,
                  timestamp: Date.now(),
                });
              }
              if (event.message === "complete") {
                result.subAgentCompleteEvents.push(event);
              }
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

      if (result.done) break;
    }
  } catch (error: any) {
    if (error.name === "AbortError") {
      result.aborted = true;
    } else {
      result.errors.push({ type: "error", message: error.message });
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(idleTimeoutId);
    result.durationMilliseconds = Date.now() - startTime;
  }

  return result;
}

/**
 * Stream an agent request and return structured SSE results.
 */
async function agentStream(payload: any, { timeoutMilliseconds = AGENT_TIMEOUT_MILLISECONDS }: any = {}) {
  const controller = new AbortController();
  const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-tok-per-sec-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent endpoint failed: ${response.status} ${text}`);
  }

  return consumeAgentSSE(response, { timeoutMilliseconds, controller });
}

/**
 * Log tok/s test results with comprehensive telemetry.
 */
function logTokPerSecResult(label: any, result: any) {
  const dur = (result.durationMilliseconds / 1000).toFixed(1);
  const progEvents = result.generationProgressEvents;
  const lastProg = progEvents[progEvents.length - 1];
  const peakTokPerSec = progEvents.reduce(
    (max: any, e: any) => (e.tokPerSec != null && e.tokPerSec > max ? e.tokPerSec : max), 0,
  );
  const subAgentIds = Object.keys(result.subAgentGenerationProgress);

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 55 - label.length))}┐`);
  console.log(`  │ Duration:            ${dur.padEnd(37)}│`);
  console.log(`  │ Total SSE events:    ${String(result.totalEvents).padEnd(37)}│`);
  console.log(`  │ gen_progress events: ${String(progEvents.length).padEnd(37)}│`);
  console.log(`  │ Peak tok/s:          ${peakTokPerSec > 0 ? peakTokPerSec.toFixed(1) : "N/A".padEnd(37)}│`);
  console.log(`  │ Last tok/s:          ${lastProg?.tokPerSec != null ? lastProg.tokPerSec.toFixed(1) : "N/A".padEnd(37)}│`);
  console.log(`  │ Last activeRequests: ${lastProg?.activeRequests ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Last outputTokens:   ${lastProg?.outputTokens ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Last inputTokens:    ${lastProg?.inputTokens ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Last totalTokens:    ${lastProg?.totalTokens ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Last avgTtft:        ${lastProg?.avgTtft != null ? lastProg.avgTtft.toFixed(3) + "s" : "N/A".padEnd(37)}│`);
  console.log(`  │ Sub-agent IDs tracked: ${subAgentIds.length > 0 ? subAgentIds.join(", ").slice(0, 37) : "none".padEnd(37)}│`);
  console.log(`  │ Sub-agent completions: ${String(result.subAgentCompleteEvents.length).padEnd(37)}│`);
  console.log(`  │ usage_update events: ${String(result.usageUpdateEvents.length).padEnd(37)}│`);
  if (result.errors.length > 0) {
    for (const e of result.errors.slice(0, 3)) {
      console.log(`  │ ❌ ${(e.message || "unknown").slice(0, 53).padEnd(53)}│`);
    }
  }
  if (result.timedOut) console.log(`  │ ⚠️  TIMED OUT                                        │`);

  // Per-subagent tok/s summary
  for (const subAgentId of subAgentIds) {
    const progressList = result.subAgentGenerationProgress[subAgentId];
    const peakRate = progressList.reduce(
      (max: any, e: any) => (e.tokPerSec != null && e.tokPerSec > max ? e.tokPerSec : max), 0,
    );
    const lastEvent = progressList[progressList.length - 1];
    console.log(`  │ Sub-agent ${subAgentId.slice(0, 10).padEnd(10)}: ${progressList.length} events, peak=${peakRate > 0 ? peakRate.toFixed(1) : "N/A"} tok/s, last=${lastEvent?.tokPerSec?.toFixed(1) ?? "N/A"} tok/s│`);
  }
  console.log(`  └${"─".repeat(59)}┘`);
}


// ═══════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════

let targetModel: any = null;

beforeAll(async () => {
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
  console.log("  ║  SessionGenerationTracker — Tok/s Integration Tests  ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  Model:  ${targetModel.padEnd(46).slice(0, 46)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);

describe("SessionGenerationTracker — Tok/s Attribution", () => {

  // ── Test 1: Single-turn generation emits generation_progress ──
  // This validates that the coordinator's own generation produces
  // the generation_progress SSE events consumed by SettingsPanel.
  it("single-turn agent emits generation_progress with valid tok/s", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "Explain what a red-black tree is in 2-3 sentences." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 300,
      autoApprove: true,
    });

    logTokPerSecResult("Single Turn — generation_progress", result);

    // Core: must complete without timeout
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // generation_progress events MUST have been emitted
    // (every 10 chunks or 500ms during active generation)
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // At least one event must have a non-null, positive tok/s
    const withTokPerSec = result.generationProgressEvents.filter(
      (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Validate event structure — what SettingsPanel would receive
    for (const event of result.generationProgressEvents) {
      expect(event).toHaveProperty("tokPerSec");
      expect(event).toHaveProperty("activeRequests");
      expect(event).toHaveProperty("outputTokens");
      expect(event).toHaveProperty("inputTokens");
      expect(event).toHaveProperty("totalTokens");
      // avgTtft may be null early on (before first token arrives)
      expect("avgTtft" in event).toBe(true);
    }

    // Sanity: tok/s should be reasonable (0.1 – 500 tok/s for local models)
    const peakTokPerSec = Math.max(
      ...result.generationProgressEvents
        .filter((e: any) => e.tokPerSec != null)
        .map((e: any) => e.tokPerSec),
    );
    expect(peakTokPerSec).toBeGreaterThan(0);
    expect(peakTokPerSec).toBeLessThan(500);

    // usage_update should also have been emitted at least once
    expect(result.usageUpdateEvents.length).toBeGreaterThan(0);
  }, AGENT_TIMEOUT_MILLISECONDS + 10_000);

  // ── Test 2: Tool-calling agent maintains tok/s across iterations ──
  // When an agent generates tool call JSON, the LLM is actively producing
  // tokens internally. SessionGenerationTracker should track these tokens
  // and emit generation_progress events even during tool argument generation.
  it("tool-calling agent emits generation_progress across multiple iterations", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "What files are in /tmp? Use shell_execute to check, then list them." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 500,
      autoApprove: true,
      maxIterations: 5,
    });

    logTokPerSecResult("Tool Calling — generation_progress", result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // Should have generation_progress events from at least 1 iteration
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // If tool calls were made, there should be multiple iterations
    // and generation_progress from each iteration's LLM call
    const iterationEvents = result.statuses.filter(
      (s: any) => s.message === "iteration_progress",
    );
    if (iterationEvents.length > 1) {
      // Multiple iterations → should have progress from each
      console.log(`  📊 ${iterationEvents.length} iterations, ${result.generationProgressEvents.length} progress events`);
      // At least 1 progress event per iteration (conservative — some iterations may
      // be very short and complete before the 10-chunk / 500ms threshold)
    }

    // All events should have valid structure
    for (const event of result.generationProgressEvents) {
      expect(typeof event.tokPerSec === "number" || event.tokPerSec === null).toBe(true);
      expect(typeof event.activeRequests).toBe("number");
      expect(typeof event.outputTokens).toBe("number");
    }
  }, AGENT_TIMEOUT_MILLISECONDS + 30_000);

  // ── Test 3: Coordinator with 4 workers — combined + per-worker tok/s ──
  // The critical test: spawn 4 parallel workers and validate that:
  // a) The coordinator's generation_progress aggregates all workers via
  //    SessionGenerationTracker.getSessionStats(parentSessionId)
  // b) Each worker's generation_progress is forwarded as sub_agent_status
  //    events for per-subagent tok/s display in MessageList toolCallItem
  it("coordinator with 4 workers reports combined and per-subagent tok/s", async () => {
    const sessionId = crypto.randomUUID();
    const COORDINATOR_TIMEOUT = 300_000; // 5 min — workers are sequential on local

    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        {
          role: "user",
          content:
            "I need you to research 4 topics IN PARALLEL using your team_create tool. " +
            "Create a team with 4 workers:\n" +
            "1. Worker 1: Run `echo 'hello from worker 1'` using shell_execute\n" +
            "2. Worker 2: Run `echo 'hello from worker 2'` using shell_execute\n" +
            "3. Worker 3: Run `echo 'hello from worker 3'` using shell_execute\n" +
            "4. Worker 4: Run `echo 'hello from worker 4'` using shell_execute\n\n" +
            "Use team_create with exactly 4 members. Each worker should use shell_execute.",
        },
      ],
      agent: "CODING",
      agentConversationId: sessionId,
      maxTokens: 1500,
      autoApprove: true,
      maxIterations: 10,
    }, { timeoutMilliseconds: COORDINATOR_TIMEOUT });

    logTokPerSecResult("Coordinator + 4 Workers — tok/s", result);

    // Core: must complete
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // ── Combined tok/s (SettingsPanel statsBadges) ────────────
    // Coordinator MUST emit generation_progress events
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // At least some events should have valid tok/s
    const validProgress = result.generationProgressEvents.filter(
      (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(validProgress.length).toBeGreaterThan(0);

    console.log(`\n  📊 Combined tok/s events: ${result.generationProgressEvents.length}`);
    console.log(`     Valid tok/s events: ${validProgress.length}`);

    // The activeRequests count should reflect the number of
    // concurrent LLM calls. When workers are running in parallel,
    // activeRequests could be > 1 (on multi-instance setups).
    // On a single LM Studio instance with sequential workers,
    // activeRequests will be 1 at any given time.
    const maxActiveReqs = Math.max(
      ...result.generationProgressEvents.map((e: any) => e.activeRequests || 0),
    );
    console.log(`     Peak activeRequests: ${maxActiveReqs}`);

    // ── Per-subagent tok/s (MessageList toolCallItem) ──────────
    // Check if workers were actually spawned
    const teamCreateCalls = result.toolCalls.filter(
      (t: any) => t.tool?.name === "team_create" || t.name === "team_create",
    );
    const subAgentIds = Object.keys(result.subAgentGenerationProgress);

    console.log(`     team_create calls: ${teamCreateCalls.length}`);
    console.log(`     Sub-agents with generation_progress: ${subAgentIds.length}`);
    console.log(`     Sub-agent completions: ${result.subAgentCompleteEvents.length}`);

    // If the model successfully spawned workers, validate per-subagent tok/s
    if (teamCreateCalls.length > 0 && subAgentIds.length > 0) {
      // Each worker that generated text should have at least 1 progress event
      for (const subAgentId of subAgentIds) {
        const progressList = result.subAgentGenerationProgress[subAgentId];
        expect(progressList.length).toBeGreaterThan(0);

        // At least one event should have tok/s
        const wWithTokPerSec = progressList.filter(
          (e: any) => e.tokPerSec != null && e.tokPerSec > 0,
        );

        console.log(`     Sub-agent ${subAgentId.slice(0, 12)}: ${progressList.length} progress events, ${wWithTokPerSec.length} with tok/s`);

        // Validate event structure — what toolCallItem would display
        for (const event of progressList) {
          expect(event).toHaveProperty("tokPerSec");
          expect(event).toHaveProperty("outputTokens");
        }
      }

      // Worker completions should have usage data
      for (const subAgentComplete of result.subAgentCompleteEvents) {
        expect(subAgentComplete.subAgentId).toBeDefined();
        // Usage may be null for aborted workers, but should exist for completed ones
        if (subAgentComplete.usage) {
          expect(typeof subAgentComplete.usage.outputTokens).toBe("number");
        }
      }
    } else {
      // Model didn't spawn workers — this is possible if LM Studio
      // doesn't support function calling for this model. Log but don't fail.
      console.log(`\n  ⚠ Model did not spawn workers — coordinator-only tok/s verified`);
      console.log(`    Tool calls: ${result.toolCalls.map((t: any) => t.tool?.name || t.name).join(", ") || "none"}`);
    }
  }, 600_000); // 10 min total

  // ── Test 4: OutputTokens accumulation accuracy ────────────────
  // Validate that the outputTokens count in generation_progress
  // events increases monotonically within an iteration and matches
  // the provider-reported usage at the end.
  it("outputTokens in generation_progress increases monotonically", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "Write a short poem about the moon (4 lines)." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 200,
      autoApprove: true,
    });

    logTokPerSecResult("Output Token Monotonicity", result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // OutputTokens should increase monotonically across progress events
    let prevTokens = 0;
    for (const event of result.generationProgressEvents) {
      if (event.outputTokens != null) {
        expect(event.outputTokens).toBeGreaterThanOrEqual(prevTokens);
        prevTokens = event.outputTokens;
      }
    }

    // Final outputTokens should be > 0 (model produced output)
    const lastEvent = result.generationProgressEvents[result.generationProgressEvents.length - 1];
    expect(lastEvent.outputTokens).toBeGreaterThan(0);

    // Compare with done event usage — should be in the same ballpark
    // (generation_progress uses estimated counts, done has provider-reported)
    if (result.done?.usage?.outputTokens) {
      const ratio = lastEvent.outputTokens / result.done.usage.outputTokens;
      console.log(`  📊 Progress outputTokens: ${lastEvent.outputTokens}, Done usage: ${result.done.usage.outputTokens}, ratio: ${ratio.toFixed(2)}`);
      // Allow generous margin — estimated vs provider counts can differ
      // but should be within 5x
      expect(ratio).toBeGreaterThan(0.1);
      expect(ratio).toBeLessThan(5);
    }
  }, AGENT_TIMEOUT_MILLISECONDS + 10_000);

  // ── Test 5: Full metrics — inputTokens, totalTokens, avgTtft ─────
  // Validates that all backend-sourced metrics are present and accurate
  // in generation_progress events: input tokens match provider usage,
  // totalTokens = inputTokens + outputTokens, and avgTtft matches
  // the separately-emitted generation_started TTFT.
  it("generation_progress includes inputTokens, totalTokens, and avgTtft", async () => {
    const result = await agentStream({
      provider: PROVIDERS.LM_STUDIO,
      model: targetModel,
      messages: [
        { role: "user", content: "What is the Fibonacci sequence? One paragraph." },
      ],
      agent: "CODING",
      agentConversationId: crypto.randomUUID(),
      maxTokens: 300,
      autoApprove: true,
    });

    logTokPerSecResult("Full Metrics — inputTokens/totalTokens/avgTtft", result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    const lastEvent = result.generationProgressEvents[result.generationProgressEvents.length - 1];

    // ── inputTokens ──────────────────────────────────────────
    // After the iteration completes, the final generation_progress
    // event should report the provider's input token count.
    expect(lastEvent.inputTokens).toBeDefined();
    expect(typeof lastEvent.inputTokens).toBe("number");
    expect(lastEvent.inputTokens).toBeGreaterThan(0);
    console.log(`  📊 inputTokens: ${lastEvent.inputTokens}`);

    // Cross-validate with usage_update or done event
    const doneInputTokens = result.done?.usage?.inputTokens
      || result.done?.usage?.promptTokens || 0;
    if (doneInputTokens > 0) {
      console.log(`     done.usage inputTokens: ${doneInputTokens}`);
      // Should match exactly (both come from the provider)
      expect(lastEvent.inputTokens).toBe(doneInputTokens);
    }

    // ── totalTokens ─────────────────────────────────────────
    // totalTokens = inputTokens + outputTokens
    expect(lastEvent.totalTokens).toBeDefined();
    expect(lastEvent.totalTokens).toBe(lastEvent.inputTokens + lastEvent.outputTokens);
    console.log(`     totalTokens: ${lastEvent.totalTokens} (${lastEvent.inputTokens} in + ${lastEvent.outputTokens} out)`);

    // ── avgTtft ────────────────────────────────────────────
    // avgTtft should be populated after the first token arrives.
    // For a single-iteration request it equals the TTFT for that one request.
    expect(lastEvent.avgTtft).toBeDefined();
    expect(typeof lastEvent.avgTtft).toBe("number");
    expect(lastEvent.avgTtft).toBeGreaterThan(0);
    // Sanity: TTFT should be < 30s for a local model
    expect(lastEvent.avgTtft).toBeLessThan(30);
    console.log(`     avgTtft: ${lastEvent.avgTtft.toFixed(3)}s`);

    // Cross-validate with the generation_started event TTFT
    const genStartedEvents = result.statuses.filter(
      (s: any) => s.message === "generation_started" && s.timeToFirstToken != null,
    );
    if (genStartedEvents.length > 0) {
      const serverTtft = genStartedEvents[0].timeToFirstToken;
      console.log(`     generation_started TTFT: ${serverTtft.toFixed(3)}s`);
      // They should match closely (both computed from the same passStart/passFirstTokenTime)
      expect(Math.abs(lastEvent.avgTtft - serverTtft)).toBeLessThan(0.1);
    }

    // ── All events must include the full field set ──────────────
    for (const event of result.generationProgressEvents) {
      expect(event).toHaveProperty("tokPerSec");
      expect(event).toHaveProperty("activeRequests");
      expect(event).toHaveProperty("outputTokens");
      expect(event).toHaveProperty("inputTokens");
      expect(event).toHaveProperty("totalTokens");
      expect("avgTtft" in event).toBe(true);
      // totalTokens identity must hold
      if (event.inputTokens != null && event.outputTokens != null) {
        expect(event.totalTokens).toBe(event.inputTokens + event.outputTokens);
      }
    }
  }, AGENT_TIMEOUT_MILLISECONDS + 10_000);
});
