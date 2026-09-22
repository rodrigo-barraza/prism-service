/**
 * Anthropic thinking blocks must land on the persisted assistant message
 * verbatim and in order, and survive the history expansion that feeds the
 * next turn — a merged or trimmed block is a tampered signature (always a
 * 400 on Claude 4.7+), and a dropped one breaks preserved thinking.
 */
import { describe, it, expect } from "vitest";
import { assembleMessagesToAppend } from "#src/services/harnesses/lifecycle/Finalizer";
import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import type { MessagePayload } from "#src/services/conversation/types";

const blockA = { type: "thinking", thinking: "  keep my spaces ", signature: "sig-A" };
const blockB = { type: "redacted_thinking", data: "opaque" };

describe("thinking blocks — persistence", () => {
  it("the final text message carries the final pass's blocks", () => {
    const messages = assembleMessagesToAppend({
      overrideMessagesToAppend: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "search", args: {} }],
          thinkingBlocks: [{ type: "thinking", thinking: "tool round", signature: "sig-0" }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "{}" },
      ] as MessagePayload[],
      text: "Answer.",
      thinking: "tool round  keep my spaces",
      thinkingBlocks: [blockA, blockB],
    } as any);
    const final = messages[messages.length - 1];
    expect(final.content).toBe("Answer.");
    expect(final.thinkingBlocks).toStrictEqual([blockA, blockB]);
    // The tool round keeps its own block
    expect(messages[1].thinkingBlocks).toStrictEqual([
      { type: "thinking", thinking: "tool round", signature: "sig-0" },
    ]);
  });

  it("the single-shot message carries its blocks", () => {
    const messages = assembleMessagesToAppend({ text: "Plain.", thinkingBlocks: [blockA] } as any);
    expect(messages[0].thinkingBlocks).toStrictEqual([blockA]);
  });

  it("history expansion keeps blocks on tool-call and plain assistant messages", () => {
    const expanded = expandMessagesForFunctionCall([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        thinkingBlocks: [blockA],
        toolCalls: [{ id: "toolu_1", name: "search", args: {}, result: { ok: true } }],
      },
      { role: "assistant", content: "Done.", thinkingBlocks: [blockB] },
    ] as any);
    const toolRound = expanded.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const plain = expanded.find((message) => message.role === "assistant" && message.content === "Done.");
    expect((toolRound as any).thinkingBlocks).toStrictEqual([blockA]);
    expect((plain as any).thinkingBlocks).toStrictEqual([blockB]);
  });
});
