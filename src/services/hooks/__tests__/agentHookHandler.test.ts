import { describe, it, expect, vi } from "vitest";

vi.mock("#src/services/RequestLogger", () => ({
  default: { logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined) },
}));

import runAgentHook, {
  buildAgentHookMessage,
} from "#src/services/hooks/handlers/AgentHookHandler";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type { HookPayload } from "#src/services/hooks/types";
import type { LLMProvider } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────
// The experimental `agent` handler: a verifier that sees the
// transcript, on the conversation's own model, parsed with the
// prompt hook's (fail-closed) contract.
// ────────────────────────────────────────────────────────────

function providerAnswering(text: string) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; model: string; options: Record<string, unknown> }> = [];
  const provider = {
    generateTextStream: vi.fn(async function* (
      messages: Array<{ role: string; content: string }>,
      model: string,
      options: Record<string, unknown>,
    ) {
      calls.push({ messages, model, options });
      yield text;
    }),
  } as unknown as LLMProvider;
  return { provider, calls };
}

const PAYLOAD: HookPayload = {
  hook_event_name: "Stop",
  session_id: "s",
  agent_conversation_id: "a",
  project: "p",
  username: "u",
  agent: null,
  cwd: null,
  last_assistant_message: "All done!",
};

const TRANSCRIPT = [
  { role: "user", content: "Fix the flaky test and run the suite." },
  { role: "assistant", content: "Fixed it.", tool_calls: ["write_file"] },
];

describe("AgentHookHandler", () => {
  it("shows the verifier the transcript, fenced, before the fenced payload", () => {
    const message = buildAgentHookMessage("Did the agent run the suite? $ARGUMENTS", '{"x":1}', TRANSCRIPT);
    expect(message.indexOf("<<<BEGIN_TRANSCRIPT>>>")).toBeLessThan(message.indexOf("<<<BEGIN_HOOK_PAYLOAD>>>"));
    expect(message).toContain("run the suite");
    expect(message).toContain('"tool_calls"');
    expect(buildAgentHookMessage("Q", "{}", [])).toContain("No transcript is available");
  });

  it("runs on the conversation's model with a verifier system prompt and returns its decision", async () => {
    const { provider, calls } = providerAnswering('{"decision":"block","reason":"The suite was never run."}');
    const result = await runAgentHook(
      { type: "agent", prompt: "Did the agent run the suite? $ARGUMENTS" },
      PAYLOAD,
      {
        payloadJson: JSON.stringify(PAYLOAD),
        event: HOOK_EVENTS.STOP,
        provider,
        providerName: "anthropic",
        model: "conversation-model",
        transcript: TRANSCRIPT,
      },
    );
    expect(result).toEqual({ decision: "block", reason: "The suite was never run." });
    expect(calls[0].model).toBe("conversation-model");
    expect(calls[0].messages[0]).toMatchObject({ role: "system" });
    expect(calls[0].messages[0].content).toContain("verifier");
    expect(calls[0].messages[1].content).toContain("Fix the flaky test");
    expect(calls[0].options).toMatchObject({ thinkingEnabled: true });
  });

  it("fails closed on an unreadable answer at a security gate", async () => {
    const { provider } = providerAnswering("I think it is probably fine.");
    const result = await runAgentHook(
      { type: "agent", prompt: "Is this call safe?" },
      { ...PAYLOAD, hook_event_name: "PreToolUse" },
      { payloadJson: "{}", event: HOOK_EVENTS.PRE_TOOL_USE, provider, model: "m" },
    );
    expect(result).toMatchObject({ permissionDecision: "deny" });
  });

  it("does not fail closed on Stop — a garbled verifier must not force continuations", async () => {
    const { provider } = providerAnswering("hmm");
    const result = await runAgentHook(
      { type: "agent", prompt: "Finished?" },
      PAYLOAD,
      { payloadJson: "{}", event: HOOK_EVENTS.STOP, provider, model: "m" },
    );
    expect(result).toMatchObject({ _handlerFailed: true });
    expect(result.decision).toBeUndefined();
  });
});
