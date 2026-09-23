/**
 * UpdateTranslator — an external ACP agent's session updates as Prism
 * sub-agent events and a ReAct-shaped transcript (the reverse of
 * TurnTranslator). The pure half of the ACP client runtime; the process
 * half is acpClientRuntime.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { UpdateTranslator, type PrismEvent } from "../client/UpdateTranslator.ts";
import { validateTurnEvent } from "#src/protocol/events";

function translator() {
  const events: PrismEvent[] = [];
  let clock = 1_000;
  const instance = new UpdateTranslator({ emit: (event) => events.push(event), agentLabel: "Codex", now: () => (clock += 10) });
  return { instance, events };
}

function apply(instance: UpdateTranslator, ...updates: SessionUpdate[]) {
  for (const update of updates) instance.apply(update);
}

const say = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

describe("UpdateTranslator", () => {
  it("splits the transcript into steps the way a ReAct loop persists them — the report is the last", () => {
    const { instance, events } = translator();
    instance.beginPrompt("the task", { record: false });
    apply(
      instance,
      say("Let me look. "),
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "List files", kind: "search", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.ts\nb.ts" } }] },
      say("Two files. "),
      { sessionUpdate: "tool_call", toolCallId: "t2", title: "Read a.ts", kind: "read", status: "completed", rawOutput: { bytes: 12 } },
      say("Done: a.ts is 12 bytes."),
    );
    instance.endPrompt({ stopReason: "end_turn" });

    expect(instance.messages.map((message) => [message.role, message.content, message.toolCalls?.map((call) => call.id)])).toEqual([
      ["assistant", "Let me look. ", ["t1"]],
      ["assistant", "Two files. ", ["t2"]],
      ["assistant", "Done: a.ts is 12 bytes.", undefined],
    ]);
    expect(instance.messages[1].toolCalls![0]).toMatchObject({
      name: "Read a.ts",
      status: "done",
      result: { output: '{\n  "bytes": 12\n}' },
    });
    for (const event of events) expect(validateTurnEvent(event).success, JSON.stringify(event)).toBe(true);
  });

  it("streams a tool's growing output as deltas, and a replaced output whole", () => {
    const { instance, events } = translator();
    instance.beginPrompt("t", { record: false });
    const output = (text: string): SessionUpdate => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh",
      content: [{ type: "content", content: { type: "text", text } }],
    });
    apply(
      instance,
      { sessionUpdate: "tool_call", toolCallId: "sh", title: "npm test", kind: "execute", name: "Bash" },
      output("PASS a"),
      output("PASS a\nPASS b"),
      output("restarted"),
    );
    expect(events.filter((event) => event.type === "tool_output").map((event) => event.data)).toEqual([
      "PASS a",
      "\nPASS b",
      "\nrestarted",
    ]);
    // Its programmatic name is the tool's name; the title rides as its label.
    expect(events.find((event) => event.type === "tool_execution")).toMatchObject({
      tool: { name: "Bash" },
      toolLabel: "npm test",
    });
  });

  it("a failed call's result is an error; a call left open is closed when the prompt ends", () => {
    const { instance, events } = translator();
    instance.beginPrompt("t", { record: false });
    apply(
      instance,
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Delete tmp", kind: "delete" },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", content: [{ type: "content", content: { type: "text", text: "EACCES" } }] },
      { sessionUpdate: "tool_call", toolCallId: "y", title: "Fetch docs", kind: "fetch" },
    );
    instance.endPrompt({ stopReason: "cancelled" });
    const finished = events.filter((event) => event.type === "tool_execution" && event.status !== "calling");
    expect(finished.map((event) => [event.status, (event.tool as { result: unknown }).result])).toEqual([
      ["error", { error: "EACCES" }],
      ["error", { error: "Cancelled." }],
    ]);
  });

  it("links become Markdown, images become image events, echoes and command lists are not shown", () => {
    const { instance, events } = translator();
    instance.beginPrompt("t", { record: false });
    apply(
      instance,
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "the task again" } },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com/doc", name: "doc" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
    );
    expect(events.filter((event) => event.type !== "status")).toEqual([
      { type: "chunk", content: "[doc](https://example.com/doc)" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
  });

  it("a cost in another currency stays unknown — Prism counts dollars", () => {
    const { instance, events } = translator();
    apply(instance, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.5, currency: "EUR" } });
    expect(instance.costDollars).toBeNull();
    expect(events).toEqual([
      { type: "status", message: "Codex reports its cost in EUR; Prism counts dollars, so its cost stays unknown" },
    ]);
    apply(instance, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.25, currency: "usd" } });
    expect(instance.costDollars).toBe(0.25);
  });

  it("a plan is a todo_update, with unknown values coerced", () => {
    const { instance, events } = translator();
    apply(instance, {
      sessionUpdate: "plan",
      entries: [
        { content: "one", priority: "high", status: "completed" },
        { content: "two", priority: "urgent" as never, status: "blocked" as never },
      ],
    });
    expect(events).toEqual([
      {
        type: "todo_update",
        items: [
          { id: 1, content: "one", status: "completed", priority: "high" },
          { id: 2, content: "two", status: "pending", priority: "medium" },
        ],
        stats: { total: 2, pending: 1, in_progress: 0, completed: 1 },
      },
    ]);
  });

  it("stop reasons it cannot finish on are said in words", () => {
    const { instance, events } = translator();
    instance.beginPrompt("t", { record: false });
    instance.endPrompt({ stopReason: "max_turn_requests" });
    instance.beginPrompt("t2");
    instance.endPrompt({ stopReason: "refusal" });
    expect(events.filter((event) => event.type === "status" && event.message !== "iteration_progress").map((event) => event.message)).toEqual([
      "Codex stopped at its own limit of model requests for one turn",
      "Codex declined the request",
    ]);
    expect(instance.messages).toEqual([expect.objectContaining({ role: "user", content: "t2" })]);
  });
});
