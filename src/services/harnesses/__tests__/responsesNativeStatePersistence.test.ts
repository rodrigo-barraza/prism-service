/**
 * OpenAI Responses native state (phase, unpaired reasoning items,
 * response.id) must land on the persisted assistant message so the next
 * turn can replay it — for the final text message, for a final iteration
 * that produced no text (merged into the last assistant message), and for
 * the non-agentic single-shot path.
 */
import { describe, it, expect } from "vitest";
import { assembleMessagesToAppend } from "#src/services/harnesses/lifecycle/Finalizer";
import type { MessagePayload } from "#src/services/conversation/types";
import { providerNativeState } from "#src/services/harnesses/strategies/branchingCommon";
import type { PassState } from "#src/services/harnesses/types";

const nativeState = {
  phase: "final_answer" as const,
  reasoningItems: [{ id: "rs_final", summary: [], encrypted_content: "enc-final" }],
  providerResponseId: "resp_final",
};

describe("assembleMessagesToAppend — Responses native state", () => {
  it("stamps the final text message after a tool round", () => {
    const override: MessagePayload[] = [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "search", args: {} }],
        providerResponseId: "resp_tool_round",
      },
      { role: "tool", tool_call_id: "call_1", content: "{}" },
    ];
    const messages = assembleMessagesToAppend({
      overrideMessagesToAppend: override,
      text: "Found it.",
      ...nativeState,
    });
    const final = messages[messages.length - 1];
    expect(final.role).toBe("assistant");
    expect(final.content).toBe("Found it.");
    expect(final.phase).toBe("final_answer");
    expect(final.reasoningItems).toEqual(nativeState.reasoningItems);
    expect(final.providerResponseId).toBe("resp_final");
    // The intermediate tool round keeps its own response id
    expect(messages[1].providerResponseId).toBe("resp_tool_round");
  });

  it("merges into the last assistant message when the final iteration had no text", () => {
    const override: MessagePayload[] = [
      {
        role: "assistant",
        content: "All done in the tool round.",
        toolCalls: [{ id: "call_1", name: "search", args: {} }],
      },
    ];
    const messages = assembleMessagesToAppend({
      overrideMessagesToAppend: override,
      text: "",
      ...nativeState,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].phase).toBe("final_answer");
    expect(messages[0].providerResponseId).toBe("resp_final");
    expect(messages[0].reasoningItems).toEqual(nativeState.reasoningItems);
  });

  it("stamps the single-shot (non-agentic) assistant message", () => {
    const messages = assembleMessagesToAppend({
      text: "Plain answer.",
      phase: "commentary",
      providerResponseId: "resp_single",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Plain answer.",
      phase: "commentary",
      providerResponseId: "resp_single",
    });
    expect("reasoningItems" in messages[0]).toBe(false);
  });

  it("adds nothing when the provider produced no native state", () => {
    const messages = assembleMessagesToAppend({ text: "Plain answer." });
    expect("phase" in messages[0]).toBe(false);
    expect("reasoningItems" in messages[0]).toBe(false);
    expect("providerResponseId" in messages[0]).toBe(false);
  });
});

describe("providerNativeState(pass)", () => {
  const basePass = {
    streamedText: "",
    finalStreamedText: "",
    streamedThinking: "",
    thinkingSignature: "",
    pendingToolCalls: [],
    streamedImages: [],
    start: 0,
    firstTokenTime: null,
    generationEnd: null,
    thinkingStartTime: null,
    thinkingEndTime: null,
    outputCharacters: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    options: {},
    requestId: null,
    pendingRequestDocumentIdPromise: Promise.resolve(null),
  } as unknown as PassState;

  it("spreads only the fields the pass produced", () => {
    expect(providerNativeState(basePass)).toEqual({});
    expect(
      providerNativeState({ ...basePass, phase: null, providerResponseId: "resp_x" }),
    ).toEqual({ phase: null, providerResponseId: "resp_x" });
    expect(providerNativeState({ ...basePass, reasoningItems: [] })).toEqual({});
    expect(
      providerNativeState({
        ...basePass,
        reasoningItems: [{ id: "rs", summary: [] }],
      }),
    ).toEqual({ reasoningItems: [{ id: "rs", summary: [] }] });
  });
});
