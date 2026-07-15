/**
 * Model Capability — Live Benchmark Tests
 * ════════════════════════════════════════════════════════════════
 *
 * Benchmarks how well a specific MODEL performs with the full agentic
 * flow. These tests depend on BOTH the harness infrastructure AND
 * the model making the right decisions (tool calling, plan compliance,
 * multi-agent orchestration, thinking quality, multi-turn recall).
 *
 * Tests are expected to FAIL for weaker models — that's the signal.
 * The capability scorecard at the end aggregates pass/fail rates
 * per capability category per model.
 *
 * ⚠️  These tests hit real LLM providers and can cost money.
 *     Cloud providers are opt-in via INCLUDE_CLOUD=true.
 *
 * Run:
 *   npx vitest run --config vitest.live.config.ts tests/live/modelCapability.live.test.ts
 *
 * ════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HARNESS_IDENTIFIERS } from "#src/constants";
import {
  discoverProviders,
  agentStreamWithRetry,
  getEffectiveUsage,
  logResult,
  logProviderSummary,
  assertCleanCompletion,
  assertAnyToolCallPresent,
  assertThinkingPresent,
  assertNoLoop,
  assertUsagePresent,
  getTimeout,
  getMultiAgentTimeout,
  type ProviderTarget,
} from "./helpers/agentTestHarness.ts";
import { capabilityTracker, CAPABILITIES } from "./helpers/capabilityTracker.ts";
import {
  SIMPLE_ARITHMETIC,
  ONE_SENTENCE_ANSWER,
  LIST_CURRENT_DIRECTORY,
  READ_SPECIFIC_FILE,
  CHAIN_TWO_TOOLS,
  DELIBERATE_TOOL_ERROR,
  MULTI_STEP_FILE_OPERATIONS,
  COMPLEX_REASONING,
  LOGIC_PUZZLE,
  THINKING_PLUS_TOOL,
  TURN_ONE_INTRODUCTION,
  TURN_TWO_RECALL,
  RECALL_NAME_TURN_TWO,
  STABILITY_CHECK,
  SPAWN_TWO_WORKERS,
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
// Suite 1: Tool Calling Capability
// ═══════════════════════════════════════════════════════════════

describe("Suite 1: Tool Calling Capability", () => {
  it("1.1 — model calls a tool when explicitly instructed", async () => {
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
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "1.1", CAPABILITIES.TOOL_COMPLIANCE, target,
        allToolEvents.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `Called ${allToolEvents.length} tool(s) to list directory`
          : "Answered without calling any tools",
      );
      expect(allToolEvents.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("1.2 — model chains multiple tool calls across iterations", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 6,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const iterationStatuses = result.statuses.filter(
        (status) => status.message === "iteration_progress",
      );
      capabilityTracker.record(
        "1.2", CAPABILITIES.TOOL_CHAINING, target,
        iterationStatuses.length >= 2 ? "pass" : "fail",
        iterationStatuses.length >= 2
          ? `${allToolEvents.length} tool calls across ${iterationStatuses.length} iterations`
          : `Only ${iterationStatuses.length} iteration(s) — model did not chain tools`,
      );
      expect(allToolEvents.length).toBeGreaterThan(0);
      expect(iterationStatuses.length).toBeGreaterThanOrEqual(2);
    }
  }, 300_000);

  it("1.3 — tool result is incorporated into model response", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "1.3", CAPABILITIES.TOOL_COMPLIANCE, target,
        allToolEvents.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `Called ${allToolEvents.length} tool(s) to read file as instructed`
          : "Answered from parametric knowledge without calling any tools",
      );
      expect(allToolEvents.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("1.4 — model handles tool error and recovers gracefully", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.4 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      capabilityTracker.record(
        "1.4", CAPABILITIES.TOOL_ERROR_RECOVERY, target,
        result.text.length > 0 ? "pass" : "fail",
        result.text.length > 0
          ? `Produced ${result.text.length} chars explaining the error`
          : "No text output after tool error — model did not recover",
      );
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("1.5 — thinking mode does not suppress tool calling", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 5,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.5 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "1.5", CAPABILITIES.TOOL_COMPLIANCE, target,
        allToolEvents.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `Called tools while thinking (${allToolEvents.length} tool call(s))`
          : "Thinking mode suppressed tool calling",
      );
      assertAnyToolCallPresent(result);
    }
  }, 300_000);

  it("1.6 — model produces final text response after multi-step tool chain", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 8,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.6 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "1.6", CAPABILITIES.TOOL_CHAINING, target,
        allToolEvents.length > 0 && result.text.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `${allToolEvents.length} tool call(s) followed by ${result.text.length} chars of text`
          : "Skipped tool chain entirely — answered from parametric knowledge",
      );
      expect(allToolEvents.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("1.7 — ReAct harness tool loop completes with correct tool invocations", async () => {
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
          harness: HARNESS_IDENTIFIERS.STANDARD,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.7 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "1.7", CAPABILITIES.TOOL_COMPLIANCE, target,
        allToolEvents.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `ReAct loop completed with ${allToolEvents.length} tool call(s)`
          : "ReAct harness completed without model invoking tools",
      );
      assertAnyToolCallPresent(result);
    }
  }, 300_000);

  it("1.8 — model continues working after tool error instead of stopping", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`1.8 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();
      capabilityTracker.record(
        "1.8", CAPABILITIES.TOOL_ERROR_RECOVERY, target,
        result.text.length > 0 ? "pass" : "fail",
        result.text.length > 0
          ? `Model recovered from error and produced ${result.text.length} chars`
          : "No text after tool error — model did not recover",
      );
      expect(result.text.length + result.thinking.length).toBeGreaterThan(0);
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 2: Thinking Quality
// ═══════════════════════════════════════════════════════════════

describe("Suite 2: Thinking Quality", () => {
  it("2.1 — thinking-capable model emits thinking chunks", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`2.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      capabilityTracker.record(
        "2.1", CAPABILITIES.THINKING_QUALITY, target,
        result.thinkingChunks.length > 0 ? "pass" : "fail",
        result.thinkingChunks.length > 0
          ? `${result.thinkingChunks.length} thinking chunks (${result.thinking.length} chars)`
          : "No thinking chunks emitted despite thinkingEnabled=true",
      );
      assertThinkingPresent(result);
    }
  }, 300_000);

  it("2.2 — thinking content is separate from text output", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`2.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const hasBothStreams = result.thinking.length > 0 && result.text.length > 0;
      capabilityTracker.record(
        "2.2", CAPABILITIES.THINKING_QUALITY, target,
        hasBothStreams ? "pass" : "fail",
        hasBothStreams
          ? `Separate streams: ${result.thinkingChunks.length} thinking + ${result.chunks.length} text chunks`
          : `Missing stream: thinking=${result.thinking.length} text=${result.text.length}`,
      );
      if (result.thinking.length > 0 && result.text.length > 0) {
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.thinkingChunks.length).toBeGreaterThan(0);
      }
    }
  }, 300_000);

  it("2.3 — thinking and tool calling coexist", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 5,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`2.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const hasThinkingAndTools = result.thinkingChunks.length > 0 && allToolEvents.length > 0;
      capabilityTracker.record(
        "2.3", CAPABILITIES.THINKING_QUALITY, target,
        hasThinkingAndTools ? "pass" : "fail",
        hasThinkingAndTools
          ? `Both present: ${result.thinkingChunks.length} thinking chunks + ${allToolEvents.length} tool calls`
          : `Missing: thinking=${result.thinkingChunks.length} tools=${allToolEvents.length}`,
      );
      assertAnyToolCallPresent(result);
      assertThinkingPresent(result);
    }
  }, 300_000);

  it("2.4 — display segments maintain correct ordering", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 5,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`2.4 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const eventTypes = result.events.map((event) => event.type);
      const doneIndex = eventTypes.indexOf("done");
      if (doneIndex > 0) {
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
// Suite 3: Multi-Turn Context
// ═══════════════════════════════════════════════════════════════

describe("Suite 3: Multi-Turn Context", () => {
  it("3.1 — model recalls context from previous turn", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TURN_ONE_INTRODUCTION }],
          agent: "OMNI",
          agentConversationId: sessionId,
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`3.1 Turn 1 [${target.providerName}]`, turn1);
      expect(turn1.timedOut).toBe(false);
      expect(turn1.done).toBeTruthy();

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
          agentConversationId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`3.1 Turn 2 [${target.providerName}]`, turn2);
      assertCleanCompletion(turn2);
      assertNoLoop(turn2);

      const responseText = (turn2.text + turn2.thinking).toLowerCase();
      capabilityTracker.record(
        "3.1", CAPABILITIES.MULTI_TURN_RECALL, target,
        responseText.includes("rodrigo") ? "pass" : "fail",
        responseText.includes("rodrigo")
          ? "Correctly recalled the name 'Rodrigo' from turn 1"
          : `Did not recall name — response: "${responseText.slice(0, 100)}"`,
      );
      expect(responseText).toContain("rodrigo");
    }
  }, 600_000);

  it("3.2 — three-turn conversation stays stable", async () => {
    for (const target of providerTargets) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: TURN_ONE_INTRODUCTION }],
          agent: "OMNI",
          agentConversationId: sessionId,
          maxTokens: 200,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

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
          agentConversationId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );
      expect(turn2.done).toBeTruthy();

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
          agentConversationId: sessionId,
          maxTokens: 50,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`3.2 Turn 3 [${target.providerName}]`, turn3);

      capabilityTracker.record(
        "3.2", CAPABILITIES.MULTI_TURN_RECALL, target,
        turn3.done && !turn3.timedOut ? "pass" : "fail",
        turn3.done
          ? `Three-turn conversation completed stably (${turn3.text.length} chars)`
          : "Conversation destabilized at turn 3",
      );
      assertCleanCompletion(turn3);
      assertNoLoop(turn3);
    }
  }, 600_000);

  it("3.3 — tool calls in history don't corrupt continuation", async () => {
    for (const target of providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    )) {
      console.log(`\n  🎯 Provider: ${target.providerName} (${target.model})`);
      const sessionId = crypto.randomUUID();

      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: LIST_CURRENT_DIRECTORY }],
          agent: "OMNI",
          agentConversationId: sessionId,
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 3,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

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
          agentConversationId: sessionId,
          maxTokens: 100,
          autoApprove: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`3.3 Turn 2 [${target.providerName}]`, turn2);

      capabilityTracker.record(
        "3.3", CAPABILITIES.MULTI_TURN_RECALL, target,
        turn2.done && !turn2.timedOut ? "pass" : "fail",
        turn2.done
          ? "Continuation after tool-call history succeeded"
          : "Conversation corrupted after tool-call history",
      );
      expect(turn2.timedOut).toBe(false);
      expect(turn2.done).toBeTruthy();
      assertNoLoop(turn2);
    }
  }, 600_000);

  it("3.4 — thinking persists across multi-turn with thinking models", async () => {
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

      const turn1 = await agentStreamWithRetry(
        {
          provider: target.providerName,
          model: target.model,
          messages: [{ role: "user", content: COMPLEX_REASONING }],
          agent: "OMNI",
          agentConversationId: sessionId,
          maxTokens: 500,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );
      expect(turn1.done).toBeTruthy();

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
          agentConversationId: sessionId,
          maxTokens: 500,
          autoApprove: true,
          thinkingEnabled: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`3.4 Turn 2 [${target.providerName}]`, turn2);

      assertCleanCompletion(turn2);
      capabilityTracker.record(
        "3.4", CAPABILITIES.THINKING_QUALITY, target,
        turn2.thinkingChunks.length > 0 ? "pass" : "fail",
        turn2.thinkingChunks.length > 0
          ? `Turn 2 produced ${turn2.thinkingChunks.length} thinking chunks`
          : "Thinking did not persist to turn 2",
      );
      assertThinkingPresent(turn2);
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 4: Plan Mode Compliance
// ═══════════════════════════════════════════════════════════════

describe("Suite 4: Plan Mode Compliance", () => {
  it("4.1 — model respects plan mode tool restrictions", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1000,
          autoApprove: true,
          maxIterations: 5,
          planFirst: true,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`4.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

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

      capabilityTracker.record(
        "4.1", CAPABILITIES.PLAN_MODE_COMPLIANCE, target,
        fileToolCalls.length === 0 ? "pass" : "fail",
        fileToolCalls.length === 0
          ? "Respected plan mode restrictions — no file/shell tools invoked"
          : `Called ${fileToolCalls.length} restricted tool(s) during plan mode`,
      );
      expect(fileToolCalls.length).toBe(0);
    }
  }, 300_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 5: Usage & Cost Reporting
// ═══════════════════════════════════════════════════════════════

describe("Suite 5: Usage & Cost Reporting", () => {
  it("5.1 — provider reports inputTokens > 0", async () => {
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
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`5.1 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const totalInputTokens = (effectiveUsage.inputTokens ?? 0) + (effectiveUsage.promptTokens ?? 0);
      capabilityTracker.record(
        "5.1", CAPABILITIES.USAGE_REPORTING, target,
        totalInputTokens > 0 ? "pass" : "fail",
        totalInputTokens > 0
          ? `inputTokens=${totalInputTokens}`
          : "inputTokens=0 — provider does not report usage in streaming mode",
      );
      expect(totalInputTokens).toBeGreaterThan(0);
    }
  }, 300_000);

  it("5.2 — provider reports outputTokens > 0", async () => {
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
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`5.2 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const outputTokenCount = effectiveUsage.outputTokens ?? 0;
      capabilityTracker.record(
        "5.2", CAPABILITIES.USAGE_REPORTING, target,
        outputTokenCount > 0 ? "pass" : "fail",
        outputTokenCount > 0
          ? `outputTokens=${outputTokenCount}`
          : "outputTokens=0 — provider does not report usage in streaming mode",
      );
      expect(outputTokenCount).toBeGreaterThan(0);
    }
  }, 300_000);

  it("5.3 — multi-iteration usage accumulates correctly", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 1500,
          autoApprove: true,
          maxIterations: 5,
        },
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`5.3 [${target.providerName}]`, result);

      assertCleanCompletion(result);
      const effectiveUsage = getEffectiveUsage(result);
      const hasUsage = (effectiveUsage.inputTokens ?? 0) > 0;
      capabilityTracker.record(
        "5.3", CAPABILITIES.USAGE_REPORTING, target,
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
// Suite 6: Multi-Agent Orchestration
// ═══════════════════════════════════════════════════════════════

describe("Suite 6: Multi-Agent Orchestration", () => {
  it("6.1 — model invokes team_create to spawn sub-agents", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 2000,
          autoApprove: true,
          maxIterations: 10,
        },
        { timeoutMilliseconds: getMultiAgentTimeout(target) },
      );

      logResult(`6.1 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const teamCreateCalls = allToolEvents.filter(
        (toolEvent) =>
          (toolEvent.tool?.name || toolEvent.name) === "team_create" ||
          (toolEvent.tool?.name || toolEvent.name) === "create_subagents",
      );
      capabilityTracker.record(
        "6.1", CAPABILITIES.MULTI_AGENT_ORCHESTRATION, target,
        teamCreateCalls.length > 0 ? "pass" : "fail",
        teamCreateCalls.length > 0
          ? `Invoked team_create ${teamCreateCalls.length} time(s)`
          : allToolEvents.length > 0
            ? `Used tools but not team_create (called: ${allToolEvents.map((event) => event.tool?.name || event.name).join(", ")})`
            : "Did not invoke any tools — model lacks multi-agent orchestration capability",
      );
      expect(teamCreateCalls.length).toBeGreaterThan(0);

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

  it("6.2 — orchestrator produces synthesized output from sub-agents", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 15,
        },
        { timeoutMilliseconds: getMultiAgentTimeout(target) },
      );

      logResult(`6.2 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const hasOutput = result.text.length + result.thinking.length > 0;
      capabilityTracker.record(
        "6.2", CAPABILITIES.MULTI_AGENT_ORCHESTRATION, target,
        hasOutput ? "pass" : "fail",
        hasOutput
          ? `Orchestrator produced ${result.text.length} text + ${result.thinking.length} thinking chars`
          : "Orchestrator produced no output — model cannot synthesize multi-agent results",
      );
      expect(hasOutput).toBe(true);
    }
  }, 600_000);

  it("6.3 — sequential topology chains sub-agent outputs", async () => {
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
          agentConversationId: crypto.randomUUID(),
          maxTokens: 3000,
          autoApprove: true,
          maxIterations: 15,
          topology: "sequential",
        },
        { timeoutMilliseconds: getMultiAgentTimeout(target) },
      );

      logResult(`6.3 [${target.providerName}]`, result);

      expect(result.timedOut).toBe(false);
      expect(result.done).toBeTruthy();

      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      const teamCreateCalls = allToolEvents.filter(
        (toolEvent) =>
          (toolEvent.tool?.name || toolEvent.name) === "team_create" ||
          (toolEvent.tool?.name || toolEvent.name) === "create_subagents",
      );
      capabilityTracker.record(
        "6.3", CAPABILITIES.MULTI_AGENT_ORCHESTRATION, target,
        teamCreateCalls.length > 0 ? "pass" : "fail",
        teamCreateCalls.length > 0
          ? `Sequential topology with ${teamCreateCalls.length} team_create call(s)`
          : "Model did not invoke team_create for sequential orchestration",
      );
      expect(teamCreateCalls.length).toBeGreaterThan(0);
    }
  }, 600_000);
});


// ═══════════════════════════════════════════════════════════════
// Suite 7: Cross-Provider Tool Format
// ═══════════════════════════════════════════════════════════════

describe("Suite 7: Cross-Provider Tool Format", () => {
  it("7.1 — tool call format is consistent across providers", async () => {
    const toolProviders = providerTargets.filter(
      (providerTarget) => providerTarget.supportsToolCalling,
    );
    if (toolProviders.length < 2) {
      console.log("  ⏭ Skipping: need at least 2 tool-calling providers");
      return;
    }

    const results: Array<{ target: ProviderTarget; result: ReturnType<typeof agentStreamWithRetry> extends Promise<infer R> ? R : never }> = [];

    for (const target of toolProviders) {
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
        { timeoutMilliseconds: getTimeout(target) },
      );

      logResult(`7.1 [${target.providerName}]`, result);
      results.push({ target, result });
    }

    for (const { target, result } of results) {
      assertCleanCompletion(result);
      const allToolEvents = [...result.toolExecutions, ...result.toolCalls];
      capabilityTracker.record(
        "7.1", CAPABILITIES.TOOL_COMPLIANCE, target,
        allToolEvents.length > 0 ? "pass" : "fail",
        allToolEvents.length > 0
          ? `Tool format consistent: ${allToolEvents.length} tool call(s)`
          : "No tool calls to verify format against",
      );
      assertAnyToolCallPresent(result);

      for (const toolEvent of allToolEvents) {
        const toolName = toolEvent.tool?.name || toolEvent.name;
        expect(toolName).toBeTruthy();
        console.log(`  ✓ ${target.providerName}: tool=${toolName} status=${toolEvent.status || "n/a"}`);
      }
    }
  }, 600_000);
});
