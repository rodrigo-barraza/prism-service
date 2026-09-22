/**
 * Unit tests for the SGLang provider's pure request/response shaping.
 *
 * SGLang renders the served model's own chat template and fetches media URLs
 * itself, so the payload builder demotes non-leading system messages, keeps
 * media to data:/http(s): URLs, and sends audio as audio_url. Model discovery
 * merges /v1/models with /model_info (or an old server's /server_info).
 */
import { describe, it, expect } from "vitest";

import {
  adaptContentPartsForSglang,
  buildSglangPayload,
  demoteNonLeadingSystemMessages,
  isForwardableMediaUrl,
  mergeSglangModelMetadata,
} from "#src/providers/sglang";
import type { ChatMessage } from "#src/types/provider";
import type { ProviderOptions } from "#src/types/ProviderTypes";
import type {
  InputMessage,
  PreparedMessage,
} from "#src/providers/openai-compat";

const userMessage: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("demoteNonLeadingSystemMessages", () => {
  it("keeps a leading system message and demotes every later one to user", () => {
    const messages: InputMessage[] = [
      { role: "system", content: "identity" },
      { role: "system", content: "<system-context>now</system-context>" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "<tool-update>x</tool-update>" },
    ];
    expect(demoteNonLeadingSystemMessages(messages).map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("demotes a system message that is not first even when none leads", () => {
    const messages: InputMessage[] = [
      { role: "user", content: "hi" },
      { role: "system", content: "<plan-mode>blocked</plan-mode>" },
    ];
    const demoted = demoteNonLeadingSystemMessages(messages);
    expect(demoted[1]).toEqual({
      role: "user",
      content: "<plan-mode>blocked</plan-mode>",
    });
    expect(messages[1].role).toBe("system"); // input untouched
  });
});

describe("buildSglangPayload — messages", () => {
  it("puts the identity prompt first as the only system message", () => {
    const payload = buildSglangPayload(
      [
        { role: "user", content: "hi" },
        { role: "system", content: "<tool-update>new tools</tool-update>" },
      ],
      "Qwen/Qwen3.6-27B",
      { systemPrompt: "You are Prism." },
      false,
    );
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(messages[0].content).toBe("You are Prism.");
    expect(messages[2].content).toBe("<tool-update>new tools</tool-update>");
  });
});

describe("buildSglangPayload — sampling and streaming", () => {
  it("sends SGLang's sampling extensions and omits a neutral repetition penalty", () => {
    const payload = buildSglangPayload(
      userMessage,
      "m",
      { topK: 20, minP: 0.05, repeatPenalty: 1, temperature: 0.6 },
      false,
    );
    expect(payload.top_k).toBe(20);
    expect(payload.min_p).toBe(0.05);
    expect(payload.temperature).toBe(0.6);
    expect(payload).not.toHaveProperty("repetition_penalty");
    expect(
      buildSglangPayload(userMessage, "m", { repeatPenalty: 1.1 }, false)
        .repetition_penalty,
    ).toBe(1.1);
  });

  it("requests usage in the stream only when streaming", () => {
    expect(buildSglangPayload(userMessage, "m", {}, false).stream_options).toBeUndefined();
    const streaming = buildSglangPayload(userMessage, "m", {}, true);
    expect(streaming.stream).toBe(true);
    expect(streaming.stream_options).toEqual({ include_usage: true });
  });
});

describe("buildSglangPayload — tools and reasoning", () => {
  it("converts tools to OpenAI function format with auto tool_choice", () => {
    const options: ProviderOptions = {
      tools: [{ name: "get_weather", description: "Weather", parameters: { type: "object" } }],
    };
    const payload = buildSglangPayload(userMessage, "m", options, false);
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "Weather", parameters: { type: "object" } },
      },
    ]);
    expect(payload.tool_choice).toBe("auto");
  });

  it("sets the template's enable_thinking switch only when thinking is decided", () => {
    expect(buildSglangPayload(userMessage, "m", {}, false)).not.toHaveProperty(
      "chat_template_kwargs",
    );
    expect(
      buildSglangPayload(userMessage, "m", { thinkingEnabled: false }, false)
        .chat_template_kwargs,
    ).toEqual({ enable_thinking: false });
  });

  it("forwards reasoning_effort unless thinking is switched off", () => {
    expect(
      buildSglangPayload(userMessage, "m", { reasoningEffort: "low", thinkingEnabled: true }, false)
        .reasoning_effort,
    ).toBe("low");
    expect(
      buildSglangPayload(userMessage, "m", { reasoningEffort: "high", thinkingEnabled: false }, false),
    ).not.toHaveProperty("reasoning_effort");
  });
});

describe("media sent to SGLang", () => {
  it("forwards only data: and http(s): URLs", () => {
    expect(isForwardableMediaUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isForwardableMediaUrl("https://storage.example/a.png")).toBe(true);
    expect(isForwardableMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isForwardableMediaUrl("/root/.ssh/id_rsa")).toBe(false);
  });

  it("replaces a server-local media URL with a note and sends audio as audio_url", () => {
    const prepared: PreparedMessage[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "file:///etc/shadow" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "video_url", video_url: { url: "/var/secret.mp4" } },
          { type: "input_audio", input_audio: { data: "QUJD", format: "mpeg" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    const [message] = adaptContentPartsForSglang(prepared);
    expect(message.content).toEqual([
      { type: "text", text: expect.stringContaining("Attachment omitted") },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: expect.stringContaining("Attachment omitted") },
      { type: "audio_url", audio_url: { url: "data:audio/mpeg;base64,QUJD" } },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("adapts attachments the harness hands the builder", () => {
    const payload = buildSglangPayload(
      [{ role: "user", content: "listen", audio: ["data:audio/mpeg;base64,QUJD"] } as ChatMessage],
      "m",
      {},
      false,
    );
    const [message] = payload.messages as Array<{ content: Array<{ type: string }> }>;
    expect(message.content.map((part) => part.type)).toEqual(["audio_url", "text"]);
  });
});

describe("mergeSglangModelMetadata", () => {
  const baseCard = {
    id: "Qwen/Qwen3.6-27B",
    object: "model",
    owned_by: "sglang",
    root: "Qwen/Qwen3.6-27B",
    parent: null,
    max_model_len: 131072,
  };

  it("carries the context length and what /model_info reports", () => {
    const [model] = mergeSglangModelMetadata(
      { object: "list", data: [baseCard] },
      {
        model_path: "Qwen/Qwen3.6-27B",
        is_generation: true,
        tool_call_parser: "qwen25",
        reasoning_parser: "qwen3",
        has_image_understanding: true,
        has_audio_understanding: false,
      },
    );
    expect(model).toEqual({
      key: "Qwen/Qwen3.6-27B",
      display_name: "Qwen/Qwen3.6-27B",
      type: "llm",
      max_model_len: 131072,
      sglangCapabilities: {
        toolCallParser: "qwen25",
        reasoningParser: "qwen3",
        imageUnderstanding: true,
        audioUnderstanding: false,
      },
    });
  });

  it("records a server running without parsers as null, not unknown", () => {
    const [model] = mergeSglangModelMetadata(
      { data: [baseCard] },
      { is_generation: true, tool_call_parser: null, reasoning_parser: null },
    );
    expect(model.sglangCapabilities).toEqual({
      toolCallParser: null,
      reasoningParser: null,
    });
  });

  it("addresses a LoRA adapter as base:adapter with the base model's window", () => {
    const models = mergeSglangModelMetadata(
      {
        data: [
          baseCard,
          { id: "sql-lora", root: "/adapters/sql", parent: "Qwen/Qwen3.6-27B", max_model_len: null },
        ],
      },
      null,
    );
    expect(models[1]).toEqual({
      key: "Qwen/Qwen3.6-27B:sql-lora",
      display_name: "sql-lora (LoRA)",
      type: "llm",
      max_model_len: 131072,
    });
  });

  it("marks an embedding server's model as an embedding model", () => {
    const [model] = mergeSglangModelMetadata(
      { data: [{ ...baseCard, id: "Qwen/Qwen3-Embedding-4B" }] },
      { is_generation: false },
    );
    expect(model.type).toBe("embedding");
  });

  it("reads parsers from /server_info when an older /model_info lacks them", () => {
    const [model] = mergeSglangModelMetadata(
      { data: [baseCard] },
      { is_generation: true, has_image_understanding: false },
      { tool_call_parser: "hermes", reasoning_parser: null },
    );
    expect(model.sglangCapabilities).toEqual({
      toolCallParser: "hermes",
      reasoningParser: null,
      imageUnderstanding: false,
    });
  });

  it("reports nothing when the info endpoints did not answer", () => {
    const [model] = mergeSglangModelMetadata({ data: [baseCard] }, null, null);
    expect(model).not.toHaveProperty("sglangCapabilities");
  });
});
