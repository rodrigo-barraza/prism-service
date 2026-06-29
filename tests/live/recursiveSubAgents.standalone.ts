#!/usr/bin/env tsx
/**
 * Standalone script to test recursive sub-agent spawning against api.prism.rod.dev.
 * Run with: npx tsx tests/live/recursiveSubAgents.standalone.ts
 */

const PRISM_SERVICE_URL = "https://api.prism.rod.dev";
const RECURSIVE_TEST_TIMEOUT_MS = 600_000;

const RECURSIVE_SPAWNING_PROMPT = `You have access to the create_team tool. Use it RIGHT NOW. Do not explain anything first — immediately call create_team.

Create a team named "grandchild_test" with exactly 2 members. Use topology "hierarchical".

CRITICAL: Each member's prompt MUST instruct the sub-agent to use create_team to spawn its own sub-agents. Here is what each member prompt should say:

Member 1 description: "Coordinator A — spawns grandchildren batch 1"
Member 1 prompt:
"You have access to the create_team tool. Use it RIGHT NOW — do not explain, do not think, just call create_team immediately. Create a team called 'grandchild_batch_1' with 2 members. Member 1 should respond with exactly: 'Hello World from grandchild A1'. Member 2 should respond with exactly: 'Hello World from grandchild A2'. After the team completes, summarize what the grandchildren said."

Member 2 description: "Coordinator B — spawns grandchildren batch 2"
Member 2 prompt:
"You have access to the create_team tool. Use it RIGHT NOW — do not explain, do not think, just call create_team immediately. Create a team called 'grandchild_batch_2' with 2 members. Member 1 should respond with exactly: 'Hello World from grandchild B1'. Member 2 should respond with exactly: 'Hello World from grandchild B2'. After the team completes, summarize what the grandchildren said."

Do NOT do anything else. Just call create_team immediately.`;

interface SSEEvent {
  type: string;
  content?: string;
  message?: string;
  subAgentId?: string;
  description?: string;
  error?: string;
  durationMs?: number;
  tool?: { name: string; args?: Record<string, unknown> };
  name?: string;
  status?: string;
  iteration?: number;
  toolCount?: number;
  [key: string]: unknown;
}

async function runTest() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🧬 Recursive Sub-Agent Spawning Test (Grandchildren)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`  📡 Target: ${PRISM_SERVICE_URL}/agent`);
  console.log(`  🤖 Agent: OMNI`);
  console.log(`  📊 Provider: anthropic (claude-sonnet-4-6)`);
  console.log(`  🌳 Max Recursion Depth: 2`);
  console.log(`  ⏱  Timeout: ${RECURSIVE_TEST_TIMEOUT_MS / 1000}s\n`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log("\n  ⏱ TIMEOUT — aborting...");
    controller.abort();
  }, RECURSIVE_TEST_TIMEOUT_MS);

  const startTime = Date.now();

  try {
    const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
      method: "POST",
      headers: {
        "x-project": "recursive-subagent-tests",
        "x-username": "test-runner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  ❌ HTTP Error: ${response.status} — ${errorText}`);
      process.exit(1);
    }

    console.log("  ✅ SSE connection established. Streaming events...\n");

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const allEvents: SSEEvent[] = [];
    const spawnedAgents: SSEEvent[] = [];
    const completedAgents: SSEEvent[] = [];
    const failedAgents: SSEEvent[] = [];
    const rootToolCalls: SSEEvent[] = [];
    const subAgentToolCalls: SSEEvent[] = [];
    let responseText = "";
    let doneEvent: SSEEvent | null = null;
    let lastEventTime = Date.now();

    const idleCheckId = setInterval(() => {
      if (Date.now() - lastEventTime > 120_000) {
        console.log("\n  ⚠ Idle for 2 minutes — aborting...");
        controller.abort();
      }
    }, 10_000);

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
            const event = JSON.parse(trimmed.slice(6)) as SSEEvent;
            allEvents.push(event);
            lastEventTime = Date.now();

            switch (event.type) {
              case "chunk":
                if (typeof event.content === "string") {
                  responseText += event.content;
                }
                break;

              case "sub_agent_status":
                if (event.message === "spawned") {
                  spawnedAgents.push(event);
                  console.log(`  📌 SPAWNED: ${event.subAgentId} — "${event.description}"`);
                } else if (event.message === "complete") {
                  completedAgents.push(event);
                  console.log(`  ✅ COMPLETED: ${event.subAgentId} (${event.durationMs}ms, ${event.toolCount ?? "?"} tools)`);
                } else if (event.message === "failed") {
                  failedAgents.push(event);
                  console.log(`  ❌ FAILED: ${event.subAgentId} — ${event.error}`);
                } else if (event.message === "phase") {
                  // Compact phase logging
                  process.stdout.write(`  ⚡ ${event.subAgentId}: ${event.phase}\r`);
                } else if (event.message === "iteration_progress") {
                  console.log(`  🔄 ${event.subAgentId}: iteration ${event.iteration}`);
                }
                break;

              case "tool_execution":
                rootToolCalls.push(event);
                if (event.status === "calling") {
                  console.log(`  🔧 ROOT TOOL: ${event.tool?.name} (${event.status})`);
                }
                break;

              case "sub_agent_tool_execution":
                subAgentToolCalls.push(event);
                if (event.status === "calling") {
                  console.log(`  🔧 SUB-AGENT TOOL: ${event.subAgentId} → ${event.tool?.name} (${event.status})`);
                }
                break;

              case "error":
                console.log(`  ⚠ ERROR: ${event.message}`);
                break;

              case "done":
                doneEvent = event;
                break;
            }
          } catch {
            // Skip malformed JSON
          }
        }

        if (doneEvent) break;
      }
    } finally {
      clearInterval(idleCheckId);
    }

    const durationMs = Date.now() - startTime;

    // ── Report ──────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  📊 TEST RESULTS");
    console.log("═══════════════════════════════════════════════════════════════\n");

    console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`  Total SSE events: ${allEvents.length}`);
    console.log(`  Response text length: ${responseText.length} chars`);
    console.log(`  Done event: ${doneEvent ? "✅ yes" : "❌ no"}`);

    console.log(`\n  🤖 Sub-Agent Lifecycle:`);
    console.log(`     Total spawned: ${spawnedAgents.length}`);
    console.log(`     Total completed: ${completedAgents.length}`);
    console.log(`     Total failed: ${failedAgents.length}`);

    console.log(`\n  🔧 Tool Calls:`);
    const rootCreateTeamCalls = rootToolCalls.filter(
      (event) => event.tool?.name === "create_subagents" && event.status === "calling",
    );
    console.log(`     Root create_team calls: ${rootCreateTeamCalls.length}`);

    const subAgentCreateTeamCalls = subAgentToolCalls.filter(
      (event) => event.tool?.name === "create_subagents" && event.status === "calling",
    );
    console.log(`     Sub-agent create_team calls: ${subAgentCreateTeamCalls.length}`);

    const uniqueSubAgentToolNames = new Set(
      subAgentToolCalls
        .filter((event) => event.status === "calling")
        .map((event) => event.tool?.name || "unknown"),
    );
    console.log(`     Unique sub-agent tools: [${[...uniqueSubAgentToolNames].join(", ")}]`);

    // ── Key Findings ──────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  🧬 GRANDCHILD SPAWNING ANALYSIS");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const expectedDepth1Agents = 2;
    const expectedTotalAgents = 6; // 2 depth-1 + 4 depth-2

    if (spawnedAgents.length >= expectedTotalAgents) {
      console.log(`  ✅ PASS: ${spawnedAgents.length} agents spawned (≥ ${expectedTotalAgents} expected)`);
      console.log(`  ✅ Grandchild agents were successfully spawned!`);
    } else if (spawnedAgents.length >= expectedDepth1Agents) {
      console.log(`  ⚠ PARTIAL: ${spawnedAgents.length} agents spawned (only depth-1 children, no grandchildren)`);
      console.log(`  ❌ FAIL: Depth-1 sub-agents did NOT spawn grandchildren`);

      // Diagnose why
      if (subAgentCreateTeamCalls.length === 0) {
        console.log(`\n  🔍 DIAGNOSIS: Sub-agents never called create_team`);
        console.log(`     → Sub-agents may not have received create_team in their tool list`);
        console.log(`     → Or the model at depth-1 failed to engage (0 tool calls, 1 iteration)`);
      } else {
        console.log(`\n  🔍 DIAGNOSIS: Sub-agents called create_team ${subAgentCreateTeamCalls.length} time(s)`);
        console.log(`     → But grandchild agents weren't visible in the SSE stream`);
        console.log(`     → Check if grandchild events are being forwarded through telemetry`);
      }
    } else {
      console.log(`  ❌ FAIL: Only ${spawnedAgents.length} agents spawned (expected ≥ ${expectedDepth1Agents})`);
      console.log(`  ❌ Even depth-1 sub-agents were not spawned properly`);
    }

    // Check for "no output" pattern
    const noOutputAgents = completedAgents.filter(
      (event) => event.toolCount === 0,
    );
    if (noOutputAgents.length > 0) {
      console.log(`\n  ⚠ WARNING: ${noOutputAgents.length} agent(s) completed with 0 tool calls`);
      console.log(`     This matches the "Sub-agent produced no output" pattern from the bug report`);
      for (const agent of noOutputAgents) {
        console.log(`     → ${agent.subAgentId}: 0 tools, ${agent.durationMs}ms`);
      }
    }

    // Print response text summary
    if (responseText.length > 0) {
      console.log(`\n  📝 Response text (first 3000 chars):`);
      console.log("  " + responseText.slice(0, 3000).replace(/\n/g, "\n  "));
    }

    console.log("\n═══════════════════════════════════════════════════════════════\n");

  } finally {
    clearTimeout(timeoutId);
  }
}

runTest().catch((error) => {
  console.error("  ❌ Test failed:", error);
  process.exit(1);
});
