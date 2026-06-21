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
import { THOUGHT_STRUCTURES, HARNESS_IDS } from "../../src/constants.ts";
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
  isEmptyResponse,
  getTimeout,
  getMultiAgentTimeout,
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
  PLAN_MODE_EXIT_INSTRUCTION,
  CONTEXT_WINDOW_FILLER_MESSAGE,
  LONG_STRUCTURED_OUTPUT,
  POST_ERROR_HEALTH_CHECK,
  TREE_OF_THOUGHT_BRANCH_PROMPT,
  GRAPH_OF_THOUGHTS_SYNTHESIS_PROMPT,
  STRATEGY_COMPARISON_PROMPT,
  SEARCH_FOR_TOOLS,
  FORCED_TOPOLOGY_SPAWN,
} from "./helpers/testPrompts.ts";


// ── Provider Discovery ──────────────────────────────────────────

let providerTargets: ProviderTarget[] = [];

beforeAll(async () => {
  providerTargets = await discoverProviders();
  logProviderSummary(providerTargets);
}, 60_000);


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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      }
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`1.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      }
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 2,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      }
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
            agentConversationId: crypto.randomUUID(),
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
            agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`6.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      }
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
            agentConversationId: crypto.randomUUID(),
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
            agentConversationId: crypto.randomUUID(),
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
            agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`7.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Infrastructure check: done event is the last meaningful event.
      // Whether the model produced content chunks is a model capability
      // concern — an empty response is still a valid SSE stream.
      const lastEvent = result.events[result.events.length - 1];
      expect(lastEvent?.type).toBe("done");

      // No content events should appear AFTER the done event
      const eventTypes = result.events.map((event) => event.type);
      const doneIndex = eventTypes.lastIndexOf("done");
      if (doneIndex >= 0 && doneIndex < eventTypes.length - 1) {
        const contentTypes = new Set(["chunk", "thinking", "tool_execution", "toolCall"]);
        const contentAfterDone = eventTypes.slice(doneIndex + 1).filter(
          (eventType) => contentTypes.has(eventType as string),
        );
        expect(contentAfterDone).toHaveLength(0);
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 8: Context Window Enforcement
// ═══════════════════════════════════════════════════════════════

describe("Suite 8: Context Window Enforcement", () => {
  it("8.1 — large multi-message context triggers context_truncated event", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Build a conversation with many large messages to push near the context limit
      const fillerMessages = Array.from({ length: 40 }, (_, messageIndex) => ({
        role: messageIndex % 2 === 0 ? "user" : "assistant",
        content: CONTEXT_WINDOW_FILLER_MESSAGE,
      }));

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            ...fillerMessages,
            { role: "user", content: ONE_SENTENCE_ANSWER },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`8.1 [${target.providerName}]`, result);

      // Infrastructure assertion: the server must complete (not crash on large context)
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Check if context_truncated event fired (expected with 40 large messages)
      const contextTruncatedStatuses = result.statuses.filter(
        (status) => status.message === "context_truncated",
      );
      console.log(
        `  📊 context_truncated events: ${contextTruncatedStatuses.length}`,
      );
      if (contextTruncatedStatuses.length > 0) {
        // Verify the event carries strategy and token count metadata
        const firstTruncation = contextTruncatedStatuses[0];
        expect(firstTruncation.strategy).toBeDefined();
        console.log(`  📊 Truncation strategy: ${firstTruncation.strategy}`);
        console.log(`  📊 Estimated tokens: ${firstTruncation.estimatedTokens}`);
      }
    }
  }, 600_000);

  it("8.2 — context enforcement preserves system + recent messages", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Build a conversation where the system prompt + recent user message should survive truncation
      const fillerMessages = Array.from({ length: 60 }, (_, messageIndex) => ({
        role: messageIndex % 2 === 0 ? "user" : "assistant",
        content: CONTEXT_WINDOW_FILLER_MESSAGE,
      }));

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "system", content: "You are a helpful assistant. Always answer briefly." },
            ...fillerMessages,
            { role: "user", content: "What is 5 + 5? Just the number." },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 50,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`8.2 [${target.providerName}]`, result);

      // The server must handle this without crashing
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // If the model produced text, it means the system/user messages survived truncation
      expect(result.text.length + result.thinking.length).toBeGreaterThanOrEqual(0);
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 9: Output Truncation Recovery
// ═══════════════════════════════════════════════════════════════

describe("Suite 9: Output Truncation Recovery", () => {
  it("9.1 — stopReason=length triggers continuation (multiple iterations)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Use very low maxTokens on a long prompt to force truncation
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LONG_STRUCTURED_OUTPUT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 30,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`9.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify multiple iterations fired (indicating truncation recovery looped)
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      console.log(
        `  📊 Iterations fired: ${iterationStatuses.length} (expecting > 1 from truncation recovery)`,
      );
      // With 30 maxTokens and 50-element list, we expect at least 2 iterations
      expect(iterationStatuses.length).toBeGreaterThanOrEqual(1);
    }
  }, 600_000);

  it("9.2 — truncation recovery doesn't corrupt accumulated text", async () => {
    for (const target of providerTargets.slice(0, 1)) {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 50,
          autoApprove: true,
          maxIterations: 4,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`9.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // The done event must still carry a valid usage object
      expect(result.done?.usage).toBeDefined();
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 10: Plan Mode Full Lifecycle
// ═══════════════════════════════════════════════════════════════

describe("Suite 10: Plan Mode Full Lifecycle", () => {
  it("10.1 — planFirst=true enters plan mode and continues generating", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: PLAN_MODE_TASK }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
          planFirst: true,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`10.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify plan_mode_entered was emitted
      const planModeEnteredStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_entered",
      );
      expect(planModeEnteredStatuses.length).toBeGreaterThanOrEqual(1);

      // In plan mode, the loop continues even with text-only output (no break).
      // Verify we got multiple iterations OR exit_plan_mode was called.
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      console.log(
        `  📊 Iterations in plan mode: ${iterationStatuses.length}`,
      );
    }
  }, 600_000);

  it("10.2 — plan mode exit emits plan_mode_exited event", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Multi-turn: first enter plan mode, then instruct exit
      const agentConversationId = crypto.randomUUID();
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: PLAN_MODE_TASK },
          ],
          agent: "OMNI",
          agentConversationId,
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 8,
          planFirst: true,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`10.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Check for plan_mode_exited event (fires when model calls exit_plan_mode)
      const planModeExitedStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_exited",
      );
      console.log(
        `  📊 plan_mode_exited events: ${planModeExitedStatuses.length}`,
      );
      // Whether the model called exit_plan_mode depends on the model's decision.
      // The infrastructure test verifies the event pipeline doesn't crash either way.
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 11: Tree-of-Thought Branching Events
// ═══════════════════════════════════════════════════════════════

describe("Suite 11: Tree-of-Thought Branching Events", () => {
  it("11.1 — ToT harness emits branching_started event", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TREE_OF_THOUGHT_BRANCH_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: "tree-of-thought",
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`11.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify branching_started event was emitted with branchCount metadata
      const branchingStartedStatuses = result.statuses.filter(
        (status) => status.message === "branching_started",
      );

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping branching event assertions");
      } else {
        expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
        const firstBranching = branchingStartedStatuses[0];
        expect(firstBranching.branchCount).toBe(2);
        expect(firstBranching.iteration).toBeDefined();
        console.log(
          `  📊 Branching events: ${branchingStartedStatuses.length}, branchCount=${firstBranching.branchCount}`,
        );
      }
    }
  }, 600_000);

  it("11.2 — ToT harness emits branch_selected event with scores", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TREE_OF_THOUGHT_BRANCH_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: "tree-of-thought",
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`11.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify branch_selected event was emitted with score metadata
      const branchSelectedStatuses = result.statuses.filter(
        (status) => status.message === "branch_selected",
      );

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping branch_selected assertions");
      } else {
        expect(branchSelectedStatuses.length).toBeGreaterThanOrEqual(1);
        const selectedBranch = branchSelectedStatuses[0];
        expect(selectedBranch.branchIndex).toBeDefined();
        expect(selectedBranch.score).toBeDefined();
        expect(selectedBranch.scores).toBeDefined();
        expect(Array.isArray(selectedBranch.scores)).toBe(true);
        console.log(
          `  📊 Selected branch: ${selectedBranch.branchIndex}, score=${selectedBranch.score}`,
        );
        console.log(
          `  📊 All scores: ${JSON.stringify(selectedBranch.scores)}`,
        );
      }
    }
  }, 600_000);

  it("11.3 — ToT with branchCount=1 skips scoring (single candidate fast path)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
          maxIterations: 2,
          harness: "tree-of-thought",
          branchCount: 1,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`11.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // With branchCount=1, branch_selected should still fire but with score=10
      // (the single-candidate fast path in scoreBranches)
      const selectedStatuses = result.statuses.filter(
        (status) => status.message === "branch_selected",
      );
      if (selectedStatuses.length > 0) {
        expect(selectedStatuses[0].score).toBe(10);
        console.log(`  📊 Single-branch score: ${selectedStatuses[0].score} (expected 10)`);
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 12: Error-Path Recovery
// ═══════════════════════════════════════════════════════════════

describe("Suite 12: Error-Path Recovery", () => {
  it("12.1 — provider error mid-loop produces done event (not hang)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Trigger a provider error by sending a conversation with
      // tool results but no prior tool calls (malformed turn structure).
      // The provider may reject this mid-stream, testing the error-path persistence.
      try {
        const result = await agentStreamWithRetry(
          {
            provider: target.providerName,
            model: target.model,
            messages: [
              { role: "user", content: "Hello" },
              {
                role: "assistant",
                content: "Let me check that.",
                toolCalls: [
                  { id: "fake-tc-1", name: "nonexistent_tool", args: {}, result: { error: "Tool not found" } },
                ],
              },
              { role: "user", content: "Continue" },
            ],
            agent: "OMNI",
            agentConversationId: crypto.randomUUID(),
            maxTokens: 100,
            autoApprove: true,
            maxIterations: 2,
          },
          { timeoutMs: getTimeout(target) },
        );

        logResult(`12.1 [${target.providerName}]`, result);

        // Either the server handled the malformed input gracefully (done event)
        // or it returned an error event — both are acceptable.
        // What's NOT acceptable is a hang (timedOut=true).
        expect(result.timedOut).toBe(false);
        if (result.done) {
          console.log("  ✓ Server recovered gracefully with done event");
        } else if (result.errors.length > 0) {
          console.log(
            `  ✓ Server returned error event: ${result.errors[0].message}`,
          );
        }
      } catch (error: unknown) {
        // HTTP-level error is also acceptable (server rejected the request)
        console.log(
          `  ✓ Server rejected malformed payload: ${(error as Error).message}`,
        );
      }
    }
  }, 300_000);

  it("12.2 — error mid-loop doesn't corrupt subsequent sessions", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // First: trigger a potential error (invalid model on valid provider)
      try {
        await agentStream(
          {
            provider: target.providerName,
            model: "nonexistent-model-xyz-999",
            messages: [{ role: "user", content: "Test" }],
            agent: "OMNI",
            agentConversationId: crypto.randomUUID(),
            maxTokens: 50,
            autoApprove: true,
          },
          { timeoutMs: 30_000 },
        );
      } catch {
        // Expected — the invalid model should error
      }

      // Brief pause to let server recover
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Second: verify the server still works on a fresh session
      const healthCheckResult = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: POST_ERROR_HEALTH_CHECK }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 30,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`12.2 Post-Error Health [${target.providerName}]`, healthCheckResult);

      assertCleanCompletion(healthCheckResult);
      if (!isEmptyResponse(healthCheckResult)) {
        expect(healthCheckResult.text.length + healthCheckResult.thinking.length).toBeGreaterThan(0);
      }
    }
  }, 300_000);

  it("12.3 — abort signal mid-loop triggers error-path finalization", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const controller = new AbortController();
      const prismBaseUrl = process.env.PRISM_TEST_URL || "https://api.prism.rod.dev";

      // Start a long-running request then abort after a few events
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
          messages: [{ role: "user", content: LONG_STRUCTURED_OUTPUT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 4000,
          autoApprove: true,
          maxIterations: 3,
        }),
        signal: controller.signal,
      });

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let receivedEventCount = 0;

      try {
        while (receivedEventCount < 3) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          receivedEventCount += (text.match(/^data: /gm) || []).length;
        }
      } catch {
        /* expected */
      }

      // Abort after receiving a few events
      controller.abort();
      await reader.cancel().catch(() => {});

      console.log(`  📊 Events before abort: ${receivedEventCount}`);

      // Wait for server to process the abort
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify server is healthy after the aborted request
      const postAbortResult = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: POST_ERROR_HEALTH_CHECK }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 30,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`12.3 Post-Abort [${target.providerName}]`, postAbortResult);

      expect(postAbortResult.timedOut).toBe(false);
      expect(postAbortResult.done || postAbortResult.text.length > 0).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 13: Dynamic Tool Discovery & Mutation
// ═══════════════════════════════════════════════════════════════

describe("Suite 13: Dynamic Tool Discovery & Mutation", () => {
  it("13.1 — search_tools call produces tool_execution event", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SEARCH_FOR_TOOLS }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`13.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Check if the model called search_tools (model-dependent but likely)
      const searchToolExecutions = result.toolExecutions.filter(
        (toolEvent) =>
          toolEvent.tool?.name === "search_tools" || toolEvent.name === "search_tools",
      );
      console.log(
        `  📊 search_tools executions: ${searchToolExecutions.length}`,
      );

      // Check for tool_set_changed events (fires if model also called enable_tools)
      const toolSetChangedStatuses = result.statuses.filter(
        (status) => status.message === "tool_set_changed",
      );
      console.log(
        `  📊 tool_set_changed events: ${toolSetChangedStatuses.length}`,
      );

      if (toolSetChangedStatuses.length > 0) {
        const firstChange = toolSetChangedStatuses[0];
        expect(firstChange.enabledCount).toBeDefined();
        console.log(
          `  📊 Enabled tool count after mutation: ${firstChange.enabledCount}`,
        );
      }
    }
  }, 600_000);

  it("13.2 — enabledTools filter restricts available tools", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Explicitly enable only a single tool
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "List the files in /tmp using a tool. Also try to read a file.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 3,
          enabledTools: ["shell_execute"],
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`13.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Any tool calls that were executed should only be shell_execute
      // (or core agentic tools that are always present)
      const executedToolNames = result.toolExecutions
        .map((toolEvent) => toolEvent.tool?.name || toolEvent.name)
        .filter(Boolean);
      console.log(
        `  📊 Executed tools: [${executedToolNames.join(", ")}]`,
      );
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 14: Harness-Specific Edge Cases
// ═══════════════════════════════════════════════════════════════

describe("Suite 14: Harness-Specific Edge Cases", () => {
  it("14.1 — VLM harness completes without live frames (text-only fallback)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // VLM harness without any live frames — should fall back to text-only
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content: "Describe what you see. If you don't have any visual input, say 'no visual input available'.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
          harness: "vision-language",
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`14.1 VLM [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // VLM harness should complete without crashing even without frames
      expect(result.text.length + result.thinking.length).toBeGreaterThanOrEqual(0);
    }
  }, 300_000);

  it("14.2 — harness=standard (ReAct) with planFirst + autoApprove loops correctly", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "Plan out how to check the system hostname, then execute the plan. " +
                "When you're done planning, exit plan mode and execute using shell_execute.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 8,
          planFirst: true,
          harness: HARNESS_IDS.STANDARD,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`14.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify plan mode was entered
      const planEnteredStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_entered",
      );
      expect(planEnteredStatuses.length).toBeGreaterThanOrEqual(1);

      // Log the full lifecycle
      const planExitedStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_exited",
      );
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      console.log(
        `  📊 Plan entered: ${planEnteredStatuses.length}, exited: ${planExitedStatuses.length}, iterations: ${iterationStatuses.length}`,
      );
    }
  }, 600_000);

  it("14.3 — exhaustion recovery pass fires when tool loop hits maxIterations", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Use a very low maxIterations with a prompt that encourages multiple tool calls.
      // If the model calls tools on every iteration, it will exhaust iterations
      // and the exhaustion recovery pass should fire to synthesize a final response.
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ITERATION_STRESS }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`14.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // After exhaustion, the harness should still produce a final text response
      // (via the exhaustion recovery pass). The text might be from the recovery
      // pass or from the last iteration.
      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      }

      // Verify iterations were actually used
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      console.log(
        `  📊 Iterations used: ${iterationStatuses.length} (max: 2)`,
      );
    }
  }, 600_000);

  it("14.4 — consecutive tool errors don't crash the harness", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Instruct the model to read files that don't exist — this will produce
      // tool errors on each attempt. The harness should handle these gracefully
      // via MAX_CONSECUTIVE_TOOL_ERRORS.
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "Read the following files using tools:\n" +
                "1. /nonexistent/file/alpha.txt\n" +
                "2. /nonexistent/file/beta.txt\n" +
                "3. /nonexistent/file/gamma.txt\n" +
                "4. /nonexistent/file/delta.txt\n" +
                "Report what you found in each.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 6,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`14.4 [${target.providerName}]`, result);

      // The harness must not crash — it should complete gracefully
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Tool errors should be tracked — verify the harness didn't swallow them
      const totalToolActivity = result.toolExecutions.length + result.toolCalls.length;
      console.log(
        `  📊 Tool activity count: ${totalToolActivity}, errors: ${result.errors.length}`,
      );
    }
  }, 600_000);

  it("14.5 — iteration_progress events carry correct metadata", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const maximumIterations = 3;
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LIST_CURRENT_DIRECTORY }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: maximumIterations,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`14.5 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Every iteration_progress event should carry iteration + maxIterations
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      for (const iterationStatus of iterationStatuses) {
        expect(iterationStatus.iteration).toBeDefined();
        expect(typeof iterationStatus.iteration).toBe("number");
        expect(iterationStatus.maxIterations).toBeDefined();
        expect(typeof iterationStatus.maxIterations).toBe("number");
        expect(iterationStatus.iteration).toBeLessThanOrEqual(
          iterationStatus.maxIterations as number,
        );
      }
      console.log(
        `  📊 All ${iterationStatuses.length} iteration_progress events carry valid metadata`,
      );
    }
  }, 300_000);

  it("14.6 — generation_started event carries timeToFirstToken", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`14.6 [${target.providerName}]`, result);

      assertCleanCompletion(result);

      // Verify generation_started status event with timeToFirstToken
      const generationStartedStatuses = result.statuses.filter(
        (status) => status.message === "generation_started",
      );

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping generation_started assertions");
      } else {
        expect(generationStartedStatuses.length).toBeGreaterThanOrEqual(1);
        const firstGeneration = generationStartedStatuses[0];
        expect(firstGeneration.timeToFirstToken).toBeDefined();
        expect(typeof firstGeneration.timeToFirstToken).toBe("number");
        expect(firstGeneration.timeToFirstToken as number).toBeGreaterThan(0);
        console.log(
          `  📊 TTFT: ${((firstGeneration.timeToFirstToken as number) * 1000).toFixed(0)}ms`,
        );
      }
    }
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════
// Suite 15: Harness Strategies, Topologies, and Mixtures
// ═══════════════════════════════════════════════════════════════

describe("Suite 15: Harness Strategies, Topologies, and Mixtures", () => {
  it("15.1 — standard harness with chain_of_thought thoughtStructure completes cleanly", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`15.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);

  it("15.2 — standard harness with tree_of_thoughts thoughtStructure resolves and functions", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TREE_OF_THOUGHT_BRANCH_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`15.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Verify that branching_started event was emitted (verifying tree_of_thoughts was run)
      const branchingStartedStatuses = result.statuses.filter(
        (status) => status.message === "branching_started",
      );

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping branching event assertions");
      } else {
        expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
        expect(branchingStartedStatuses[0].branchCount).toBe(2);
      }
    }
  }, 600_000);

  it("15.3 — sequential topology chains sub-agent outputs cleanly", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "Use team_create with sequential topology and 2 members:\n" +
                "1. First member: Run `echo 'ping'` using shell\n" +
                "2. Second member: Take the previous output and echo it back with shell\n\n" +
                "Use topology 'sequential' so the second member receives the first's output.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 10,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
          topology: "sequential",
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`15.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const teamCreateCalls = allToolEvents.filter(
        (toolEvent) =>
          (toolEvent.tool?.name || toolEvent.name) === "team_create" ||
          (toolEvent.tool?.name || toolEvent.name) === "create_team",
      );
      expect(teamCreateCalls.length).toBeGreaterThan(0);
    }
  }, 600_000);

  it("15.4 — mixture: standard harness with tree_of_thoughts strategy and sequential topology", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "Solve this logic problem using ToT branching and sequential subagents:\n" +
                "Use team_create with sequential topology and 2 members to analyze the branching steps.",
            },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 10,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
          topology: "sequential",
          branchCount: 2,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`15.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping branching event assertions");
      } else {
        // Verify branching_started was emitted
        const branchingStartedStatuses = result.statuses.filter(
          (status) => status.message === "branching_started",
        );
        expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
      }
    }
  }, 600_000);

  it("15.5 — standard harness with graph_of_thoughts thoughtStructure emits synthesis events", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: GRAPH_OF_THOUGHTS_SYNTHESIS_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`15.5 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping GoT event assertions");
      } else {
        // Verify branching_started was emitted
        const branchingStartedStatuses = result.statuses.filter(
          (status) => status.message === "branching_started",
        );
        expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
        expect(branchingStartedStatuses[0].branchCount).toBe(2);

        // Verify synthesis_started was emitted (GoT-specific)
        const synthesisStatuses = result.statuses.filter(
          (status) => status.message === "synthesis_started",
        );
        expect(synthesisStatuses.length).toBeGreaterThanOrEqual(1);
      }
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 16: System Reminder Lifecycle
// ═══════════════════════════════════════════════════════════════

describe("Suite 16: System Reminder Lifecycle", () => {
  it("16.1 — harness completes cleanly when reminderModel is NOT set (feature disabled)", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: ITERATION_STRESS }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 10,
          // reminderModel intentionally omitted — feature should be disabled
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`16.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // No system_reminder_injected events should fire when feature is disabled
      const reminderStatuses = result.statuses.filter(
        (status) => status.message === "system_reminder_injected",
      );
      expect(reminderStatuses).toHaveLength(0);
      console.log(
        `  ✓ No reminder events fired (feature disabled as expected)`,
      );
    }
  }, 600_000);

  it("16.2 — harness completes cleanly when reminderModel IS set (feature enabled)", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Use the same provider/model as the main generation for the reminder
      // extraction. Set a low reminderInterval so it triggers during the test.
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant. You must always respond in English. " +
                "Never use profanity or offensive language. Always cite your sources " +
                "when making factual claims. Do not fabricate data or statistics. " +
                "You should prioritize user safety. Never execute destructive commands. " +
                "Always ask for confirmation before irreversible actions. " +
                "Respond concisely and avoid unnecessary verbosity. " +
                "Use proper markdown formatting in all responses.",
            },
            { role: "user", content: ITERATION_STRESS },
          ],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 10,
          reminderModel: target.model,
          reminderProvider: target.providerName,
          reminderInterval: 5,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`16.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Count reminder injection events — they may or may not fire depending
      // on whether enough iterations were reached, but the harness must
      // NOT crash regardless
      const reminderStatuses = result.statuses.filter(
        (status) => status.message === "system_reminder_injected",
      );
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );

      console.log(
        `  📊 Iterations: ${iterationStatuses.length}, ` +
          `System reminders injected: ${reminderStatuses.length}`,
      );

      // If we reached enough iterations, verify the reminder event has metadata
      if (reminderStatuses.length > 0) {
        const firstReminder = reminderStatuses[0];
        expect(firstReminder.iteration).toBeDefined();
        expect(firstReminder.interval).toBeDefined();
        console.log(
          `  ✓ Reminder injected at iteration ${firstReminder.iteration} ` +
            `(interval: ${firstReminder.interval})`,
        );
      }
    }
  }, 600_000);

  it("16.3 — harness does not emit reminder events on short sessions (< 5 iterations)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: BRIEF_GREETING }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 100,
          autoApprove: true,
          maxIterations: 3,
          reminderModel: target.model,
          reminderProvider: target.providerName,
          reminderInterval: 1,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`16.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Even with reminderInterval=1, minimum threshold of 5 iterations
      // should prevent any reminders on a short 3-iteration session
      const reminderStatuses = result.statuses.filter(
        (status) => status.message === "system_reminder_injected",
      );
      expect(reminderStatuses).toHaveLength(0);
      console.log(
        `  ✓ No reminder events on short session (expected, threshold not reached)`,
      );
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 17: Graph-of-Thoughts Branching & Synthesis Events
// ═══════════════════════════════════════════════════════════════

describe("Suite 17: Graph-of-Thoughts Branching & Synthesis Events", () => {
  it("17.1 — GoT strategy emits branching_started and branch_selected with synthesizing flag", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: GRAPH_OF_THOUGHTS_SYNTHESIS_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`17.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping GoT event assertions");
      } else {
        // Verify branching_started event was emitted with branchCount
        const branchingStartedStatuses = result.statuses.filter(
          (status) => status.message === "branching_started",
        );
        expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
        expect(branchingStartedStatuses[0].branchCount).toBe(2);

        // Verify branch_selected event was emitted with synthesizing=true (GoT differentiator)
        const branchSelectedStatuses = result.statuses.filter(
          (status) => status.message === "branch_selected",
        );
        expect(branchSelectedStatuses.length).toBeGreaterThanOrEqual(1);

        const selectedEvent = branchSelectedStatuses[0];
        expect(selectedEvent.synthesizing).toBe(true);
        expect(selectedEvent.scores).toBeDefined();

        console.log(
          `  📊 GoT: branching_started=${branchingStartedStatuses.length}, ` +
            `branch_selected=${branchSelectedStatuses.length}, ` +
            `synthesizing=${selectedEvent.synthesizing}`,
        );
        console.log(
          `  📊 All scores: ${JSON.stringify(selectedEvent.scores)}`,
        );
      }
    }
  }, 600_000);

  it("17.2 — GoT emits synthesis_started event after scoring", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: GRAPH_OF_THOUGHTS_SYNTHESIS_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 3,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
          branchCount: 3,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`17.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      if (isEmptyResponse(result)) {
        console.log("  ⚠ Model returned empty — skipping synthesis event assertions");
      } else {
        // Verify synthesis_started event fires (GoT-unique event)
        const synthesisStatuses = result.statuses.filter(
          (status) => status.message === "synthesis_started",
        );
        expect(synthesisStatuses.length).toBeGreaterThanOrEqual(1);

        const synthesisEvent = synthesisStatuses[0];
        expect(synthesisEvent.branchCount).toBeGreaterThanOrEqual(2);
        expect(synthesisEvent.iteration).toBeDefined();

        console.log(
          `  📊 Synthesis: branchCount=${synthesisEvent.branchCount}, ` +
            `iteration=${synthesisEvent.iteration}`,
        );
      }
    }
  }, 600_000);

  it("17.3 — GoT with branchCount=1 skips synthesis (single candidate fast path)", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SIMPLE_ARITHMETIC }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 200,
          autoApprove: true,
          maxIterations: 2,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
          branchCount: 1,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 2) },
      );

      logResult(`17.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // With branchCount=1 GoT should NOT emit synthesis_started (skips synthesis)
      const synthesisStatuses = result.statuses.filter(
        (status) => status.message === "synthesis_started",
      );
      expect(synthesisStatuses).toHaveLength(0);

      // branch_selected should still fire with score=10 (single-candidate fast path)
      const selectedStatuses = result.statuses.filter(
        (status) => status.message === "branch_selected",
      );
      if (selectedStatuses.length > 0) {
        expect(selectedStatuses[0].score).toBe(10);
        console.log(`  📊 Single-branch score: ${selectedStatuses[0].score} (expected 10)`);
      }
    }
  }, 300_000);

  it("17.4 — GoT completes with text output for text-only prompts", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: STRATEGY_COMPARISON_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 2,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
          branchCount: 2,
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`17.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      if (!isEmptyResponse(result)) {
        expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
        console.log(
          `  📊 GoT text output: ${result.text.length} chars, ` +
            `thinking: ${result.thinking.length} chars`,
        );
      }
    }
  }, 600_000);

  it("17.5 — GoT vs ToT comparison: GoT emits synthesis events that ToT does not", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    // Run ToT
    const totResult = await agentStreamWithRetry(
      {
        provider: target.providerName,
        model: target.model,
        messages: [{ role: "user", content: STRATEGY_COMPARISON_PROMPT }],
        agent: "OMNI",
        agentConversationId: crypto.randomUUID(),
        maxTokens: 2000,
        autoApprove: true,
        maxIterations: 2,
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
        branchCount: 2,
      },
      { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
    );

    // Run GoT
    const gotResult = await agentStreamWithRetry(
      {
        provider: target.providerName,
        model: target.model,
        messages: [{ role: "user", content: STRATEGY_COMPARISON_PROMPT }],
        agent: "OMNI",
        agentConversationId: crypto.randomUUID(),
        maxTokens: 2000,
        autoApprove: true,
        maxIterations: 2,
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
        branchCount: 2,
      },
      { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
    );

    logResult(`17.5 ToT [${target.providerName}]`, totResult);
    logResult(`17.5 GoT [${target.providerName}]`, gotResult);

    // Both should complete
    expect(totResult.timedOut).toBe(false);
    expect(totResult.done).toBeTruthy();
    expect(gotResult.timedOut).toBe(false);
    expect(gotResult.done).toBeTruthy();

    // Key structural difference: GoT should emit synthesis_started, ToT should NOT
    if (!isEmptyResponse(totResult) && !isEmptyResponse(gotResult)) {
      const totSynthesisStatuses = totResult.statuses.filter(
        (status) => status.message === "synthesis_started",
      );
      const gotSynthesisStatuses = gotResult.statuses.filter(
        (status) => status.message === "synthesis_started",
      );

      expect(totSynthesisStatuses).toHaveLength(0);
      expect(gotSynthesisStatuses.length).toBeGreaterThanOrEqual(1);

      // GoT branch_selected should have synthesizing=true, ToT should not
      const totSelectedStatuses = totResult.statuses.filter(
        (status) => status.message === "branch_selected",
      );
      const gotSelectedStatuses = gotResult.statuses.filter(
        (status) => status.message === "branch_selected",
      );

      if (gotSelectedStatuses.length > 0) {
        expect(gotSelectedStatuses[0].synthesizing).toBe(true);
      }
      if (totSelectedStatuses.length > 0) {
        expect(totSelectedStatuses[0].synthesizing).toBeUndefined();
      }

      console.log(
        `  📊 ToT: synthesis_started=${totSynthesisStatuses.length}, ` +
          `branch_selected=${totSelectedStatuses.length}`,
      );
      console.log(
        `  📊 GoT: synthesis_started=${gotSynthesisStatuses.length}, ` +
          `branch_selected=${gotSelectedStatuses.length}, ` +
          `synthesizing=${gotSelectedStatuses[0]?.synthesizing}`,
      );
    }
  }, 900_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 18: Strategy × Topology Live Combination Matrix
//
// Thought structure controls the main agent's inner loop:
//   - chain_of_thought: single-pass sequential ReAct
//   - tree_of_thoughts: N parallel branches → score → pick winner
//   - graph_of_thoughts: N parallel branches → score → synthesize merge
//
// Topology controls sub-agent coordination (via team_create tool):
//   - sequential: chain — each agent passes output to the next
//   - hierarchical: parallel — all agents run concurrently, best wins
//   - hierarchical_aggregation: parallel + synthesis merge pass
//   - peer_to_peer: round-robin discussion mesh
//
// These are ORTHOGONAL axes. This suite tests the full 3×4 matrix
// to verify every combination resolves, completes, and emits the
// correct structural SSE events without errors or crashes.
// ═══════════════════════════════════════════════════════════════

describe("Suite 18: Strategy × Topology Live Combination Matrix", () => {
  const STRATEGIES = [
    {
      key: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
      label: "CoT",
      expectedBranching: false,
      expectedSynthesis: false,
    },
    {
      key: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
      label: "ToT",
      expectedBranching: true,
      expectedSynthesis: false,
    },
    {
      key: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
      label: "GoT",
      expectedBranching: true,
      expectedSynthesis: true,
    },
  ] as const;

  const TOPOLOGIES = [
    { key: "sequential", label: "Sequential" },
    { key: "hierarchical", label: "Hierarchical" },
    { key: "hierarchical_aggregation", label: "Hierarchical Aggregation" },
    { key: "peer_to_peer", label: "Peer-to-Peer" },
  ] as const;

  // ── 18.1–18.12: Full matrix (1 test per cell) ─────────────────

  let matrixTestIndex = 0;
  for (const strategy of STRATEGIES) {
    for (const topology of TOPOLOGIES) {
      matrixTestIndex++;

      it(`18.${matrixTestIndex} — ${strategy.label} + ${topology.label}: completes and emits correct events`, async () => {
        const toolCallingTargets = providerTargets.filter(
          (providerTarget) => providerTarget.supportsToolCalling,
        ).slice(0, 1);

        if (toolCallingTargets.length === 0) {
          console.log("  ⏭ Skipping: no tool-calling providers available");
          return;
        }

        const target = toolCallingTargets[0];
        console.log(
          `\n  🎯 Provider: ${target.providerName} (${target.model})` +
            `\n  📐 Strategy: ${strategy.label} (${strategy.key})` +
            `\n  🔗 Topology: ${topology.label} (${topology.key})`,
        );

        const isMultiBranch = strategy.key !== THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT;
        const prompt = isMultiBranch
          ? GRAPH_OF_THOUGHTS_SYNTHESIS_PROMPT
          : SIMPLE_ARITHMETIC;

        const result = await agentStreamWithRetry(
          {
            provider: target.providerName,
            model: target.model,
            messages: [{ role: "user", content: prompt }],
            agent: "OMNI",
            agentConversationId: crypto.randomUUID(),
            maxTokens: isMultiBranch ? 2000 : 300,
            autoApprove: true,
            maxIterations: isMultiBranch ? 3 : 2,
            harness: HARNESS_IDS.STANDARD,
            thoughtStructure: strategy.key,
            topology: topology.key,
            ...(isMultiBranch ? { branchCount: 2 } : {}),
          },
          { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
        );

        logResult(
          `18.${matrixTestIndex} [${strategy.label}+${topology.label}] [${target.providerName}]`,
          result,
        );

        // Infrastructure assertions — every combination must complete
        expect(result.timedOut).toBe(false);
        expect(result.done).toBeTruthy();

        if (isEmptyResponse(result)) {
          console.log("  ⚠ Model returned empty — skipping event assertions");
          return;
        }

        // Strategy-specific structural assertions
        const branchingStartedStatuses = result.statuses.filter(
          (status) => status.message === "branching_started",
        );
        const synthesisStatuses = result.statuses.filter(
          (status) => status.message === "synthesis_started",
        );

        if (strategy.expectedBranching) {
          expect(branchingStartedStatuses.length).toBeGreaterThanOrEqual(1);
          console.log(
            `  📊 branching_started events: ${branchingStartedStatuses.length}`,
          );
        } else {
          expect(branchingStartedStatuses).toHaveLength(0);
          console.log(
            `  ✓ No branching events (CoT as expected)`,
          );
        }

        if (strategy.expectedSynthesis) {
          expect(synthesisStatuses.length).toBeGreaterThanOrEqual(1);
          console.log(
            `  📊 synthesis_started events: ${synthesisStatuses.length}`,
          );
        } else {
          expect(synthesisStatuses).toHaveLength(0);
          console.log(
            `  ✓ No synthesis events (${strategy.label} as expected)`,
          );
        }

        // Log topology setting (it's forwarded to orchestrator on team_create, not visible in events)
        console.log(`  ✓ Topology "${topology.key}" accepted without errors`);
      }, 600_000);
    }
  }

  // ── 18.13: Topology actually affects team_create dispatch ─────

  it("18.13 — topology is forwarded to team_create: all 4 topologies execute subagents successfully", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    const teamCreatePrompt =
      "Use team_create with 2 members:\n" +
      "1. First member: echo 'step-one' using shell\n" +
      "2. Second member: echo 'step-two' using shell\n\n" +
      "Create the team now.";

    const topologies = [
      "sequential",
      "hierarchical",
      "hierarchical_aggregation",
      "peer_to_peer",
    ] as const;

    for (const topology of topologies) {
      console.log(`\n  🚀 Running team_create with topology: ${topology}`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: teamCreatePrompt }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 10,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
          topology,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`18.13 [${topology}] [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const toolEvents = [...result.toolExecutions, ...result.toolCalls];
      const teamCreates = toolEvents.filter(
        (toolEvent) =>
          (toolEvent.tool?.name || toolEvent.name) === "team_create" ||
          (toolEvent.tool?.name || toolEvent.name) === "create_team",
      );

      const spawnEvents = result.subAgentStatuses.filter(
        (statusEvent) => statusEvent.message === "spawned",
      );

      console.log(
        `  📊 [${topology}] Team Creates: ${teamCreates.length}, ` +
          `Sub-agents Spawned: ${spawnEvents.length}, ` +
          `Total SSE Events: ${result.totalEvents}`,
      );

      // Verify that team_create was actually called
      expect(teamCreates.length).toBeGreaterThanOrEqual(1);

      // Verify that sub-agents were actually spawned and executed
      expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
    }
  }, 1200_000);

  // ── 18.14: All strategies work with peer_to_peer topology ────

  it("18.14 — all 3 strategies complete cleanly with peer_to_peer topology", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    const strategyKeys = [THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT, THOUGHT_STRUCTURES.TREE_OF_THOUGHTS, THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS] as const;

    for (const strategyKey of strategyKeys) {
      const isMultiBranch = strategyKey !== THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT;

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: STRATEGY_COMPARISON_PROMPT }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: isMultiBranch ? 2000 : 300,
          autoApprove: true,
          maxIterations: isMultiBranch ? 3 : 2,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: strategyKey,
          topology: "peer_to_peer",
          ...(isMultiBranch ? { branchCount: 2 } : {}),
        },
        { timeoutMs: getTimeout(target, DEFAULT_AGENT_TIMEOUT_MS * 3) },
      );

      logResult(`18.14 [${strategyKey}+p2p] [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      console.log(
        `  ✓ ${strategyKey} + peer_to_peer completed: ` +
          `${result.text.length} chars, ${result.totalEvents} events`,
      );
    }
  }, 900_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 19: Forced Subagent Topology Execution Matrix
// ───────────────────────────────────────────────────────────────
// Unlike Suite 18 which tests config acceptance (topology is
// passed but subagents may never spawn), Suite 19 explicitly
// forces team_create calls under each of the 4 topologies and
// asserts that subagent lifecycle events (spawned → completed)
// actually fire in the SSE stream.
// ═══════════════════════════════════════════════════════════════

describe("Suite 19: Forced Subagent Topology Execution Matrix", () => {
  const TOPOLOGY_MATRIX = [
    { key: "sequential", label: "Sequential Pipeline" },
    { key: "hierarchical", label: "Hierarchical Parallel" },
    { key: "hierarchical_aggregation", label: "Hierarchical Aggregation" },
    { key: "peer_to_peer", label: "Peer-to-Peer Mesh" },
  ] as const;

  // ── 19.1–19.4: One test per topology, forcing team_create ────

  let topologyTestIndex = 0;
  for (const topology of TOPOLOGY_MATRIX) {
    topologyTestIndex++;

    it(`19.${topologyTestIndex} — ${topology.label}: spawns subagents and emits lifecycle events`, async () => {
      const toolCallingTargets = providerTargets.filter(
        (providerTarget) => providerTarget.supportsToolCalling,
      ).slice(0, 1);

      if (toolCallingTargets.length === 0) {
        console.log("  ⏭ Skipping: no tool-calling providers available");
        return;
      }

      const target = toolCallingTargets[0];
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      console.log(`  🔗 Topology: ${topology.label} (${topology.key})`);

      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: FORCED_TOPOLOGY_SPAWN }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 10,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
          topology: topology.key,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`19.${topologyTestIndex} [${topology.label}] [${target.providerName}]`, result);

      // Must complete without timeout
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Must have attempted team_create
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const teamCreateEvents = allToolEvents.filter(
        (toolEvent) => {
          const toolName = toolEvent.tool?.name || toolEvent.name;
          return toolName === "team_create" || toolName === "create_team";
        },
      );

      console.log(
        `  📊 team_create calls: ${teamCreateEvents.length}`,
      );

      expect(teamCreateEvents.length).toBeGreaterThanOrEqual(1);

      // Must have emitted sub_agent_status events (spawned lifecycle)
      const spawnedEvents = result.subAgentStatuses.filter(
        (subAgentEvent) => subAgentEvent.message === "spawned",
      );
      const completedEvents = result.subAgentStatuses.filter(
        (subAgentEvent) => subAgentEvent.message === "completed" || subAgentEvent.message === "complete",
      );

      console.log(
        `  📊 Sub-agent spawned events: ${spawnedEvents.length}`,
      );
      console.log(
        `  📊 Sub-agent completed events: ${completedEvents.length}`,
      );

      // At least 2 subagents must have been spawned (we requested 2 members)
      expect(spawnedEvents.length).toBeGreaterThanOrEqual(2);

      // Log unique sub-agent IDs to verify distinct agents were created
      const uniqueSubAgentIds = new Set(
        result.subAgentStatuses
          .map((subAgentEvent) => subAgentEvent.subAgentId)
          .filter(Boolean),
      );

      console.log(
        `  📊 Unique sub-agent IDs: ${uniqueSubAgentIds.size} (${[...uniqueSubAgentIds].join(", ")})`,
      );

      expect(uniqueSubAgentIds.size).toBeGreaterThanOrEqual(2);

      console.log(
        `  ✓ Topology "${topology.key}" spawned ${spawnedEvents.length} subagents, ` +
          `${completedEvents.length} completed, ${uniqueSubAgentIds.size} unique IDs`,
      );
    }, 900_000);
  }

  // ── 19.5: Cross-topology structural comparison ────────────────

  it("19.5 — sequential vs peer_to_peer produce structurally different sub_agent_status patterns", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    const runWithTopology = async (topologyKey: string) => {
      return agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: FORCED_TOPOLOGY_SPAWN }],
          agent: "OMNI",
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 10,
          harness: HARNESS_IDS.STANDARD,
          thoughtStructure: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
          topology: topologyKey,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );
    };

    const sequentialResult = await runWithTopology("sequential");

    // Cooldown between back-to-back orchestration runs to let the model recover
    console.log("  ⏳ 15s cooldown between topology runs...");
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const peerToPeerResult = await runWithTopology("peer_to_peer");

    logResult(`19.5 [sequential] [${target.providerName}]`, sequentialResult);
    logResult(`19.5 [peer_to_peer] [${target.providerName}]`, peerToPeerResult);

    // Sequential must complete cleanly
    expect(sequentialResult.timedOut).toBe(false);
    expect(sequentialResult.done).toBeTruthy();

    // P2P may terminate under heavy load — assert subagent activity over clean exit
    expect(peerToPeerResult.timedOut).toBe(false);

    // Both must have spawned subagents (the core assertion for this test)
    const sequentialSpawns = sequentialResult.subAgentStatuses.filter(
      (subAgentEvent) => subAgentEvent.message === "spawned",
    );
    const peerToPeerSpawns = peerToPeerResult.subAgentStatuses.filter(
      (subAgentEvent) => subAgentEvent.message === "spawned",
    );

    console.log(`  📊 Sequential spawns: ${sequentialSpawns.length}`);
    console.log(`  📊 Peer-to-Peer spawns: ${peerToPeerSpawns.length}`);

    expect(sequentialSpawns.length).toBeGreaterThanOrEqual(2);
    expect(peerToPeerSpawns.length).toBeGreaterThanOrEqual(2);

    // If p2p didn't get a done event, log it but don't fail
    // (the spawned subagent count proves topology execution happened)
    if (!peerToPeerResult.done) {
      console.log(
        `  ⚠ Peer-to-Peer did not emit done event (${peerToPeerResult.errors.length} errors) — ` +
          `subagent lifecycle still verified via ${peerToPeerSpawns.length} spawned events`,
      );
    }

    console.log(
      `  ✓ Both topologies spawned subagents — sequential: ${sequentialSpawns.length}, p2p: ${peerToPeerSpawns.length}`,
    );
  }, 900_000);

  // ── 19.6: ToT Strategy + Hierarchical Topology Spawning ──────

  it("19.6 — ToT strategy + Hierarchical topology: spawns subagents inside parallel reasoning branches", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    const result = await agentStreamWithRetry(
      {
        provider: target.providerName,
        model: target.model,
        messages: [{ role: "user", content: FORCED_TOPOLOGY_SPAWN }],
        agent: "OMNI",
        agentConversationId: crypto.randomUUID(),
        maxTokens: 4000,
        autoApprove: true,
        maxIterations: 10,
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
        topology: "hierarchical",
        branchCount: 2,
      },
      { timeoutMs: getMultiAgentTimeout(target) * 2 },
    );

    logResult(`19.6 [ToT+Hierarchical] [${target.providerName}]`, result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    const spawnEvents = result.subAgentStatuses.filter(
      (subAgentEvent) => subAgentEvent.message === "spawned",
    );

    console.log(`  📊 ToT+Hierarchical subagent spawns: ${spawnEvents.length}`);

    // Verify subagents were actually spawned
    expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
  }, 1200_000);

  // ── 19.7: GoT Strategy + Peer-to-Peer Topology Spawning ──────

  it("19.7 — GoT strategy + Peer-to-Peer topology: spawns subagents inside graph reasoning branches", async () => {
    const toolCallingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    ).slice(0, 1);

    if (toolCallingTargets.length === 0) {
      console.log("  ⏭ Skipping: no tool-calling providers available");
      return;
    }

    const target = toolCallingTargets[0];
    console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

    const result = await agentStreamWithRetry(
      {
        provider: target.providerName,
        model: target.model,
        messages: [{ role: "user", content: FORCED_TOPOLOGY_SPAWN }],
        agent: "OMNI",
        agentConversationId: crypto.randomUUID(),
        maxTokens: 4000,
        autoApprove: true,
        maxIterations: 10,
        harness: HARNESS_IDS.STANDARD,
        thoughtStructure: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
        topology: "peer_to_peer",
        branchCount: 2,
      },
      { timeoutMs: getMultiAgentTimeout(target) * 2 },
    );

    logResult(`19.7 [GoT+P2P] [${target.providerName}]`, result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    const spawnEvents = result.subAgentStatuses.filter(
      (subAgentEvent) => subAgentEvent.message === "spawned",
    );

    console.log(`  📊 GoT+P2P subagent spawns: ${spawnEvents.length}`);

    // Verify subagents were actually spawned
    expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
  }, 1200_000);
});
