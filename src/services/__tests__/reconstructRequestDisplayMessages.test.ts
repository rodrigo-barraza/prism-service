/**
 * Request-log chat-preview reconstruction — regression tests (audit M2).
 *
 * This server-side helper replaces the deleted client copy in
 * prism-client/src/utils/messageHelpers.ts: it normalizes provider
 * wire-format messages persisted in requestPayload (snake_case `tool_calls`,
 * JSON-string `function.arguments`, `toolCallId` keying), appends the
 * canonical assistant message from responsePayload, and joins everything via
 * the shared prepareDisplayMessages. GET /requests/:id serves the result as
 * `displayMessages` + `displaySystemPrompt`.
 */
import { describe, it, expect } from "vitest";
import { reconstructRequestDisplayMessages } from "#src/services/ConversationService";

describe("reconstructRequestDisplayMessages", () => {
  it("returns null without requestPayload messages", () => {
    expect(reconstructRequestDisplayMessages({})).toBeNull();
    expect(
      reconstructRequestDisplayMessages({ requestPayload: { messages: [] } }),
    ).toBeNull();
    expect(
      reconstructRequestDisplayMessages({
        requestPayload: { messages: "not-an-array" },
      }),
    ).toBeNull();
  });

  it("normalizes snake_case tool_calls with function.name and JSON-string arguments", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [
          { role: "user", content: "call something" },
          {
            role: "assistant",
            content: "calling tool",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "fn-name", arguments: '{"param": 123}' },
              },
              {
                id: "call-2",
                function: { name: "broken", arguments: "{not json" },
              },
            ],
          },
        ],
      },
    });

    const assistant = result?.displayMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "fn-name",
      args: { param: 123 },
    });
    // Invalid JSON arguments fall back to empty object
    expect(assistant?.toolCalls?.[1].args).toEqual({});
  });

  it("merges tool-role results keyed by toolCallId into the assistant toolCalls", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "call-1", content: '{"temp": 25}' },
        ],
      },
    });

    expect(result).not.toBeNull();
    // Tool-role messages are filtered from display output
    expect(
      result!.displayMessages.every((message) => message.role !== "tool"),
    ).toBe(true);
    const assistant = result!.displayMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.toolCalls?.[0].result).toBe('{"temp": 25}');
  });

  it("appends the canonical assistant message from responsePayload", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [{ role: "user", content: "hello" }],
      },
      responsePayload: {
        text: "hi there",
        thinking: "the user greeted me",
        toolCalls: [{ id: "call-9", name: "search_web", args: { q: "x" } }],
        images: ["minio://uploads/generated.png"],
      },
      model: "test-model",
      provider: "test-provider",
    });

    const assistant = result?.displayMessages.at(-1);
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "hi there",
      thinking: "the user greeted me",
      model: "test-model",
      provider: "test-provider",
      images: ["minio://uploads/generated.png"],
    });
    expect(assistant?.toolCalls?.[0].name).toBe("search_web");
  });

  it("skips a responsePayload assistant with nothing displayable", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [{ role: "user", content: "hello" }],
      },
      responsePayload: { text: "" },
    });
    expect(result?.displayMessages).toHaveLength(1);
    expect(result?.displayMessages[0].role).toBe("user");
  });

  it("extracts the system prompt separately", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hello" },
        ],
      },
    });
    expect(result?.systemPrompt).toBe("You are terse.");
  });

  it("returns null when every message is filtered out", () => {
    const result = reconstructRequestDisplayMessages({
      requestPayload: {
        messages: [{ role: "assistant", content: "" }],
      },
    });
    expect(result).toBeNull();
  });
});
