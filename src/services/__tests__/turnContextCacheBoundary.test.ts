/**
 * `turnContext` — the marker on the context the system-prompt assembler
 * places before this turn's user message. Everything before the first such
 * message is the prefix the next turn re-sends, and the Anthropic adapter
 * puts a cache breakpoint there (providers/anthropic.ts, breakpoint #3;
 * providers/__tests__/anthropic/turnCacheBoundary.test.ts). The marker has
 * to reach the adapter through the harness's whitelisting expansion, and
 * must never be persisted: a stored copy would mark an older turn's context
 * as this turn's boundary.
 */
import { describe, it, expect } from "vitest";

import { injectSystemPromptContext } from "#src/services/system-prompt/index";
import { sanitizeMessagesForPersistence } from "#src/services/harnesses/lifecycle/Finalizer";
import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import type { MessagePayload } from "#src/services/conversation/types";
import type { ChatMessage } from "#src/types/admin";

type Message = { role: string; content: string; [key: string]: unknown };

function injected(): Message[] {
  const messages: Message[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "now" },
  ];
  injectSystemPromptContext(messages, {
    platformContextMessage: "Discord channel #politics",
    selfContextMessage: "mood: fine",
    memoriesText: "<agent-memory>a fact</agent-memory>",
    localTimeText: "Friday, September 25, 2026 at 1:30:57 PM PDT",
  });
  return messages;
}

describe("turnContext", () => {
  it("marks each message the assembler injects before the user message, and nothing else", () => {
    const messages = injected();
    expect(messages.map((message) => [message.role, message.turnContext === true])).toEqual([
      ["user", false],
      ["assistant", false],
      ["system", true], // platform context
      ["system", true], // self context
      ["system", true], // time, memories
      ["user", false],
    ]);
  });

  it("survives the harness's expansion to the provider", () => {
    const expanded = expandMessagesForFunctionCall(injected() as unknown as ChatMessage[], {
      filterDeleted: false,
    });
    expect(expanded.filter((message) => message.turnContext === true)).toHaveLength(3);
  });

  it("is never persisted", () => {
    const persisted = sanitizeMessagesForPersistence(injected() as unknown as MessagePayload[]);
    expect(persisted.some((message) => "turnContext" in message)).toBe(false);
  });
});
