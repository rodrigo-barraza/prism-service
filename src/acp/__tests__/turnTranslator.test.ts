/**
 * turnTranslator.test.ts — Prism turn events → ACP session updates.
 *
 * The main case replays a real recorded `/agent` stream
 * (tests/fixtures/sse-transcripts/live-agent-tool-call.jsonl: thinking, a tool
 * call that asked for approval, the answer, usage) through TurnTranslator; the
 * rest are hand-built events, each validated against the protocol first so a
 * fixture cannot drift from `events.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { validateTurnEvent, type TurnEvent } from "#src/protocol/events";
import {
  TurnTranslator,
  TOOL_OUTPUT_TAIL_CHARACTERS,
  toolKind,
  toolLocations,
  type TurnInteraction,
} from "#src/acp/TurnTranslator";
import { SERVICE_ROOT } from "../../protocol/__tests__/siblingCheckout.ts";

function transcript(name: string): TurnEvent[] {
  return readFileSync(join(SERVICE_ROOT, "tests/fixtures/sse-transcripts", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

/** A hand-built event, refused if it is not valid protocol. */
function valid<Event extends TurnEvent>(event: Event): Event {
  const result = validateTurnEvent(event);
  if (!result.success) throw new Error(`fixture is not protocol v1: ${JSON.stringify(result.error.issues)}`);
  return event;
}

function run(events: TurnEvent[], workspaceRoot: string | null = "/work") {
  const translator = new TurnTranslator({ workspaceRoot });
  const updates: SessionUpdate[] = [];
  const interactions: TurnInteraction[] = [];
  for (const event of events) {
    const translated = translator.translate(event);
    updates.push(...translated.updates);
    if (translated.interaction) interactions.push(translated.interaction);
  }
  return { translator, updates, interactions };
}

const kinds = (updates: SessionUpdate[]) => updates.map((update) => update.sessionUpdate);

describe("TurnTranslator — the recorded live tool-call turn", () => {
  const events = transcript("live-agent-tool-call.jsonl");
  const { translator, updates, interactions } = run(events);
  const toolId = "google-toolCall-44c324a0-d22c-4459-ac91-53ec59c17063";

  it("is a valid protocol transcript", () => {
    for (const event of events) expect(validateTurnEvent(event).success).toBe(true);
  });

  it("streams thinking and answer text as thought and message chunks, in order", () => {
    const text = updates
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : ""))
      .join("");
    expect(text).toBe(
      "The International Space Station is currently located over the North Pacific Ocean at approximately 21.82° N latitude and 176.21° E longitude.",
    );
    const thoughts = updates.filter((update) => update.sessionUpdate === "agent_thought_chunk");
    expect(thoughts).toHaveLength(2);
    expect(kinds(updates).indexOf("agent_thought_chunk")).toBeLessThan(kinds(updates).indexOf("tool_call"));
  });

  it("walks the tool call through pending → in_progress → approval → completed with its result", () => {
    const toolUpdates = updates.filter(
      (update) =>
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.toolCallId === toolId,
    );
    expect(toolUpdates.map((update) => [update.sessionUpdate, "status" in update ? update.status : undefined])).toEqual([
      ["tool_call", "pending"],
      ["tool_call_update", "in_progress"],
      ["tool_call_update", "in_progress"], // approval_decided: allow
      ["tool_call_update", "completed"],
    ]);
    const [announced] = toolUpdates;
    expect(announced).toMatchObject({ title: "Locating", name: "get_iss_location", kind: "read", rawInput: {} });
    const completed = toolUpdates.at(-1)!;
    expect(completed).toMatchObject({ rawOutput: { position: { latitude: 21.8209 } } });
    expect(JSON.stringify(completed)).toContain("176.2101");
  });

  it("turns approval_required into an approval interaction and approval_decided into a withdrawal", () => {
    expect(interactions.map((interaction) => interaction.kind)).toEqual(["approval", "decided"]);
    const [approval] = interactions;
    if (approval?.kind !== "approval") throw new Error("expected an approval");
    expect(approval.event.batchId).toBe("c6ce1858-d92b-440d-9c2c-74c6147b27f0");
    expect(approval.toolCall).toMatchObject({ toolCallId: toolId, status: "pending", kind: "read" });
  });

  it("reports context use and the turn's cost as usage_update", () => {
    const usage = updates.filter((update) => update.sessionUpdate === "usage_update").at(-1);
    expect(usage).toEqual({
      sessionUpdate: "usage_update",
      used: 36142,
      size: 1048576,
      cost: { amount: 0.01647052, currency: "USD" },
    });
  });

  it("ends done, with the conversation id the stream named", () => {
    expect(translator.outcome).toMatchObject({
      done: true,
      error: null,
      refusal: false,
      iterationLimit: false,
      conversationId: "f541524b-4132-4d04-b403-9284893ffa72",
      turnCost: 0.01647052,
    });
  });
});

describe("TurnTranslator — plans, modes and outcomes", () => {
  it("maps todo_update onto an ACP plan, entry for entry", () => {
    const { updates } = run([
      valid({
        type: "todo_update",
        items: [
          { id: 1, content: "Read the config", status: "completed", priority: "high" },
          { id: 2, content: "Patch the loader", status: "in_progress", priority: "medium" },
          { id: 3, content: "Run the tests", status: "pending", priority: "low" },
        ],
        stats: { total: 3, pending: 1, in_progress: 1, completed: 1 },
      }),
    ]);
    expect(updates).toEqual([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the config", status: "completed", priority: "high" },
          { content: "Patch the loader", status: "in_progress", priority: "medium" },
          { content: "Run the tests", status: "pending", priority: "low" },
        ],
      },
    ]);
  });

  it("shows a plan proposal as a plan plus a switch_mode call to approve", () => {
    const { updates, interactions } = run([
      valid({
        type: "plan_proposal",
        plan: "1. Read\n2. Write",
        steps: ["Read", "Write"],
        autoApproved: false,
        toolCallId: "plan-1",
        batchId: "batch-plan",
      }),
    ]);
    expect(kinds(updates)).toEqual(["plan", "tool_call"]);
    expect(updates[0]).toMatchObject({ entries: [{ content: "Read", status: "pending" }, { content: "Write" }] });
    expect(updates[1]).toMatchObject({ toolCallId: "plan-1", kind: "switch_mode", status: "pending" });
    expect(interactions).toMatchObject([{ kind: "plan", toolCall: { toolCallId: "plan-1" } }]);
  });

  it("does not ask about a plan that was auto-approved", () => {
    const { updates, interactions } = run([
      valid({ type: "plan_proposal", plan: "p", steps: ["a"], autoApproved: true, toolCallId: "p", batchId: "b" }),
    ]);
    expect(kinds(updates)).toEqual(["plan"]);
    expect(interactions).toEqual([]);
  });

  it("reports a permission mode switch as current_mode_update", () => {
    const { updates } = run([
      valid({ type: "permission_mode", conversationId: "c", mode: "acceptEdits", source: "user", previousMode: "default" }),
    ]);
    expect(updates).toEqual([{ sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" }]);
  });

  it("records a refusal, an iteration limit and an error for the stop reason", () => {
    expect(run([valid({ type: "refusal", category: "cyber", explanation: "no" })]).translator.outcome.refusal).toBe(true);
    expect(
      run([valid({ type: "status", message: "iteration_limit_reached" })]).translator.outcome.iterationLimit,
    ).toBe(true);
    const failed = run([
      valid({ type: "chunk", content: "partial" }),
      valid({ type: "error", code: "rate_limited", message: "429", retryable: true, provider: "anthropic", status: 429 }),
    ]).translator.outcome;
    expect(failed.error).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("ignores a background operation's usage (memory upkeep) in the session cost", () => {
    const { translator } = run([
      valid({ type: "usage_update", usage: { inputTokens: 5 }, estimatedCost: 0.5 }),
      valid({ type: "usage_update", operation: "memory:extract", usage: { inputTokens: 9, estimatedCost: 9 } }),
    ]);
    expect(translator.outcome.turnCost).toBe(0.5);
  });

  it("sums the cost of every turn in one prompt (an auto-response after a dispatch)", () => {
    const translator = new TurnTranslator({ workspaceRoot: null, costBeforeTurn: 1 });
    translator.translate(valid({ type: "usage_update", usage: {}, estimatedCost: 0.2 }));
    translator.translate(valid({ type: "done", provider: "p", model: "m", usage: null, estimatedCost: 0.25, totalTime: 1 }));
    translator.translate(valid({ type: "usage_update", usage: {}, estimatedCost: 0.1 }));
    expect(translator.outcome.turnCost).toBeCloseTo(0.35, 10);
    translator.translate(valid({ type: "done", provider: "p", model: "m", usage: null, estimatedCost: 0.15, totalTime: 1 }));
    expect(translator.outcome.turnCost).toBeCloseTo(0.4, 10);
    expect(translator.sessionCost).toBeCloseTo(1.4, 10);
  });

  it("adds a sub-agent's cost from its `complete`, beside the turns' own", () => {
    const translator = new TurnTranslator({ workspaceRoot: null });
    translator.translate(valid({ type: "sub_agent_status", subAgentId: "s", message: "spawned", description: "d" }));
    // The parent keeps working while a detached sub-agent runs: its own totals count.
    translator.translate(valid({ type: "usage_update", usage: {}, estimatedCost: 0.01 }));
    expect(translator.outcome.turnCost).toBeCloseTo(0.01, 10);
    translator.translate(valid({ type: "done", provider: "p", model: "m", usage: null, estimatedCost: 0.01, totalTime: 1 }));
    translator.translate(
      valid({ type: "sub_agent_status", subAgentId: "s", message: "complete", durationMilliseconds: 1, toolCount: 0, estimatedCost: 0.04 }),
    );
    translator.translate(valid({ type: "usage_update", usage: {}, estimatedCost: 0.02 }));
    translator.translate(valid({ type: "done", provider: "p", model: "m", usage: null, estimatedCost: 0.03, totalTime: 1 }));
    expect(translator.outcome.turnCost).toBeCloseTo(0.01 + 0.04 + 0.03, 10);
  });

  it("adds the turn's cost to what the session spent before", () => {
    const translator = new TurnTranslator({ workspaceRoot: null, costBeforeTurn: 1.25 });
    translator.translate(valid({ type: "usage_update", usage: {}, estimatedCost: 0.5 }));
    expect(translator.sessionCost).toBe(1.75);
  });
});

describe("TurnTranslator — tools", () => {
  it("shows a streaming tool's output tail, and its result when it finishes", () => {
    const tool = { id: "t1", name: "execute_shell", args: { command: "ls" } };
    const { updates } = run([
      valid({ type: "tool_execution", status: "calling", tool }),
      valid({ type: "tool_output", toolCallId: "t1", name: "execute_shell", event: "stdout", data: "a.txt\n" }),
      valid({ type: "tool_output", toolCallId: "t1", name: "execute_shell", event: "stdout", data: "b.txt\n" }),
      valid({ type: "tool_execution", status: "done", tool: { ...tool, result: { stdout: "a.txt\nb.txt\n", exitCode: 0 } } }),
    ]);
    expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", status: "pending" });
    const outputs = updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.content);
    expect(JSON.stringify(outputs[1])).toContain("a.txt\\nb.txt");
    expect(updates.at(-1)).toMatchObject({ status: "completed", rawOutput: { exitCode: 0 } });
  });

  it("keeps only the tail of a long output", () => {
    const translator = new TurnTranslator({ workspaceRoot: null });
    translator.translate(valid({ type: "tool_execution", status: "calling", tool: { id: "t", name: "run_command", args: {} } }));
    const chunk = "x".repeat(TOOL_OUTPUT_TAIL_CHARACTERS);
    translator.translate(valid({ type: "tool_output", toolCallId: "t", name: "run_command", event: "stdout", data: chunk }));
    const { updates } = translator.translate(
      valid({ type: "tool_output", toolCallId: "t", name: "run_command", event: "stdout", data: "END" }),
    );
    const text = JSON.stringify(updates[0]);
    expect(text).toContain("END");
    expect(text.length).toBeLessThan(TOOL_OUTPUT_TAIL_CHARACTERS + 200);
  });

  it("fails a call whose result is an error, and one the user denied", () => {
    const failed = run([
      valid({ type: "tool_execution", status: "calling", tool: { id: "a", name: "read_file", args: { path: "x" } } }),
      valid({ type: "tool_execution", status: "done", tool: { id: "a", name: "read_file", args: { path: "x" }, result: { error: "ENOENT" } } }),
    ]).updates.at(-1);
    expect(failed).toMatchObject({ status: "failed" });

    const denied = run([
      valid({ type: "tool_execution", status: "calling", tool: { id: "w", name: "write_file", args: { path: "x" } } }),
      valid({ type: "approval_decided", toolCallId: "w", batchId: "b", decision: "deny", scope: "call", source: "user", reason: "not now" }),
    ]).updates.at(-1);
    expect(denied).toMatchObject({ toolCallId: "w", status: "failed" });
    expect(JSON.stringify(denied)).toContain("not now");
  });

  it("renders a new file's approval preview as an ACP diff, and an edit's as a unified diff", () => {
    const newFile = run([
      valid({
        type: "approval_required",
        toolCallId: "n",
        batchId: "b",
        batchSize: 1,
        toolCall: { id: "n", name: "write_file", args: { path: "src/new.ts" } },
        preview: { kind: "diff", path: "src/new.ts", diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two", isNewFile: true },
      }),
    ]).interactions[0];
    if (newFile?.kind !== "approval") throw new Error("expected an approval");
    expect(newFile.toolCall.content).toEqual([{ type: "diff", path: "/work/src/new.ts", oldText: null, newText: "one\ntwo" }]);
    expect(newFile.toolCall.locations).toEqual([{ path: "/work/src/new.ts" }]);

    const edit = run([
      valid({
        type: "approval_required",
        toolCallId: "e",
        batchId: "b",
        batchSize: 1,
        toolCall: { id: "e", name: "edit_file", args: { path: "/abs/a.ts" } },
        preview: { kind: "diff", path: "/abs/a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
        protectedPath: ".git/config",
        alwaysAsks: true,
      }),
    ]).interactions[0];
    if (edit?.kind !== "approval") throw new Error("expected an approval");
    expect(JSON.stringify(edit.toolCall.content)).toContain("```diff");
    expect(JSON.stringify(edit.toolCall.content)).toContain("Protected path: .git/config");
  });

  it("tags a sub-agent's calls and approvals with the sub-agent, and tracks the sub-agent itself", () => {
    const { updates, interactions } = run([
      valid({ type: "sub_agent_status", subAgentId: "s1", message: "spawned", description: "Survey the repo", model: "m" }),
      valid({
        type: "sub_agent_tool_execution",
        subAgentId: "s1",
        subAgentDescription: "Survey the repo",
        status: "calling",
        tool: { id: "t", name: "list_directory", args: { path: "." } },
      }),
      valid({
        type: "approval_required",
        toolCallId: "t",
        batchId: "b",
        batchSize: 1,
        toolCall: { id: "t", name: "list_directory", args: { path: "." } },
        subAgentId: "s1",
        subAgentDescription: "Survey the repo",
        approvalConversationId: "sub-conv",
      }),
      valid({ type: "sub_agent_status", subAgentId: "s1", message: "complete", durationMilliseconds: 1500, toolCount: 1 }),
    ]);
    expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "sub-agent/s1", title: "Sub-agent: Survey the repo" });
    expect(updates[1]).toMatchObject({ toolCallId: "s1/t", title: "Survey the repo: list_directory", kind: "read" });
    expect(interactions[0]).toMatchObject({ kind: "approval", toolCall: { toolCallId: "s1/t" }, event: { approvalConversationId: "sub-conv" } });
    expect(updates.at(-1)).toMatchObject({ toolCallId: "sub-agent/s1", status: "completed" });
  });

  it("closes calls left open when the turn ends", () => {
    const { updates } = run([
      valid({ type: "tool_execution", status: "streaming", tool: { id: "x", name: "read_file", args: {} } }),
      valid({ type: "done", provider: "p", model: "m", usage: null, estimatedCost: null, totalTime: null }),
    ]);
    expect(updates.at(-1)).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed" });
  });

  it("shows provider-run code as an execute call", () => {
    const { updates } = run([
      valid({ type: "executableCode", code: "print(1)", language: "PYTHON" }),
      valid({ type: "codeExecutionResult", output: "1\n", outcome: "OUTCOME_OK" }),
    ]);
    expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", status: "in_progress" });
    expect(updates[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("links a grounded answer's sources once", () => {
    const sources = [{ url: "https://example.com/a", title: "A" }];
    const { updates } = run([
      valid({ type: "citations", sources, queries: ["q"] }),
      valid({ type: "webSearchResult", results: sources }),
    ]);
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com/a", name: "A" } },
    ]);
  });

  it.each([
    ["read_file", "read"],
    ["list_directory", "read"],
    ["write_file", "edit"],
    ["apply_patch", "edit"],
    ["delete_file", "delete"],
    ["move_file", "move"],
    ["search_file_contents", "search"],
    ["find_files", "search"],
    ["execute_shell", "execute"],
    ["run_git", "execute"],
    ["read_web_page", "fetch"],
    ["read_url", "fetch"],
    ["exit_plan_mode", "switch_mode"],
    ["todo_write", "think"],
    ["create_subagents", "other"],
  ])("kind of %s is %s", (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });

  it("makes locations absolute, and drops relative ones without a workspace", () => {
    expect(toolLocations({ path: "a/b.ts", paths: ["/c.ts"] }, "/repo")).toEqual([{ path: "/repo/a/b.ts" }, { path: "/c.ts" }]);
    expect(toolLocations({ path: "a/b.ts" }, null)).toEqual([]);
  });
});
