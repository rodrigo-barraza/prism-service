/**
 * Recursive Sub-Agent Spawning — Live Integration Test
 * ═════════════════════════════════════════════════════════
 *
 * Validates that sub-agents can themselves spawn sub-agents (grandchildren).
 *
 * Test scenario:
 *   1. Root agent (OMNI) receives a prompt asking it to spawn 2 sub-agents
 *   2. Each sub-agent is instructed to itself spawn 2 sub-agents that console.log "hello world"
 *   3. The test verifies that grandchild sub-agents actually get spawned and produce output
 *
 * Configuration:
 *   - Sub-Agent Recursion Depth: 2 (allows children to spawn grandchildren)
 *   - Max Sub-Agent Iterations: unlimited (∞)
 *   - Topology: Sequential Pipeline (SP) or Hierarchical
 */

import { describe, test, expect } from "vitest";
import {
  PRISM_SERVICE_URL,
  consumeAgentSSE,
  MULTI_AGENT_TIMEOUT_MS,
  type AgentSSEResult,
  type SubAgentStatusEvent,
} from "./helpers/agentTestHarness.ts";

const RECURSIVE_TEST_TIMEOUT_MS = 600_000;

const RECURSIVE_SPAWNING_PROMPT = `You have access to the create_team tool. Use it RIGHT NOW. Do not explain anything first — immediately call create_team.

Create a team named "grandchild_test" with exactly 2 members.

CRITICAL: Each member's prompt MUST instruct the sub-agent to use create_team to spawn its own sub-agents. Here is what each member prompt should say (adapt the wording but keep the instruction to call create_team):

Member 1 prompt:
"You have access to the create_team tool. Use it RIGHT NOW — do not explain, just call create_team immediately. Create a team called 'grandchild_batch_1' with 2 members. Each member should respond with exactly: 'Hello World from grandchild batch 1'. After the team completes, summarize the results."

Member 2 prompt:
"You have access to the create_team tool. Use it RIGHT NOW — do not explain, just call create_team immediately. Create a team called 'grandchild_batch_2' with 2 members. Each member should respond with exactly: 'Hello World from grandchild batch 2'. After the team completes, summarize the results."

Do NOT do anything else. Just call create_team immediately with these 2 members.`;

describe("Recursive Sub-Agent Spawning (Grandchildren)", () => {
  test(
    "sub-agents at depth 1 can spawn their own sub-agents at depth 2",
    async () => {
      console.log("\n  🧬 Testing recursive sub-agent spawning (depth 2)...");
      console.log(`  📡 Target: ${PRISM_SERVICE_URL}/agent`);

      const controller = new AbortController();
      const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
        method: "POST",
        headers: {
          "x-project": "recursive-subagent-tests",
          "x-username": "test-runner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          agent: "OMNI",
          messages: [
            {
              role: "user",
              content: RECURSIVE_SPAWNING_PROMPT,
            },
          ],
          autoApprove: true,
          maxIterations: 0,
          maxSubAgentIterations: 0,
          maxRecursionDepth: 2,
          topology: "hierarchical",
          thinkingEnabled: true,
          reasoningEffort: "low",
          maxTokens: 8192,
        }),
        signal: controller.signal,
      });

      expect(response.ok).toBe(true);

      const result = await consumeAgentSSE(response, {
        timeoutMilliseconds: RECURSIVE_TEST_TIMEOUT_MS,
        idleTimeoutMilliseconds: 120_000,
        controller,
      });

      // ── Diagnostics ─────────────────────────────────────────
      console.log(`\n  📊 Results:`);
      console.log(`     Duration: ${(result.durationMilliseconds / 1000).toFixed(1)}s`);
      console.log(`     Total events: ${result.totalEvents}`);
      console.log(`     Text length: ${result.text.length} chars`);
      console.log(`     Errors: ${result.errors.length}`);
      console.log(`     Tool executions: ${result.toolExecutions.length}`);
      console.log(`     Sub-agent statuses: ${result.subAgentStatuses.length}`);

      // Extract sub-agent status events
      const spawnedAgentEvents = result.subAgentStatuses.filter(
        (event: SubAgentStatusEvent) => event.message === "spawned",
      );
      const completedAgentEvents = result.subAgentStatuses.filter(
        (event: SubAgentStatusEvent) => event.message === "complete",
      );
      const failedAgentEvents = result.subAgentStatuses.filter(
        (event: SubAgentStatusEvent) => event.message === "failed",
      );

      console.log(`\n  🤖 Sub-Agent Lifecycle:`);
      console.log(`     Spawned: ${spawnedAgentEvents.length}`);
      console.log(`     Completed: ${completedAgentEvents.length}`);
      console.log(`     Failed: ${failedAgentEvents.length}`);

      for (const agentEvent of spawnedAgentEvents) {
        console.log(`     📌 Spawned: ${agentEvent.subAgentId} — "${agentEvent.description}"`);
      }
      for (const agentEvent of completedAgentEvents) {
        console.log(`     ✅ Completed: ${agentEvent.subAgentId} (${agentEvent.durationMs}ms)`);
      }
      for (const agentEvent of failedAgentEvents) {
        console.log(`     ❌ Failed: ${agentEvent.subAgentId} — ${agentEvent.error}`);
      }

      // Extract tool execution details
      const createTeamToolCalls = result.toolExecutions.filter(
        (toolEvent) =>
          toolEvent.tool?.name === "create_subagents" || toolEvent.name === "create_subagents",
      );
      const subAgentToolCalls = result.toolExecutions.filter(
        (toolEvent) =>
          toolEvent.type === "sub_agent_tool_execution",
      );

      console.log(`\n  🔧 Tool Calls:`);
      console.log(`     create_team calls (root): ${createTeamToolCalls.length}`);
      console.log(`     Sub-agent tool executions: ${subAgentToolCalls.length}`);

      // List all sub-agent tool names to check if child agents called create_team
      const subAgentCreateTeamCalls = subAgentToolCalls.filter(
        (toolEvent) => toolEvent.tool?.name === "create_subagents",
      );
      console.log(`     create_team calls (from sub-agents): ${subAgentCreateTeamCalls.length}`);

      // Print all sub-agent tool execution names
      const uniqueSubAgentToolNames = new Set(
        subAgentToolCalls.map((toolEvent) => toolEvent.tool?.name || toolEvent.name || "unknown"),
      );
      console.log(`     Unique sub-agent tools used: [${[...uniqueSubAgentToolNames].join(", ")}]`);

      // Print full response text for debugging
      if (result.text) {
        console.log(`\n  📝 Response text (first 2000 chars):\n${result.text.slice(0, 2000)}`);
      }

      // Print any errors
      if (result.errors.length > 0) {
        console.log(`\n  ⚠ Errors:`);
        for (const errorEvent of result.errors) {
          console.log(`     ${errorEvent.message}`);
        }
      }

      // ── Core Assertions ─────────────────────────────────────
      expect(result.isTimedOut).toBe(false);
      expect(result.done).toBeTruthy();

      // Root should have called create_team at least once
      expect(createTeamToolCalls.length).toBeGreaterThanOrEqual(1);

      // At least 2 depth-1 sub-agents should have spawned
      expect(spawnedAgentEvents.length).toBeGreaterThanOrEqual(2);

      // The key assertion: sub-agents at depth 1 should have called create_team
      // to spawn grandchildren at depth 2
      console.log(`\n  🧬 KEY ASSERTION: Did depth-1 sub-agents spawn grandchildren?`);
      console.log(`     Sub-agent create_team calls: ${subAgentCreateTeamCalls.length}`);
      console.log(`     Total spawned agents: ${spawnedAgentEvents.length}`);

      // We expect at least 4 total spawned agents:
      // 2 at depth 1 (children) + at least 2 at depth 2 (grandchildren from at least 1 child)
      if (spawnedAgentEvents.length >= 4) {
        console.log(`     ✅ PASS: ${spawnedAgentEvents.length} agents spawned (grandchildren detected)`);
      } else {
        console.log(`     ❌ FAIL: Only ${spawnedAgentEvents.length} agents spawned (expected >= 4 for grandchild verification)`);
      }

      // Check for the "no output" issue seen in the screenshot
      const zeroToolCallAgents = completedAgentEvents.filter(
        (agentEvent) => {
          const matchingStatus = result.subAgentStatuses.find(
            (statusEvent) =>
              statusEvent.subAgentId === agentEvent.subAgentId &&
              statusEvent.message === "iteration_progress",
          );
          return matchingStatus && (matchingStatus as Record<string, unknown>).iteration === 1;
        },
      );
      if (zeroToolCallAgents.length > 0) {
        console.log(`\n  ⚠ WARNING: ${zeroToolCallAgents.length} agents completed with only 1 iteration (likely no engagement)`);
      }

      expect(spawnedAgentEvents.length).toBeGreaterThanOrEqual(4);
    },
    RECURSIVE_TEST_TIMEOUT_MS,
  );
});
