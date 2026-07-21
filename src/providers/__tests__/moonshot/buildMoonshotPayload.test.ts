/**
 * Unit tests for the Moonshot (Kimi) provider payload builder.
 *
 * buildMoonshotPayload is pure — it converts harness messages + options into
 * an OpenAI-compatible Chat Completions payload. These tests lock in the
 * Kimi-specific behaviour: the 0.6 default temperature, streaming usage opt-in,
 * tool conversion, reasoning_effort passthrough, response_format normalization,
 * and identity system-prompt injection.
 */
import { describe, it, expect } from "vitest";

import { buildMoonshotPayload } from "#src/providers/moonshot";
import type { ChatMessage } from "#src/types/provider";
import type { ProviderOptions } from "#src/types/ProviderTypes";

const userMessage: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("buildMoonshotPayload — base payload", () => {
  it("sets the model and messages and defaults temperature to 0.6", () => {
    const payload = buildMoonshotPayload(userMessage, "kimi-k2.6", {}, false);
    expect(payload.model).toBe("kimi-k2.6");
    expect(payload.temperature).toBe(0.6);
    expect(Array.isArray(payload.messages)).toBe(true);
  });

  it("honours an explicit temperature override", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k2.6",
      { temperature: 0.1 },
      false,
    );
    expect(payload.temperature).toBe(0.1);
  });
});

describe("buildMoonshotPayload — streaming", () => {
  it("omits stream_options when not streaming", () => {
    const payload = buildMoonshotPayload(userMessage, "kimi-k3", {}, false);
    expect(payload.stream).toBe(false);
    expect(payload.stream_options).toBeUndefined();
  });

  it("requests usage in the stream when streaming", () => {
    const payload = buildMoonshotPayload(userMessage, "kimi-k3", {}, true);
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
  });
});

describe("buildMoonshotPayload — tools", () => {
  it("converts tools to OpenAI function format and enables auto tool_choice", () => {
    const options: ProviderOptions = {
      tools: [
        {
          name: "get_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const payload = buildMoonshotPayload(userMessage, "kimi-k3", options, false);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("omits tools entirely when none are provided", () => {
    const payload = buildMoonshotPayload(userMessage, "kimi-k3", {}, false);
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });
});

describe("buildMoonshotPayload — reasoning_effort", () => {
  it("passes reasoning_effort through when set", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k3",
      { reasoningEffort: "high" },
      false,
    );
    expect(payload.reasoning_effort).toBe("high");
  });

  it("drops a reasoning level the model does not declare (medium on K3)", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k3",
      { reasoningEffort: "medium" },
      false,
    );
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort for models without thinkingLevels (K2.6)", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k2.6",
      { reasoningEffort: "high" },
      false,
    );
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort when 'none' or unset", () => {
    expect(
      buildMoonshotPayload(userMessage, "kimi-k3", { reasoningEffort: "none" }, false)
        .reasoning_effort,
    ).toBeUndefined();
    expect(
      buildMoonshotPayload(userMessage, "kimi-k3", {}, false).reasoning_effort,
    ).toBeUndefined();
  });
});

describe("buildMoonshotPayload — response_format", () => {
  it("wraps a string response format into { type }", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k2.6",
      { responseFormat: "json_object" },
      false,
    );
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("passes an object response format through unchanged", () => {
    const rf = { type: "json_schema", json_schema: { name: "x", schema: {} } };
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k2.6",
      { responseFormat: rf },
      false,
    );
    expect(payload.response_format).toBe(rf);
  });
});

describe("buildMoonshotPayload — identity system prompt", () => {
  it("prepends the identity prompt as a leading system message", () => {
    const payload = buildMoonshotPayload(
      userMessage,
      "kimi-k2.6",
      { systemPrompt: "You are Kimi." },
      false,
    );
    const messages = payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "You are Kimi." });
    expect(messages[1].role).toBe("user");
  });

  it("does not inject a system message when no system prompt is given", () => {
    const payload = buildMoonshotPayload(userMessage, "kimi-k2.6", {}, false);
    const messages = payload.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });
});
