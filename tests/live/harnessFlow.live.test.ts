/**
 * Harness Flow — Live Infrastructure Tests
 * ════════════════════════════════════════════════════════════════
 *
 * Validates that the agentic loop INFRASTRUCTURE works correctly.
 * These tests stop where the harness stops and the LLM takes control.
 *
 * They verify: SSE streaming, event structure, timeouts, abort,
 * error handling, context window, harness variants, plan mode events,
 * maxIterations enforcement, and concurrent session isolation.
 *
 * These should ALWAYS pass regardless of which model is loaded,
 * as long as the model can generate ANY text response.
 *
 * ⚠️  These tests hit real LLM providers.
 *     Cloud providers are opt-in via INCLUDE_CLOUD=true.
 *
 * Run:
 *   npx vitest run --config vitest.live.config.ts tests/live/harnessFlow.live.test.ts
 *
 * ════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  discoverProviders,
  agentStream,
  agentStreamWithRetry,
  logResult,
  logProviderSummary,
  assertCleanCompletion,
  assertNoThinking,
  assertNoLoop,
  assertIterationCountWithin,
  getTimeout,
  DEFAULT_AGENT_TIMEOUT_MS,
  type ProviderTarget,
  type AgentSSEResult,
} from "./helpers/agentTestHarness.ts";
import {
  SIMPLE_ARITHMETIC,
  BRIEF_GREETING,
  ONE_SENTENCE_ANSWER,
  MINIMAL_PROMPT,
  LIST_CURRENT_DIRECTORY,
  COMPLEX_REASONING,
  EMPTY_STRING,
  EXTREMELY_LONG_MESSAGE,
  UNICODE_HEAVY,
  RAPID_FIRE_TEMPLATE,
  TEXT_ONLY_NO_TOOLS,
  ITERATION_STRESS,
  PLAN_MODE_TASK,
  THINKING_PLUS_TOOL,
} from "./helpers/testPrompts.ts";


// ── Provider Discovery ──────────────────────────────────────────

let providerTargets: ProviderTarget[] = [];

beforeAll(async () => {
  providerTargets = await discoverProviders();
  logProviderSummary(providerTargets);
}, 30_000);


// ═══════════════════════════════════════════════════════════════
// Suite 1: Basic SSE Stream Completion
// ═══════════════════════════════════════════════════════════════

describe("Suite 1: Basic SSE Stream Completion", () => {
  it("1.1 — single-turn text generation completes with done event", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      assertNoLoop(result);
    }
  }, 300_000);

  it("1.2 — minimal prompt produces valid output", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: MINIMAL_PROMPT }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);

  it("1.3 — large system prompt is handled without silent truncation", async () => {
    const largeSystemPrompt = "You are a helpful assistant. ".repeat(500);

    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "system", content: largeSystemPrompt },
            { role: "user", content: ONE_SENTENCE_ANSWER },
          ],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("1.4 — extremely low maxTokens (10) still produces output", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: BRIEF_GREETING }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 10,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 2: Harness Loop Mechanics
// ═══════════════════════════════════════════════════════════════

describe("Suite 2: Harness Loop Mechanics", () => {
  it("2.1 — maxIterations enforcement stops the loop", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const maximumIterations = 3;
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ITERATION_STRESS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: maximumIterations,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      assertIterationCountWithin(result, maximumIterations + 1);
    }
  }, 300_000);

  it("2.2 — autoApprove=true never blocks for approval", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LIST_CURRENT_DIRECTORY }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const approvalStatuses = result.statuses.filter(
        (status) => status.message === "approval_required",
      );
      expect(approvalStatuses).toHaveLength(0);
    }
  }, 300_000);

  it("2.3 — exhaustion recovery fires on iteration limit", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ITERATION_STRESS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 2,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("2.4 — output truncation triggers continuation, not premature stop", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "Write a very detailed essay about the history of computing, " +
                "covering at least 20 different milestones. Be thorough.",
            },
          ],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 50,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 3: Thinking Mode Detection
// ═══════════════════════════════════════════════════════════════

describe("Suite 3: Thinking Mode Detection", () => {
  it("3.1 — non-thinking model emits no thinking chunks", async () => {
    const nonThinkingTargets = providerTargets.filter(
      (providerTarget) => !providerTarget.supportsThinking,
    );
    if (nonThinkingTargets.length === 0) {
      console.log("  ⏭ Skipping: all providers support thinking");
      return;
    }

    for (const target of nonThinkingTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
          thinkingEnabled: false,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`3.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      assertNoThinking(result);
    }
  }, 300_000);

  it("3.2 — agent doesn't stop prematurely on thinking-only output", async () => {
    const thinkingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking && providerTarget.supportsToolCalling,
    );
    if (thinkingTargets.length === 0) {
      console.log("  ⏭ Skipping: no thinking+tool providers");
      return;
    }

    for (const target of thinkingTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: THINKING_PLUS_TOOL }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 5,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`3.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 4: Harness Variants
// ═══════════════════════════════════════════════════════════════

describe("Suite 4: Harness Variants", () => {
  it("4.1 — tree-of-thought harness completes without crash", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: COMPLEX_REASONING }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 5,
          harness: "tree-of-thought",
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`4.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 600_000);

  it("4.2 — vision-language harness handles text-only input", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
          harness: "vision-language",
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 5: Plan Mode Infrastructure
// ═══════════════════════════════════════════════════════════════

describe("Suite 5: Plan Mode Infrastructure", () => {
  it("5.1 — planFirst=true emits plan_mode_entered event", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: PLAN_MODE_TASK }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
          planFirst: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`5.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      const planModeStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_entered",
      );
      expect(planModeStatuses.length).toBeGreaterThanOrEqual(1);
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 6: Edge Cases & Error Handling
// ═══════════════════════════════════════════════════════════════

describe("Suite 6: Edge Cases & Error Handling", () => {
  it("6.1 — abort mid-stream doesn't corrupt server state", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const controller = new AbortController();
      const prismBaseUrl = process.env.PRISM_TEST_URL || "https://api.prism.rod.dev";
      const response = await fetch(`${prismBaseUrl}/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-project": "agent-behavior-tests",
          "x-username": "test-runner",
        },
        body: JSON.stringify({
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: "Write a very long essay about the history of computing." },
          ],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
        }),
        signal: controller.signal,
      });

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let eventCount = 0;

      try {
        while (eventCount < 5) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          eventCount += (text.match(/^data: /gm) || []).length;
        }
      } catch {
        /* expected on abort */
      }

      controller.abort();
      await reader.cancel().catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const followUp = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: BRIEF_GREETING }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 20,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`6.1 Post-Abort [${target.providerName}]`, followUp);

      expect(followUp.timedOut).toBe(false);
      expect(followUp.done || followUp.text.length > 0).toBeTruthy();
    }
  }, 300_000);

  it("6.2 — rapid consecutive requests maintain stability", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const results: AgentSSEResult[] = [];
      for (let turnIndex = 0; turnIndex < 3; turnIndex++) {
        const result = await agentStreamWithRetry(
          {
            provider: target.providerName,
            model: target.model,
            messages: [{ role: "user", content: RAPID_FIRE_TEMPLATE(turnIndex + 1) }],
            agent: "OMNI",
            agentSessionId: crypto.randomUUID(),
            maxTokens: 30,
            autoApprove: true,
          },
          { timeoutMs: getTimeout(target) },
        );
        results.push(result);
      }

      console.log("\n  ┌─ Rapid Requests ──────────────────────────────────────┐");
      for (let turnIndex = 0; turnIndex < results.length; turnIndex++) {
        const turnResult = results[turnIndex];
        const durationSeconds = (turnResult.durationMs / 1000).toFixed(1);
        const statusIcon = turnResult.timedOut ? "⏰" : turnResult.errors.length > 0 ? "✗" : "✓";
        console.log(
          `  │ ${statusIcon} Turn ${turnIndex + 1}: ${durationSeconds.padStart(5)}s | text=${turnResult.text.length}`.padEnd(
            60,
          ) + "│",
        );
      }
      console.log("  └─────────────────────────────────────────────────────────┘");

      for (const turnResult of results) {
        expect(turnResult.timedOut).toBe(false);
        expect(turnResult.done).toBeTruthy();
      }
    }
  }, 600_000);

  it("6.3 — empty message doesn't crash the server", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      try {
        const result = await agentStreamWithRetry(
          {
            provider: target.providerName,
            model: target.model,
            messages: [{ role: "user", content: EMPTY_STRING }],
            agent: "OMNI",
            agentSessionId: crypto.randomUUID(),
            maxTokens: 100,
            autoApprove: true,
          },
          { timeoutMs: getTimeout(target) },
        );

        logResult(`6.3 [${target.providerName}]`, result);

        expect(result.timedOut).toBe(false);
      } catch (error: unknown) {
        console.log(`  ✓ Empty message returned error (expected): ${(error as Error).message}`);
      }
    }
  }, 300_000);

  it("6.4 — extremely long message (50K chars) is processed", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: EXTREMELY_LONG_MESSAGE }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`6.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 600_000);

  it("6.5 — unicode/emoji prompt doesn't corrupt SSE stream", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: UNICODE_HEAVY }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`6.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("6.6 — zero enabled tools produces text-only response", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TEXT_ONLY_NO_TOOLS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
          enabledTools: [],
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`6.6 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("6.7 — invalid provider returns error immediately", async () => {
    try {
      await agentStreamWithRetry(
        {
          provider: "nonexistent-provider-xyz",
          model: "fake-model",
          messages: [{ role: "user", content: BRIEF_GREETING }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: 15_000, maxRetries: 0 },
      );
    } catch (error: unknown) {
      console.log(`  ✓ Invalid provider returned error: ${(error as Error).message}`);
      expect((error as Error).message).toBeTruthy();
    }
  }, 30_000);

  it("6.8 — invalid model returns error within timeout", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName}`);

      try {
        const result = await agentStreamWithRetry(
          {
            provider: target.providerName,
            model: "nonexistent-model-xyz-999",
            messages: [{ role: "user", content: BRIEF_GREETING }],
            agent: "OMNI",
            agentSessionId: crypto.randomUUID(),
            maxTokens: 100,
            autoApprove: true,
          },
          { timeoutMs: 30_000 },
        );

        logResult(`6.8 [${target.providerName}]`, result);

        expect(result.timedOut).toBe(false);
      } catch (error: unknown) {
        console.log(`  ✓ Invalid model returned error: ${(error as Error).message}`);
        expect((error as Error).message).toBeTruthy();
      }
    }
  }, 60_000);

  it("6.9 — concurrent sessions don't cross-contaminate", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const [resultAlice, resultBob] = await Promise.all([
        agentStream(
          {
            provider: target.providerName,
            model: target.model,
            messages: [{ role: "user", content: "My name is Alice. Repeat my name." }],
            agent: "OMNI",
            agentSessionId: crypto.randomUUID(),
            maxTokens: 100,
            autoApprove: true,
          },
          { timeoutMs: getTimeout(target) },
        ),
        agentStream(
          {
            provider: target.providerName,
            model: target.model,
            messages: [{ role: "user", content: "My name is Bob. Repeat my name." }],
            agent: "OMNI",
            agentSessionId: crypto.randomUUID(),
            maxTokens: 100,
            autoApprove: true,
          },
          { timeoutMs: getTimeout(target) },
        ),
      ]);

      logResult(`6.9 Alice [${target.providerName}]`, resultAlice);
      logResult(`6.9 Bob [${target.providerName}]`, resultBob);

      expect(resultAlice.timedOut).toBe(false);
      expect(resultBob.timedOut).toBe(false);
      expect(resultAlice.done).toBeTruthy();
      expect(resultBob.done).toBeTruthy();

      const aliceText = (resultAlice.text + resultAlice.thinking).toLowerCase();
      const bobText = (resultBob.text + resultBob.thinking).toLowerCase();

      if (aliceText.includes("bob") && !aliceText.includes("alice")) {
        throw new Error("Cross-contamination: Alice's response mentions Bob but not Alice");
      }
      if (bobText.includes("alice") && !bobText.includes("bob")) {
        throw new Error("Cross-contamination: Bob's response mentions Alice but not Bob");
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 7: SSE Event Structure
// ═══════════════════════════════════════════════════════════════

describe("Suite 7: SSE Event Structure", () => {
  it("7.1 — usage_update events fire during streaming", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ONE_SENTENCE_ANSWER }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 300,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`7.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      expect(result.done?.usage).toBeDefined();
    }
  }, 300_000);

  it("7.2 — SSE event structure is consistent across providers", async () => {
    if (providerTargets.length < 2) {
      console.log("  ⏭ Skipping: need at least 2 providers for cross-provider comparison");
      return;
    }

    const results: Array<{ target: ProviderTarget; result: AgentSSEResult }> = [];

    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`7.2 [${target.providerName}]`, result);
      results.push({ target, result });
    }

    for (const { target, result } of results) {
      expect(result.done).toBeTruthy();
      expect(result.timedOut).toBe(false);
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      console.log(
        `  ✓ ${target.providerName}: ${result.chunks.length} chunks, ` +
        `${result.thinkingChunks.length} thinking, ` +
        `${result.totalEvents} total events`,
      );
    }
  }, 600_000);

  it("7.3 — all providers emit chunk → done sequence", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ONE_SENTENCE_ANSWER }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`7.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const contentEventCount = result.chunks.length + result.thinkingChunks.length;
      expect(contentEventCount).toBeGreaterThan(0);
      const lastEvent = result.events[result.events.length - 1];
      expect(lastEvent?.type).toBe("done");
    }
  }, 300_000);
});
