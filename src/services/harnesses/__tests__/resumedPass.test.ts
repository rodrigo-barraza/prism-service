/**
 * resumedPass.test.ts — prompt 13, Landing 2.
 *
 * What a restart left of each call of the interrupted pass decides what the
 * re-driven turn does with it: a finished call keeps its result, a
 * read-only call re-runs, anything that can have side effects is asked
 * about. And the pass itself is replayed as the chunks a provider would
 * have streamed — provider state first, then thinking, text, tool calls.
 */
import { describe, it, expect } from "vitest";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import {
  mayRerunAfterRestart,
  partitionResumedCalls,
  replayPassStream,
  stampResumedCalls,
} from "../lifecycle/ResumedPass.ts";
import type { StoredPass } from "#src/services/TurnRunStore";
import type { PassState, ToolCall } from "../types.ts";

const engine = new AutoApprovalEngine({ fullAuto: false });

describe("mayRerunAfterRestart", () => {
  it.each([
    ["read_file", true],
    ["list_directory", true],
    ["search_web", true],
    ["ask_user", true],
    ["wait_for_tasks", true],
    ["sleep", true], // flagged idempotent
    ["write_file", false],
    ["execute_command", false],
    ["create_subagent", false], // AUTO tier, but it spawns work
    ["save_memory", false], // AUTO tier, but it writes memory
    ["run_tool_program", false], // acts through other tools
    ["mcp__server__tool", false],
    ["some_unknown_tool", false],
  ])("%s → %s", (toolName, expected) => {
    expect(mayRerunAfterRestart(toolName, engine)).toBe(expected);
  });
});

function passWith(calls: ToolCall[]): PassState {
  return { pendingToolCalls: calls } as unknown as PassState;
}

describe("stampResumedCalls", () => {
  it("finished keeps its result; cut-off read re-runs; cut-off write is interrupted; unstarted is untouched", () => {
    const calls: ToolCall[] = [
      { id: "a", name: "write_file", args: {} },
      { id: "b", name: "read_file", args: {} },
      { id: "c", name: "write_file", args: {} },
      { id: "d", name: "write_file", args: {} },
      { id: "e", name: "read_file", args: {} },
    ];
    const stored = {
      calls: {
        "0": { status: "finished", startedAt: "", result: { ok: 1 }, durationMilliseconds: 7 },
        "1": { status: "running", startedAt: "" },
        "2": { status: "running", startedAt: "" },
        "4": { status: "finished", startedAt: "", resultOmitted: true },
      },
    } as unknown as StoredPass;
    stampResumedCalls(passWith(calls), stored, engine);

    expect(calls[0]._resumed).toEqual({ status: "finished", result: { ok: 1 }, durationMilliseconds: 7 });
    expect(calls[1]._resumed).toEqual({ status: "rerun" });
    expect(calls[2]._resumed).toEqual({ status: "interrupted" });
    expect(calls[3]._resumed).toBeUndefined();
    // A result too large to keep: treated as cut off (a read simply re-runs).
    expect(calls[4]._resumed).toEqual({ status: "rerun" });

    const { finished, remaining } = partitionResumedCalls(calls);
    expect(finished.map((call) => call.id)).toEqual(["a"]);
    expect(remaining.map((call) => call.id)).toEqual(["b", "c", "d", "e"]);
  });
});

describe("replayPassStream", () => {
  it("streams what the model said, in a provider's order", async () => {
    const stored: StoredPass = {
      iteration: 3,
      text: "Writing it now.",
      thinking: "The user wants a file.",
      thinkingSignature: "sig",
      thinkingBlocks: [{ type: "thinking", thinking: "The user wants a file.", signature: "sig" }] as never,
      providerResponseId: "resp_1",
      phase: "commentary",
      toolCalls: [
        { id: "call-1", name: "write_file", args: { path: "a" }, thoughtSignature: "ts" },
        { id: "call-2", name: "read_file", args: { path: "b" } },
      ],
      calls: {},
    };
    const chunks: unknown[] = [];
    for await (const chunk of replayPassStream(stored)) chunks.push(chunk);
    expect(chunks).toEqual([
      { type: "providerState", providerResponseId: "resp_1", phase: "commentary" },
      { type: "thinking", content: "The user wants a file." },
      { type: "thinking_block", block: stored.thinkingBlocks![0] },
      { type: "thinking_signature", signature: "sig" },
      "Writing it now.",
      { type: "toolCall", id: "call-1", name: "write_file", args: { path: "a" }, thoughtSignature: "ts" },
      { type: "toolCall", id: "call-2", name: "read_file", args: { path: "b" } },
    ]);
  });
});
