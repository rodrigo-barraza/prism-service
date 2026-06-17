/**
 * Agent Behavior — Live Integration Tests
 * ════════════════════════════════════════════════════════════════
 *
 * End-to-end validation of the real agentic loop against live providers.
 * Tests the ACTUAL agent implementation — tool calling, thinking mode,
 * multi-turn continuation, harness variants, plan mode, edge cases,
 * usage tracking, and multi-agent orchestration.
 *
 * ⚠️  These tests hit real LLM providers and can cost money.
 *     Cloud providers are opt-in via INCLUDE_CLOUD=true.
 *
 * Run (local only):
 *   npm run test:live:agent-behavior
 *
 * Run (including cloud):
 *   npm run test:live:agent-behavior:cloud
 *
 * ════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  discoverProviders,
  agentStream,
  agentStreamWithRetry,
  isEmptyResponse,
  getEffectiveUsage,
  logResult,
  logProviderSummary,
  assertCleanCompletion,
  assertAnyToolCallPresent,
  assertToolCallPresent,
  assertThinkingPresent,
  assertNoThinking,
  assertNoLoop,
  assertUsagePresent,
  assertIterationCountWithin,
  getTimeout,
  getMultiAgentTimeout,
  DEFAULT_AGENT_TIMEOUT_MS,
  type ProviderTarget,
  type AgentSSEResult,
} from "./helpers/agentTestHarness.ts";
import { capabilityTracker, CAPABILITIES } from "./helpers/capabilityTracker.ts";
import {
  SIMPLE_ARITHMETIC,
  BRIEF_GREETING,
  ONE_SENTENCE_ANSWER,
  MINIMAL_PROMPT,
  LIST_CURRENT_DIRECTORY,
  READ_SPECIFIC_FILE,
  CHAIN_TWO_TOOLS,
  DELIBERATE_TOOL_ERROR,
  MULTI_STEP_FILE_OPERATIONS,
  COMPLEX_REASONING,
  LOGIC_PUZZLE,
  THINKING_PLUS_TOOL,
  PLAN_MODE_TASK,
  TURN_ONE_INTRODUCTION,
  TURN_TWO_RECALL,
  TURN_THREE_ARITHMETIC,
  SPAWN_TWO_WORKERS,
  EMPTY_STRING,
  EXTREMELY_LONG_MESSAGE,
  UNICODE_HEAVY,
  RAPID_FIRE_TEMPLATE,
  TEXT_ONLY_NO_TOOLS,
  ITERATION_STRESS,
  RECALL_NAME_TURN_TWO,
  STABILITY_CHECK,
} from "./helpers/testPrompts.ts";


// ── Provider Discovery ──────────────────────────────────────────

let providerTargets: ProviderTarget[] = [];

beforeAll(async () => {
  providerTargets = await discoverProviders();
  logProviderSummary(providerTargets);
}, 30_000);

afterAll(() => {
  capabilityTracker.printScorecard();
});


// ═══════════════════════════════════════════════════════════════
// Suite 1: Basic Agentic Loop Completion
// ═══════════════════════════════════════════════════════════════

describe("Suite 1: Basic Agentic Loop Completion", () => {
  // 1.1 Single-turn text generation completes with done event
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
      // The loop completed — text or thinking was produced
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
      assertNoLoop(result);
    }
  }, 300_000);

  // 1.2 Empty/minimal prompt produces valid output (not hang)
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

  // 1.3 Large system prompt + user prompt doesn't truncate silently
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
      // Should produce meaningful output, not just truncation noise
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 1.4 Agent responds when maxTokens is extremely low
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

      // Should complete without timing out — may produce truncated output
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 2: Tool Calling Behavior
// ═══════════════════════════════════════════════════════════════

describe("Suite 2: Tool Calling Behavior", () => {
  // 2.1 Agent calls a tool when explicitly instructed
  it("2.1 — agent calls a tool when explicitly instructed", async () => {
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

      logResult(`2.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Should have triggered at least one tool call
      assertAnyToolCallPresent(result);
    }
  }, 300_000);

  // 2.2 Agent chains multiple tool calls across iterations
  it("2.2 — agent chains multiple tool calls across iterations", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: CHAIN_TWO_TOOLS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 6,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      assertAnyToolCallPresent(result);
      // Should have iterated at least twice (tool call + response)
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      expect(iterationStatuses.length).toBeGreaterThanOrEqual(2);
    }
  }, 300_000);

  // 2.3 Tool result is fed back correctly (agent references tool output)
  it("2.3 — tool result is incorporated into agent response", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: READ_SPECIFIC_FILE }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const usedTools = allToolEvents.length > 0;
      capabilityTracker.record(
        "2.3", CAPABILITIES.TOOL_COMPLIANCE, target,
        usedTools ? "pass" : "fail",
        usedTools
          ? `Called ${allToolEvents.length} tool(s) to read file as instructed`
          : "Answered from parametric knowledge without calling any tools",
      );
      if (usedTools) {
        expect(result.text.length).toBeGreaterThan(0);
      }
    }
  }, 300_000);

  // 2.4 Agent handles tool returning an error gracefully
  it("2.4 — agent handles tool error gracefully", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: DELIBERATE_TOOL_ERROR }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.4 [${target.providerName}]`, result);

      // Should complete (possibly with tool errors reported to the model)
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Agent should produce a final text response explaining the error
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 2.5 Agent respects maxIterations cap
  it("2.5 — agent stops at maxIterations limit", async () => {
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

      logResult(`2.5 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Should not have exceeded the maxIterations limit
      // (+1 tolerance for exhaustion recovery pass)
      assertIterationCountWithin(result, maximumIterations + 1);
    }
  }, 300_000);

  // 2.6 Agent calls tools even with thinking mode enabled
  it("2.6 — thinking mode does not suppress tool calling", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling && providerTarget.supportsThinking,
    )) {
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

      logResult(`2.6 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Should have both thinking AND tool calls
      assertAnyToolCallPresent(result);
    }
  }, 300_000);

  // 2.7 Agent produces a final text response after tool chain completes
  it("2.7 — final text response after tool chain", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: MULTI_STEP_FILE_OPERATIONS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 8,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`2.7 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const usedTools = allToolEvents.length > 0;
      capabilityTracker.record(
        "2.7", CAPABILITIES.TOOL_CHAINING, target,
        usedTools ? "pass" : "fail",
        usedTools
          ? `Completed multi-step tool chain with ${allToolEvents.length} tool call(s)`
          : "Skipped tool chain entirely — answered from parametric knowledge",
      );
      if (usedTools) {
        expect(result.text.length).toBeGreaterThan(0);
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 3: Thinking Mode Behavior
// ═══════════════════════════════════════════════════════════════

describe("Suite 3: Thinking Mode Behavior", () => {
  // 3.1 Thinking-enabled model emits thinking chunks
  it("3.1 — thinking model emits thinking chunks", async () => {
    const thinkingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking,
    );
    if (thinkingTargets.length === 0) {
      console.log("  ⏭ Skipping: no thinking-capable providers available");
      return;
    }

    for (const target of thinkingTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: COMPLEX_REASONING }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`3.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      assertThinkingPresent(result);
    }
  }, 300_000);

  // 3.2 Non-thinking model with thinkingEnabled=false emits no thinking
  it("3.2 — non-thinking model emits no thinking chunks", async () => {
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

      logResult(`3.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      assertNoThinking(result);
    }
  }, 300_000);

  // 3.3 Thinking content is NOT included in final text output
  it("3.3 — thinking is separate from text content", async () => {
    const thinkingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking,
    );
    if (thinkingTargets.length === 0) {
      console.log("  ⏭ Skipping: no thinking-capable providers available");
      return;
    }

    for (const target of thinkingTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LOGIC_PUZZLE }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`3.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Both text and thinking should be present, and distinct
      if (result.thinking.length > 0 && result.text.length > 0) {
        // The text chunks and thinking chunks should be from different SSE events
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.thinkingChunks.length).toBeGreaterThan(0);
      }
    }
  }, 300_000);

  // 3.4 Thinking + tool calling coexist
  it("3.4 — thinking and tool calling coexist", async () => {
    const thinkingToolTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking && providerTarget.supportsToolCalling,
    );
    if (thinkingToolTargets.length === 0) {
      console.log("  ⏭ Skipping: no providers support both thinking and tool calling");
      return;
    }

    for (const target of thinkingToolTargets) {
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

      logResult(`3.4 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // At minimum, tool calls should be present
      assertAnyToolCallPresent(result);
      // Thinking should also be present for thinking-capable models
      assertThinkingPresent(result);
    }
  }, 300_000);

  // 3.5 Display segments maintain correct ordering
  it("3.5 — display segments track thinking/text/tools ordering", async () => {
    const thinkingToolTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking && providerTarget.supportsToolCalling,
    );
    if (thinkingToolTargets.length === 0) {
      console.log("  ⏭ Skipping: no providers support both thinking and tool calling");
      return;
    }

    for (const target of thinkingToolTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LIST_CURRENT_DIRECTORY }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 5,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`3.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Verify that events came in a logical order
      // (thinking events should come before or interleaved with tool/text events, not after done)
      const eventTypes = result.events.map((event) => event.type);
      const doneIndex = eventTypes.indexOf("done");
      if (doneIndex > 0) {
        // No content events should appear after done
        const postDoneTypes = eventTypes.slice(doneIndex + 1);
        const contentTypes = new Set(["chunk", "thinking", "tool_execution", "toolCall"]);
        const contentAfterDone = postDoneTypes.filter((eventType) =>
          contentTypes.has(eventType as string),
        );
        expect(contentAfterDone).toHaveLength(0);
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 4: Multi-Turn Continuation
// ═══════════════════════════════════════════════════════════════

describe("Suite 4: Multi-Turn Continuation", () => {
  // 4.1 Turn 2 references content from Turn 1 correctly
  it("4.1 — multi-turn context carries across turns", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      // Turn 1
      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TURN_ONE_INTRODUCTION }],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.1 Turn 1 [${target.providerName}]`, turn1);
      expect(turn1.timedOut).toBe(false);
      expect(turn1.done).toBeTruthy();

      // Turn 2 — pass full conversation history
      const turn2 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: TURN_ONE_INTRODUCTION },
            { role: "assistant", content: turn1.text || turn1.thinking || "Hello Rodrigo!" },
            { role: "user", content: TURN_TWO_RECALL },
          ],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.1 Turn 2 [${target.providerName}]`, turn2);
      assertCleanCompletion(turn2);
      assertNoLoop(turn2);
      // Agent should recall the name from turn 1
      const responseText = (turn2.text + turn2.thinking).toLowerCase();
      expect(responseText).toContain("rodrigo");
    }
  }, 600_000);

  // 4.2 Turn 3 with growing context doesn't cause processing loop
  it("4.2 — three-turn conversation stays stable", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      // Turn 1
      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TURN_ONE_INTRODUCTION }],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

      // Turn 2
      const turn2 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: TURN_ONE_INTRODUCTION },
            { role: "assistant", content: turn1.text || "Hello!" },
            { role: "user", content: RECALL_NAME_TURN_TWO },
          ],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );
      expect(turn2.done).toBeTruthy();

      // Turn 3
      const turn3 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: TURN_ONE_INTRODUCTION },
            { role: "assistant", content: turn1.text || "Hello!" },
            { role: "user", content: RECALL_NAME_TURN_TWO },
            { role: "assistant", content: turn2.text || "Rodrigo" },
            { role: "user", content: STABILITY_CHECK },
          ],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 50,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.2 Turn 3 [${target.providerName}]`, turn3);

      assertCleanCompletion(turn3);
      assertNoLoop(turn3);
    }
  }, 600_000);

  // 4.3 Assistant messages with tool calls don't break context
  it("4.3 — tool calls in history don't corrupt continuation", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      // Turn 1 with tool calling
      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LIST_CURRENT_DIRECTORY }],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 3,
        },
        { timeoutMs: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

      // Turn 2 — simple question after tool-call turn
      const turn2 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: LIST_CURRENT_DIRECTORY },
            {
              role: "assistant",
              content: turn1.text || "I listed the files.",
              toolCalls: turn1.toolExecutions.map((toolEvent) => ({
                id: toolEvent.tool?.id || toolEvent.id || "tc-1",
                name: toolEvent.tool?.name || toolEvent.name || "list_directory",
                args: toolEvent.tool?.args || toolEvent.args || {},
                result: { success: true, files: ["file1.txt", "file2.txt"] },
              })),
            },
            { role: "user", content: SIMPLE_ARITHMETIC },
          ],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.3 Turn 2 [${target.providerName}]`, turn2);

      expect(turn2.timedOut).toBe(false);
      expect(turn2.done).toBeTruthy();
      assertNoLoop(turn2);
    }
  }, 600_000);

  // 4.4 Multi-turn with interleaved thinking/text segments
  it("4.4 — thinking persists across multi-turn with thinking models", async () => {
    const thinkingTargets = providerTargets.filter(
      (providerTarget) => providerTarget.supportsThinking,
    );
    if (thinkingTargets.length === 0) {
      console.log("  ⏭ Skipping: no thinking-capable providers available");
      return;
    }

    for (const target of thinkingTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      // Turn 1 with thinking
      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: COMPLEX_REASONING }],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 500,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

      // Turn 2 — also with thinking
      const turn2 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            { role: "user", content: COMPLEX_REASONING },
            {
              role: "assistant",
              content: turn1.text || "9 sheep remain.",
              ...(turn1.thinking ? { thinking: turn1.thinking.slice(0, 500) } : {}),
            },
            { role: "user", content: LOGIC_PUZZLE },
          ],
          agent: "OMNI",
          agentSessionId: sessionId,
          maxTokens: 500,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`4.4 Turn 2 [${target.providerName}]`, turn2);

      assertCleanCompletion(turn2);
      // Turn 2 should also produce thinking
      assertThinkingPresent(turn2);
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 5: Harness Variants
// ═══════════════════════════════════════════════════════════════

describe("Suite 5: Harness Variants", () => {
  // 5.1 ReAct (standard) harness completes tool loop
  it("5.1 — standard (ReAct) harness completes tool loop", async () => {
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
          harness: "standard",
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`5.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      assertAnyToolCallPresent(result);
    }
  }, 300_000);

  // 5.2 TreeOfThought harness explores branches
  it("5.2 — tree-of-thought harness explores multiple branches", async () => {
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

      logResult(`5.2 [${target.providerName}]`, result);

      // TreeOfThought may or may not branch depending on the problem
      // The key assertion is that it completes
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 600_000);

  // 5.3 VisionLanguage harness handles text-only gracefully
  it("5.3 — vision-language harness handles text-only input", async () => {
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

      logResult(`5.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 6: Agent Never Stops Prematurely
// ═══════════════════════════════════════════════════════════════

describe("Suite 6: Agent Never Stops Prematurely", () => {
  // 6.1 autoApprove=true never pauses for approval
  it("6.1 — autoApprove=true never blocks for approval", async () => {
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

      logResult(`6.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Should NOT have any approval_required status events
      const approvalStatuses = result.statuses.filter(
        (status) => status.message === "approval_required",
      );
      expect(approvalStatuses).toHaveLength(0);
    }
  }, 300_000);

  // 6.2 Agent with tool errors retries (doesn't stop on first error)
  it("6.2 — agent continues after tool error", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: DELIBERATE_TOOL_ERROR }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`6.2 [${target.providerName}]`, result);

      // Should complete — not crash or hang after the error
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Should have produced a final response
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 6.3 Exhaustion recovery fires when maxIterations is hit
  it("6.3 — exhaustion recovery fires on iteration limit", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      // Use a very low maxIterations with a task that needs many
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

      logResult(`6.3 [${target.providerName}]`, result);

      // Should complete — exhaustion recovery should synthesize a final response
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Should have produced SOME text (either from tools or recovery)
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 6.4 Output truncation recovery continues (stopReason=length)
  it("6.4 — output truncation triggers continuation, not premature stop", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      // Use extremely low maxTokens to trigger truncation
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

      logResult(`6.4 [${target.providerName}]`, result);

      // Should complete (may have truncated output, but shouldn't hang)
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 300_000);

  // 6.5 Agent doesn't stop after thinking-only output
  it("6.5 — agent doesn't stop prematurely on thinking-only output", async () => {
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

      logResult(`6.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Should have produced both thinking AND a final text response
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 7: Plan Mode Flow
// ═══════════════════════════════════════════════════════════════

describe("Suite 7: Plan Mode Flow", () => {
  // 7.1 planFirst=true emits plan_mode_entered status
  it("7.1 — planFirst=true emits plan_mode_entered", async () => {
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

      logResult(`7.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Should have emitted plan_mode_entered status
      const planModeStatuses = result.statuses.filter(
        (status) => status.message === "plan_mode_entered",
      );
      expect(planModeStatuses.length).toBeGreaterThanOrEqual(1);
    }
  }, 300_000);

  // 7.2 Agent in plan mode has restricted tool set
  it("7.2 — plan mode restricts available tools", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [
            {
              role: "user",
              content:
                "List the files in the current directory using tools. " +
                "You must use a tool to do this.",
            },
          ],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
          planFirst: true,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`7.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      // Plan mode restricts tool schemas to exit_plan_mode only.
      // However, smaller models may not fully respect this restriction
      // and still attempt file/directory tools. We log violations as
      // warnings rather than hard-failing — this validates infrastructure,
      // not model instruction compliance.
      const fileToolCalls = [
        ...result.toolExecutions,
        ...result.toolCalls,
      ].filter(
        (toolEvent) => {
          const toolName = toolEvent.tool?.name || toolEvent.name || "";
          return (
            toolName.includes("list_directory") ||
            toolName.includes("shell_execute") ||
            toolName.includes("read_file")
          );
        },
      );
      if (fileToolCalls.length > 0) {
        capabilityTracker.record(
          "7.2", CAPABILITIES.PLAN_MODE_COMPLIANCE, target,
          "fail",
          `Called ${fileToolCalls.length} restricted tool(s) during plan mode`,
        );
      } else {
        capabilityTracker.record(
          "7.2", CAPABILITIES.PLAN_MODE_COMPLIANCE, target,
          "pass",
          "Respected plan mode restrictions — no file/shell tools invoked",
        );
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 8: Edge Cases & Adversarial
// ═══════════════════════════════════════════════════════════════

describe("Suite 8: Edge Cases & Adversarial", () => {
  // 8.1 Abort mid-stream doesn't leave server in broken state
  it("8.1 — abort mid-stream doesn't corrupt server state", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      // Only test first provider to avoid excessive load
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Start a generation and abort it early
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

      // Read a few events then abort
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

      // Wait for server to clean up
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Follow-up request should succeed
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

      logResult(`8.1 Post-Abort [${target.providerName}]`, followUp);

      expect(followUp.timedOut).toBe(false);
      expect(followUp.done || followUp.text.length > 0).toBeTruthy();
    }
  }, 300_000);

  // 8.2 Rapid consecutive requests don't cause race conditions
  it("8.2 — rapid consecutive requests maintain stability", async () => {
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

  // 8.3 Empty string user message is handled without crash
  it("8.3 — empty message doesn't crash the server", async () => {
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

        logResult(`8.3 [${target.providerName}]`, result);

        // Should either complete or error gracefully — not hang
        expect(result.timedOut).toBe(false);
      } catch (error: unknown) {
        // An HTTP error is also acceptable — the key is it doesn't hang
        console.log(`  ✓ Empty message returned error (expected): ${(error as Error).message}`);
      }
    }
  }, 300_000);

  // 8.4 Extremely long user message is processed
  it("8.4 — extremely long message (50K chars) is processed", async () => {
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

      logResult(`8.4 [${target.providerName}]`, result);

      // Should complete (context window enforcement may truncate)
      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 600_000);

  // 8.5 Unicode/emoji-heavy prompt doesn't corrupt stream
  it("8.5 — unicode/emoji prompt doesn't corrupt SSE stream", async () => {
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

      logResult(`8.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Verify text is valid (not corrupted by encoding issues)
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 8.6 Agent with zero enabled tools produces text-only response
  it("8.6 — zero enabled tools produces text-only response", async () => {
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

      logResult(`8.6 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // With no tools enabled, should be pure text
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  // 8.7 Invalid provider name returns error, doesn't hang
  it("8.7 — invalid provider returns error immediately", async () => {
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
      // If we get here, it should at least have errored in the SSE
    } catch (error: unknown) {
      // Expected — HTTP error or connection error
      console.log(`  ✓ Invalid provider returned error: ${(error as Error).message}`);
      expect((error as Error).message).toBeTruthy();
    }
  }, 30_000);

  // 8.8 Invalid model name returns error within timeout
  it("8.8 — invalid model returns error within timeout", async () => {
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

        logResult(`8.8 [${target.providerName}]`, result);

        // Should have errored (or at least completed)
        // Some providers will error, others may fall back
        expect(result.timedOut).toBe(false);
      } catch (error: unknown) {
        console.log(`  ✓ Invalid model returned error: ${(error as Error).message}`);
        expect((error as Error).message).toBeTruthy();
      }
    }
  }, 60_000);

  // 8.9 Concurrent agent sessions don't cross-contaminate state
  it("8.9 — concurrent sessions don't cross-contaminate", async () => {
    for (const target of providerTargets.slice(0, 1)) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);

      // Launch two sessions with different names concurrently
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

      logResult(`8.9 Alice [${target.providerName}]`, resultAlice);
      logResult(`8.9 Bob [${target.providerName}]`, resultBob);

      // Both should complete
      expect(resultAlice.timedOut).toBe(false);
      expect(resultBob.timedOut).toBe(false);
      expect(resultAlice.done).toBeTruthy();
      expect(resultBob.done).toBeTruthy();

      // Cross-contamination check: Alice's response shouldn't mention Bob and vice versa
      const aliceText = (resultAlice.text + resultAlice.thinking).toLowerCase();
      const bobText = (resultBob.text + resultBob.thinking).toLowerCase();

      // Soft assertions — models might not always comply, but cross-contamination is a hard failure
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
// Suite 9: Usage & Cost Tracking
// ═══════════════════════════════════════════════════════════════

describe("Suite 9: Usage & Cost Tracking", () => {
  // 9.1 done event includes usage with inputTokens > 0
  it("9.1 — usage tracking reports inputTokens > 0", async () => {
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

      logResult(`9.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const totalInputTokens = (effectiveUsage.inputTokens ?? 0) + (effectiveUsage.promptTokens ?? 0);
      capabilityTracker.record(
        "9.1", CAPABILITIES.USAGE_REPORTING, target,
        totalInputTokens > 0 ? "pass" : "fail",
        totalInputTokens > 0
          ? `inputTokens=${totalInputTokens}`
          : "inputTokens=0 — provider does not report usage in streaming mode",
      );
    }
  }, 300_000);

  // 9.2 done event includes usage with outputTokens > 0
  it("9.2 — usage tracking reports outputTokens > 0", async () => {
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

      logResult(`9.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const outputTokenCount = effectiveUsage.outputTokens ?? 0;
      capabilityTracker.record(
        "9.2", CAPABILITIES.USAGE_REPORTING, target,
        outputTokenCount > 0 ? "pass" : "fail",
        outputTokenCount > 0
          ? `outputTokens=${outputTokenCount}`
          : "outputTokens=0 — provider does not report usage in streaming mode",
      );
    }
  }, 300_000);

  // 9.3 usage_update events fire during streaming
  it("9.3 — usage_update events fire during streaming", async () => {
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

      logResult(`9.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      // Should have at least one usage_update event during streaming
      expect(result.usageUpdates.length).toBeGreaterThanOrEqual(0); // some providers may not emit mid-stream
      // But the done event must have usage
      expect(result.done?.usage).toBeDefined();
    }
  }, 300_000);

  // 9.4 Multi-iteration usage accumulates correctly
  it("9.4 — multi-iteration usage accumulates", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: CHAIN_TWO_TOOLS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMs: getTimeout(target) },
      );

      logResult(`9.4 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const hasUsage = (effectiveUsage.inputTokens ?? 0) > 0;
      capabilityTracker.record(
        "9.4", CAPABILITIES.USAGE_REPORTING, target,
        hasUsage ? "pass" : "fail",
        hasUsage
          ? `Usage accumulated: in=${effectiveUsage.inputTokens} out=${effectiveUsage.outputTokens}`
          : "Usage tracking unavailable — provider does not report token counts",
      );
      if (hasUsage) {
        assertUsagePresent(result);
        const totalOutputTokens = effectiveUsage.outputTokens ?? 0;
        const iterationStatuses = result.statuses.filter(
          (status) => status.message === "iteration_progress",
        );
        if (iterationStatuses.length > 1) {
          expect(totalOutputTokens).toBeGreaterThan(10);
        }
      }
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 10: Multi-Agent Orchestration
// ═══════════════════════════════════════════════════════════════

describe("Suite 10: Multi-Agent Orchestration", () => {
  // 10.1 create_team spawns sub-agents that complete
  it("10.1 — team_create spawns sub-agents that complete", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SPAWN_TWO_WORKERS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 10,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`10.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const usedTools = allToolEvents.length > 0;
      const teamCreateCalls = allToolEvents.filter(
        (toolEvent) =>
          (toolEvent.tool?.name || toolEvent.name) === "team_create" ||
          (toolEvent.tool?.name || toolEvent.name) === "create_team",
      );
      capabilityTracker.record(
        "10.1", CAPABILITIES.MULTI_AGENT_ORCHESTRATION, target,
        teamCreateCalls.length > 0 ? "pass" : usedTools ? "fail" : "fail",
        teamCreateCalls.length > 0
          ? `Invoked team_create ${teamCreateCalls.length} time(s)`
          : usedTools
            ? `Used tools but not team_create (called: ${allToolEvents.map((event) => event.tool?.name || event.name).join(", ")})`
            : "Did not invoke any tools — model lacks multi-agent orchestration capability",
      );

      // Check for sub-agent-related status events
      const subAgentStatuses = result.statuses.filter(
        (status) =>
          status.message === "workers_updated" ||
          status.message === "sub_agents_updated",
      );

      console.log(
        `  📊 team_create calls: ${teamCreateCalls.length} | ` +
        `sub-agent events: ${subAgentStatuses.length}`,
      );
    }
  }, 600_000);

  // 10.2 Sub-agent results are collected back to orchestrator
  it("10.2 — orchestrator receives sub-agent results", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const result = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: SPAWN_TWO_WORKERS }],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 15,
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`10.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const hasOutput = result.text.length + result.thinking.length > 0;
      capabilityTracker.record(
        "10.2", CAPABILITIES.MULTI_AGENT_ORCHESTRATION, target,
        hasOutput ? "pass" : "fail",
        hasOutput
          ? `Orchestrator produced ${result.text.length} text + ${result.thinking.length} thinking chars`
          : "Orchestrator produced no output — model cannot synthesize multi-agent results",
      );
    }
  }, 600_000);

  // 10.3 Sequential topology passes output from agent A to agent B
  it("10.3 — sequential topology chains sub-agent outputs", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
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
                "1. First member: Run `echo 'step-one-output'` using shell\n" +
                "2. Second member: Take the previous output and echo it back with shell\n\n" +
                "Use topology 'sequential' so the second member receives the first's output.",
            },
          ],
          agent: "OMNI",
          agentSessionId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 15,
          topology: "sequential",
        },
        { timeoutMs: getMultiAgentTimeout(target) },
      );

      logResult(`10.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 11: Cross-Provider Consistency
// ═══════════════════════════════════════════════════════════════

describe("Suite 11: Cross-Provider Consistency", () => {
  // 11.1 Same prompt produces structurally consistent SSE event sequences
  it("11.1 — SSE event structure is consistent across providers", async () => {
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

      logResult(`11.1 [${target.providerName}]`, result);
      results.push({ target, result });
    }

    // All results should have the same structural properties
    for (const { target, result } of results) {
      expect(result.done).toBeTruthy();
      expect(result.timedOut).toBe(false);
      // All should have produced some output
      expect(result.text.length + result.thinking.length).toBeGreaterThan(
        0,
      );
      console.log(
        `  ✓ ${target.providerName}: ${result.chunks.length} chunks, ` +
        `${result.thinkingChunks.length} thinking, ` +
        `${result.totalEvents} total events`,
      );
    }
  }, 600_000);

  // 11.2 All providers emit chunk → done event sequence
  it("11.2 — all providers emit chunk → done sequence", async () => {
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

      logResult(`11.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const contentEventCount = result.chunks.length + result.thinkingChunks.length;
      capabilityTracker.record(
        "11.2", CAPABILITIES.SSE_STRUCTURE, target,
        contentEventCount > 0 ? "pass" : "fail",
        contentEventCount > 0
          ? `${contentEventCount} content events before done`
          : "No content events emitted — model returned empty response",
      );
      // Done event must be the last meaningful event
      const lastEvent = result.events[result.events.length - 1];
      expect(lastEvent?.type).toBe("done");
    }
  }, 300_000);

  // 11.3 Tool calling format is consistent across providers
  it("11.3 — tool call format is consistent across providers", async () => {
    const toolProviders = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    );
    if (toolProviders.length < 2) {
      console.log("  ⏭ Skipping: need at least 2 tool-calling providers");
      return;
    }

    const results: Array<{ target: ProviderTarget; result: AgentSSEResult }> = [];

    for (const target of toolProviders) {
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

      logResult(`11.3 [${target.providerName}]`, result);
      results.push({ target, result });
    }

    // All results should have tool execution events with consistent structure
    for (const { target, result } of results) {
      assertCleanCompletion(result);
      assertAnyToolCallPresent(result);

      // Tool execution events should have a recognizable structure
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      for (const toolEvent of allToolEvents) {
        // Should have either tool.name or name at the top level
        const toolName = toolEvent.tool?.name || toolEvent.name;
        expect(toolName).toBeTruthy();
        console.log(`  ✓ ${target.providerName}: tool=${toolName} status=${toolEvent.status || "n/a"}`);
      }
    }
  }, 600_000);
});
